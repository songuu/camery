import type { SourceList, SourcePage, SourceSummary } from '@camery/ingest/contracts';
export type UploadFormat = 'novel' | 'docx' | 'fountain' | 'csv' | 'tsv';
export interface WorkbenchProps {
  readonly connected: boolean;
  readonly projectId: string;
  readonly projects: readonly { id: string; canImport: boolean }[];
  readonly sources: SourceList | null;
  readonly page: SourcePage | null;
  readonly format: UploadFormat;
  readonly busy: string | null;
  readonly progress: number | null;
  readonly error: string | null;
  readonly message: string | null;
  readonly canImport: boolean;
  readonly onConnect: (token: string) => void;
  readonly onDisconnect: () => void;
  readonly onProject: (id: string) => void;
  readonly onFormat: (format: UploadFormat) => void;
  readonly onFile: (file: File, append: boolean) => void;
  readonly onOpen: (source: SourceSummary) => void;
  readonly onRead: (offset: number) => void;
  readonly onPrevious: () => void;
  readonly onCheckpoint: () => void;
  readonly onMore: () => void;
}
