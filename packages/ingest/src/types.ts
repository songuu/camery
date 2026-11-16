export type ImportFormat = 'novel' | 'fountain' | 'csv' | 'tsv' | 'docx';
export type ImportUnitKind = 'frontmatter' | 'chapter' | 'scene' | 'action' | 'character' | 'dialogue' | 'parenthetical' | 'transition' | 'note' | 'lyric' | 'section' | 'synopsis' | 'title' | 'unknown';
export interface ImportUnit {
  readonly ordinal: number;
  readonly kind: ImportUnitKind;
  readonly title: string;
  readonly start: number;
  readonly end: number;
  readonly speaker: string | null;
  readonly fields?: Readonly<Record<string, string>>;
}
export interface ImportedDocument {
  readonly format: ImportFormat;
  readonly text: string;
  /** UTF-8 SHA-256 of text; offsets refer to this exact text, never the ZIP container. */
  readonly sourceDigest: string;
  /** Original bytes before DOCX extraction; identical to sourceDigest for text formats. */
  readonly originalDigest: string;
  readonly offsetUnit: 'utf16';
  readonly units: readonly ImportUnit[];
  readonly warnings: readonly string[];
}
export class ImportError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'INPUT_LIMIT' | 'UNSUPPORTED_FORMAT' | 'MALFORMED_DOCUMENT' | 'CONFLICT' | 'NOT_FOUND' | 'STORAGE_FAILED', readonly operation: string) {
    super(`Import ${operation} failed (${code})`); this.name = 'ImportError';
  }
}
