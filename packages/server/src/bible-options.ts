import type { BibleStore, BibleExecution } from '@camery/bible/node';
export type { BibleCatalogReader,BibleRunMetadata } from '@camery/bible/node';
import type { BibleCatalogReader } from '@camery/bible/node';
import type { MethodPin } from '@camery/methods';
import type { DurableStore } from '@camery/durable';
export interface BiblePreset {readonly method:MethodPin;readonly execution:BibleExecution;readonly label:string}
export interface BibleApiOptions {
  readonly store:BibleStore;readonly catalog:BibleCatalogReader;readonly tasks:Pick<DurableStore,'enqueue'|'get'>;
  /** Host deployment data, never a provider URL, credential, model pin or approval supplied by a request. */
  readonly presetFor:(projectId:string)=>BiblePreset|null;
  readonly now?:()=>string;
}
