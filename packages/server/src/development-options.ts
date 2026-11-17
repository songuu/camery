import type { DevelopmentCatalogReader,DevelopmentBriefCatalogReader,DevelopmentStore,DevelopmentExecution } from '@camery/script/node';
import type { MethodPin } from '@camery/methods';
import type { DurableStore } from '@camery/durable';
export interface DevelopmentPreset {readonly methods:{readonly foundation:MethodPin;readonly episodes:MethodPin};readonly execution:DevelopmentExecution;readonly label:string}
export interface DevelopmentApiOptions {
  readonly store:DevelopmentStore;readonly catalog:DevelopmentCatalogReader;readonly briefs:DevelopmentBriefCatalogReader;readonly tasks:Pick<DurableStore,'enqueue'|'get'>;
  /** Deployment authority only; neither credentials nor model identities come from HTTP. */
  readonly presetFor:(projectId:string)=>DevelopmentPreset|null;readonly now?:()=>string;
}
