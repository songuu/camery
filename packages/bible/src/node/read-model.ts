import type { Task } from '@camery/durable';
import { createSourcePage } from '@camery/ingest';
import type { SourcePage } from '@camery/ingest';
import { BibleError } from '../contracts.js';
import { BibleRunSummarySchema, BibleRunViewSchema, BibleStatusSchema, BibleTaskViewSchema } from '../http.js';
import type { BibleRunSummary, BibleRunView, BibleStatus } from '../http.js';
import { freeze, snapshotJson } from '../data.js';
import type { BibleProgress } from './contracts.js';

/** Task internals and arbitrary provider/driver messages never become user-facing diagnostics. */
export function projectBibleStatus(summary:BibleRunSummary,task:Task|null):BibleStatus {
  try {
    const base=BibleRunSummarySchema.parse({runId:summary.runId,createdAt:summary.createdAt,source:summary.source,completedChunks:summary.completedChunks,totalChunks:summary.totalChunks,
      candidateDigest:summary.candidateDigest,reviewStatus:summary.reviewStatus,sourceChanged:summary.sourceChanged});
    const raw=task?.output;const output=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:null;
    const resultState=output?.['state']==='candidate'||output?.['state']==='blocked'?output['state']:null;
    const reason=typeof output?.['reason']==='string'&&/^[A-Z_]{1,64}$(?![\s\S])/.test(output['reason'])?output['reason']:null;
    const taskView=task?BibleTaskViewSchema.parse({status:task.status,resultState,reason}):null;
    const state: BibleStatus['state']=base.reviewStatus??(taskView?.status==='reconciling'?'reconciling':base.sourceChanged?'stale':base.candidateDigest?'ready':taskView?.resultState==='blocked'?'blocked':
      taskView&&taskView.status!=='succeeded'?taskView.status:'queued');
    return freeze(BibleStatusSchema.parse({...base,state,task:taskView}));
  }catch{throw new BibleError('STORAGE_FAILED','status projection');}
}
/** Input must already have been rebuilt by BibleStore.read; a saved JSON digest alone is insufficient. */
export function projectBibleRun(progress:BibleProgress,current:boolean,task:Task|null):BibleRunView {
  try {
    const {run,candidate,review}=progress;const {tenantId:_tenant,projectId:_project,...source}=run.source.source;
    const status=projectBibleStatus({runId:run.runId,createdAt:run.createdAt,source,completedChunks:progress.records.length,totalChunks:run.plan.chunks.length,
      candidateDigest:candidate?.digest??null,reviewStatus:review?.status??null,sourceChanged:!current},task);
    const view={...status,current,candidate:candidate?{digest:candidate.digest,entities:candidate.entities,relations:candidate.relations,claims:candidate.claims,mergeSuggestions:candidate.mergeSuggestions}:null,
      review:review?{status:review.status,digest:review.digest,actorId:review.actorId,at:review.at,decision:review.status==='confirmed'?review.decision:null,reason:review.status==='rejected'?review.reason:null}:null,
      budget:{currency:run.execution.currency,tokens:run.execution.limits.tokens,costMicros:run.execution.limits.costMicros}};
    return freeze(BibleRunViewSchema.parse(snapshotJson(view)));
  }catch(error){if(error instanceof BibleError&&error.code==='INPUT_LIMIT')throw error;throw new BibleError('STORAGE_FAILED','run projection');}
}
/** Citations always resolve against the extraction's immutable source, even after the live document changes. */
export function createBibleSourcePage(progress:BibleProgress,query:unknown={}):SourcePage {
  const {run}=progress;const {source,document}=run.source;
  return createSourcePage({documentId:source.documentId,title:'提取时原文',kind:source.kind,revision:source.revision,document,checkpoint:null},query);
}
