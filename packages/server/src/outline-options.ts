import type { DurableStore } from '@camery/durable';
import type { OutlineStore,OutlineExecution,OutlineCatalogReader,OutlineBriefCatalogReader,OutlineSourceCatalogReader } from '@camery/script/outline/node';
export interface OutlinePreset {readonly execution:OutlineExecution;readonly label:string}
export interface OutlineApiOptions {
  readonly store:OutlineStore;readonly catalog:OutlineCatalogReader;readonly briefs:OutlineBriefCatalogReader;readonly sources:OutlineSourceCatalogReader;
  readonly tasks:Pick<DurableStore,'enqueue'|'get'>;
  /** Trusted deployment capability; HTTP never supplies a model profile or credentials. */
  readonly presetFor:(projectId:string)=>OutlinePreset|null;readonly now?:()=>string;
}
