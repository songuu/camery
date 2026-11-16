import { crc32 } from 'node:zlib';
import { fromBuffer } from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import { SaxesParser } from 'saxes';
import type { SaxesTagNS } from 'saxes';
import { createProjectionBudget, freeze, textDigest } from '../data.js';
import { ImportError } from '../types.js';
import type { ImportedDocument, ImportUnitKind } from '../types.js';
import { importFountain } from '../screenplay.js';

const WORD_NAMESPACES = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const CONTENT_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const WORD_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const MAX_XML_BYTES = 16_000_000;

function malformed(): ImportError { return new ImportError('MALFORMED_DOCUMENT', 'docx'); }
function xmlText(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw malformed(); }
}
function readXml(bytes: Uint8Array, opened: (tag: SaxesTagNS, depth: number) => void, closed: (tag: SaxesTagNS, depth: number) => void, text: (value: string) => void): void {
  const parser = new SaxesParser({ xmlns: true }); let depth = 0;
  parser.on('doctype', () => { throw malformed(); });
  parser.on('error', () => { throw malformed(); });
  parser.on('opentag', tag => { if (++depth > 128) throw new ImportError('INPUT_LIMIT', 'docx XML depth'); opened(tag, depth); });
  parser.on('closetag', tag => { closed(tag, depth); depth--; });
  parser.on('text', text); parser.on('cdata', text);
  try { parser.write(xmlText(bytes)).close(); } catch (error) { if (error instanceof ImportError) throw error; throw malformed(); }
}
function supportedContentType(bytes: Uint8Array): boolean {
  let supported = false;
  readXml(bytes, tag => {
    if (tag.uri !== CONTENT_NAMESPACE || tag.local !== 'Override') return;
    const values = Object.fromEntries(Object.values(tag.attributes).map(attribute => [attribute.local, attribute.value]));
    if (values['PartName'] === '/word/document.xml' && values['ContentType'] === WORD_CONTENT_TYPE) supported = true;
  }, () => {}, () => {});
  return supported;
}

function streamEntry(zip: ZipFile, entry: Entry, max: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) { reject(malformed()); return; }
      const chunks: Buffer[] = []; let count = 0; let checksum = 0;
      stream.on('data', (chunk: Buffer) => {
        count += chunk.length;
        if (count > max) { stream.destroy(new ImportError('INPUT_LIMIT', 'docx entry')); return; }
        checksum = crc32(chunk, checksum); chunks.push(chunk);
      });
      stream.on('error', error => reject(error instanceof ImportError ? error : malformed()));
      stream.on('end', () => {
        if (count !== entry.uncompressedSize || checksum !== entry.crc32 >>> 0) { reject(malformed()); return; }
        resolve(Buffer.concat(chunks, count));
      });
    });
  });
}
function selectedParts(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    fromBuffer(Buffer.from(bytes), { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(malformed()); return; }
      const selected = new Map<string, Uint8Array>(); const names = new Set<string>(); let totalSize = 0; let count = 0; let ended = false;
      const fail = (error: unknown) => { if (!ended) { ended = true; zip.close(); reject(error instanceof ImportError ? error : malformed()); } };
      zip.on('error', fail);
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          if (++count > 2048 || (totalSize += entry.uncompressedSize) > 32_000_000) throw new ImportError('INPUT_LIMIT', 'docx archive');
          if (names.has(entry.fileName) || entry.isEncrypted()) throw malformed();
          names.add(entry.fileName);
          if (/(?:^|\/)vbaProject\.bin$/i.test(entry.fileName)) throw new ImportError('UNSUPPORTED_FORMAT', 'docx macros');
          const max = entry.fileName === 'word/document.xml' ? MAX_XML_BYTES : entry.fileName === '[Content_Types].xml' ? 250_000 : 0;
          if (max) {
            if (entry.uncompressedSize > max) throw new ImportError('INPUT_LIMIT', 'docx entry');
            selected.set(entry.fileName, await streamEntry(zip, entry, max));
          }
          if (!ended) zip.readEntry();
        })().catch(fail);
      });
      zip.on('end', () => { if (!ended) { ended = true; zip.close(); resolve(selected); } });
      zip.readEntry();
    });
  });
}

interface Paragraph { start: number; end: number; style: string }
function extractBody(bytes: Uint8Array): { text: string; paragraphs: Paragraph[] } {
  let documentRoot = false; let bodySeen = false; let inBody = false; let inText = false; let paragraph: { start: number; style: string } | null = null;
  let text = ''; const paragraphs: Paragraph[] = [];
  readXml(bytes, (tag, depth) => {
    const word = WORD_NAMESPACES.has(tag.uri);
    if (depth === 1) { if (!word || tag.local !== 'document') throw malformed(); documentRoot = true; }
    if (!word) return;
    if (tag.local === 'body') { if (depth !== 2 || bodySeen) throw malformed(); bodySeen = true; inBody = true; }
    if (!inBody) return;
    if (['del', 'ins', 'moveFrom', 'moveTo', 'altChunk'].includes(tag.local)) throw new ImportError('UNSUPPORTED_FORMAT', 'docx tracked or linked content');
    if (tag.local === 'p') {
      if (paragraph !== null) throw malformed();
      // Empty OOXML paragraphs compress extremely well; bound objects before constructing the list.
      if (paragraphs.length >= 100_000) throw new ImportError('INPUT_LIMIT', 'docx paragraphs');
      paragraph = { start: text.length, style: '' };
    }
    if (tag.local === 'pStyle' && paragraph !== null) {
      const attribute = Object.values(tag.attributes).find(attribute => WORD_NAMESPACES.has(attribute.uri) && attribute.local === 'val');
      paragraph.style = attribute?.value ?? '';
    }
    if (tag.local === 't' && paragraph !== null) inText = true;
    if (paragraph !== null && ['br', 'cr', 'tab'].includes(tag.local)) text += tag.local === 'tab' ? '\t' : '\n';
  }, tag => {
    if (!WORD_NAMESPACES.has(tag.uri)) return;
    if (tag.local === 't') inText = false;
    if (tag.local === 'p' && paragraph !== null) { text += '\n'; paragraphs.push({ ...paragraph, end: text.length }); paragraph = null; }
    if (tag.local === 'body') inBody = false;
  }, value => { if (inBody && inText) text += value; });
  if (!documentRoot || !bodySeen || !text.trim()) throw malformed();
  return { text, paragraphs };
}
const styleKinds: Readonly<Record<string, ImportUnitKind>> = Object.freeze({ sceneheading: 'scene', character: 'character', dialogue: 'dialogue', parenthetical: 'parenthetical', transition: 'transition', action: 'action' });

/** DOCX body-only extraction: no legacy DOC, macros, field evaluation, external relationships or implicit tracked-change acceptance. */
export async function importDocx(bytes: Uint8Array): Promise<ImportedDocument> {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new ImportError('INVALID_INPUT', 'docx bytes');
  if (bytes.length > 8_000_000) throw new ImportError('INPUT_LIMIT', 'docx compressed bytes');
  // Parsing awaits I/O callbacks; callers still own and may mutate the supplied byte buffer.
  const captured = Uint8Array.from(bytes);
  try {
    const parts = await selectedParts(captured); const contentTypes = parts.get('[Content_Types].xml'); const body = parts.get('word/document.xml');
    if (!contentTypes || !body || !supportedContentType(contentTypes)) throw malformed();
    const extracted = extractBody(body); const parsed = importFountain(extracted.text); let speaker: string | null = null; let paragraphIndex = 0;
    // Many line breaks can share one paragraph. Normalize its potentially large style/title once,
    // rather than multiplying that scan by the number of projected Fountain units.
    const paragraphs = extracted.paragraphs.map(paragraph => {
      const style = paragraph.style.replace(/[-_ ]/g, '').toLowerCase();
      const title = extracted.text.slice(paragraph.start, paragraph.end).trim();
      return { ...paragraph, kind: Object.hasOwn(styleKinds, style) ? styleKinds[style]! : null, title, speaker: title.startsWith('@') ? title.slice(1) : title };
    });
    const guardProjection = createProjectionBudget();
    const units = parsed.units.map(unit => {
      while (paragraphIndex + 1 < paragraphs.length && unit.start >= paragraphs[paragraphIndex]!.end) paragraphIndex++;
      const paragraph = paragraphs[paragraphIndex]!; const styled = paragraph.kind !== null;
      let kind = paragraph.kind ?? unit.kind;
      if (!styled && speaker === null && ['dialogue', 'parenthetical'].includes(kind)) kind = 'action';
      if (kind === 'character') speaker = paragraph.speaker;
      else if (!['dialogue', 'parenthetical'].includes(kind)) speaker = null;
      return guardProjection({ ...unit, kind, title: kind === 'scene' || kind === 'character' ? paragraph.title : unit.title,
        speaker: kind === 'character' || kind === 'dialogue' || kind === 'parenthetical' ? speaker : null,
        ...(paragraph.style ? { fields: { wordStyle: paragraph.style } } : {}) });
    });
    const warnings = ['DOCX_TEXT_EXTRACTION', 'DOCX_NON_BODY_CONTENT_NOT_IMPORTED', ...parsed.warnings.filter(warning => warning !== 'NO_SCENES' || !units.some(unit => unit.kind === 'scene'))];
    return freeze({ ...parsed, format: 'docx', originalDigest: textDigest(captured), units, warnings });
  } catch (error) { if (error instanceof ImportError) throw error; throw malformed(); }
}
