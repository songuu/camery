import { recognizeChapterHeading } from '@camery/methods';
import { freeze, textDigest, validateText } from './data.js';
import { ImportError } from './types.js';
import type { ImportedDocument, ImportUnit } from './types.js';

/** Reparse cumulative source so a batch boundary inside a heading never becomes a permanent chapter boundary. */
export function importNovel(input: unknown): ImportedDocument {
  validateText(input, 'novel source');
  const headings: { start: number; title: string }[] = [];
  for (const line of input.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    const title = recognizeChapterHeading(line[0].replace(/[\r\n]+$/, ''));
    if (title !== null) {
      if (headings.length >= 10000) throw new ImportError('INPUT_LIMIT', 'novel chapters');
      headings.push({ start: line.index, title });
    }
  }
  const entries = headings.length === 0 ? [{ start: 0, title: '' }]
    : headings[0]!.start > 0 ? [{ start: 0, title: '' }, ...headings] : headings;
  if (entries.length > 10000) throw new ImportError('INPUT_LIMIT', 'novel chapters');
  const digest = textDigest(input);
  return freeze<ImportedDocument>({
    format: 'novel', text: input, sourceDigest: digest, originalDigest: digest, offsetUnit: 'utf16',
    units: entries.map<ImportUnit>((entry, index) => ({
      ordinal: index, kind: entry.title ? 'chapter' : 'frontmatter', title: entry.title,
      start: entry.start, end: entries[index + 1]?.start ?? input.length, speaker: null,
    })),
    warnings: headings.length ? [] : ['NO_EXPLICIT_HEADINGS'],
  });
}
