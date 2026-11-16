import { crc32, deflateRawSync } from 'node:zlib';

export const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
export const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${mime}"/></Types>`;
export function document(body: string) { return `<w:document xmlns:w="${ns}"><w:body>${body}</w:body></w:document>`; }
export interface ZipEntry { name: string; text: string; raw?: Uint8Array; advertisedSize?: number; flags?: number; badCrc?: boolean }
/** Small original ZIP fixture writer; production extraction uses yauzl, never this helper. */
export function zip(entries: ZipEntry[]): Uint8Array {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const raw = e.raw ? Buffer.from(e.raw) : Buffer.from(e.text); const packed = deflateRawSync(raw); const name = Buffer.from(e.name); const sum = e.badCrc ? 0 : crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(e.flags ?? 0, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(sum, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(e.advertisedSize ?? raw.length, 22); local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(e.flags ?? 0, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(sum, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(e.advertisedSize ?? raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(local, name, packed); central.push(c, name); offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export function docx(body: string, extra: ZipEntry[] = []) { return zip([{ name: '[Content_Types].xml', text: contentTypes }, { name: 'word/document.xml', text: document(body) }, ...extra]); }
