import { z } from 'zod';
import { SourceListSchema, SourcePageSchema, AppendReceiptSchema, ScriptReceiptSchema } from '@camery/ingest/contracts';
import type { SourceKind } from '@camery/ingest/contracts';
import type { UploadFormat } from './view-types.js';
import { BibleCapabilitiesSchema, BibleRunListSchema, BibleStatusSchema, BibleRunViewSchema, BibleStartSchema, BibleConfirmSchema, BibleRejectSchema, boundedBibleSchema } from '@camery/bible/http';
import type { BibleStart, BibleConfirm } from '@camery/bible/http';
import {DevelopmentCapabilitiesSchema,DevelopmentBriefListSchema,DevelopmentBriefViewSchema,DevelopmentBriefWriteSchema,DevelopmentRunListSchema,DevelopmentStatusSchema,DevelopmentRunViewSchema,DevelopmentStartSchema,DevelopmentFoundationConfirmSchema,DevelopmentEpisodesConfirmSchema,DevelopmentRejectSchema,DevelopmentRedoSchema,DevelopmentRedoOptionsSchema,boundedDevelopmentSchema} from '@camery/script/http';
import type {DevelopmentBriefWrite,DevelopmentStart,DevelopmentFoundationConfirm,DevelopmentEpisodesConfirm,DevelopmentRedo} from '@camery/script/http';
import {OutlineCapabilitiesSchema,OutlineBriefListQuerySchema,OutlineBriefListSchema,OutlineReadBriefQuerySchema,OutlineBriefViewSchema,OutlineBriefWriteSchema,OutlineSourceListQuerySchema,OutlineSourceListSchema,OutlineListQuerySchema,OutlineRunListSchema,OutlineStatusSchema,OutlineRunViewSchema,OutlineStartSchema,OutlineConfirmSchema,OutlineRejectSchema,boundedOutlineSchema} from '@camery/script/outline/http';
import type {OutlineBriefWrite,OutlineStart,OutlineConfirm} from '@camery/script/outline/http';
import {OutlinePrepareCommandSchema,OutlineAdoptCommandSchema,OutlineRejectCommandSchema,OutlineCandidateSchema,OutlineCandidateListQuerySchema,OutlineCandidatePageSchema,OutlineReceiptSchema,OutlineReceiptQuerySchema,OutlineReceiptPageSchema,OutlineUpgradeCandidateSchema} from '@camery/ir/outline-adoption';
import type {OutlinePrepareCommand,OutlineAdoptCommand,OutlineRejectCommand,OutlineCandidateListQuery,OutlineReceiptQuery} from '@camery/ir/outline-adoption';
import {OutlineFormalCollectionSchema,OutlineFormalRefSchema,OutlineFormalListQuerySchema,OutlineFormalObjectQuerySchema,OutlineFormalSectionQuerySchema,OutlineFormalListSchema,OutlineFormalRowsSchema,OutlineFormalObjectSchema,OutlineFormalSectionPageSchema,OUTLINE_FORMAL_SECTIONS} from '@camery/ir/outline-formal';
import type {OutlineFormalCollection,OutlineFormalRef,OutlineFormalListQuery,OutlineFormalObjectQuery,OutlineFormalSectionQuery} from '@camery/ir/outline-formal';
import {WorkbenchStateSchema,WorkbenchCandidatePageSchema,WorkbenchCandidateDetailSchema,WorkbenchActionReceiptSchema,WorkbenchCandidateListQuerySchema,DevelopmentCandidatePrepareSchema,WorkbenchUpgradeSchema,WorkbenchAdoptSchema,WorkbenchRejectSchema,workbenchEnvelope} from '@camery/ir/workbench';
import type {DevelopmentCandidatePrepare,WorkbenchUpgradeInput,WorkbenchAdoptInput,WorkbenchRejectInput} from '@camery/ir/workbench';
import {WorkbenchSnapshotSchema,WorkbenchReadQuerySchema,WorkbenchCollectionSchema,WorkbenchObjectRefSchema,WorkbenchObjectHistorySchema,WorkbenchHistoryQuerySchema,WorkbenchReadyAssetQuerySchema} from '@camery/ir/workbench';
import type {WorkbenchReadQuery,WorkbenchObjectRef,WorkbenchHistoryQuery} from '@camery/ir/workbench';
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const Me = z.strictObject({ tenantId: Id, userId: Id, grants: z.array(z.strictObject({ projectId: Id, role: z.string().min(1).max(32) })).max(10000) });
export type Identity = z.infer<typeof Me>;
const Access = z.strictObject({ projectId: Id, permissions: z.array(z.string().min(1).max(64)).max(32) });
const Progress = z.strictObject({ offset: z.number().int().nonnegative(), version: z.number().int().positive() });
export class ApiError extends Error { constructor(readonly code: string) { super(`Request failed (${code})`); this.name = 'ApiError'; } }
function id(value: string): string { if (!Id.safeParse(value).success) throw new ApiError('INVALID_REQUEST'); return encodeURIComponent(value); }
function workbenchQuery(input:Record<string,string|number|undefined>){const entries=Object.entries(input).filter((entry):entry is [string,string|number]=>entry[1]!==undefined);return entries.length?`?${entries.map(([key,value])=>`${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`:'';}
function outlineInput<T>(schema:z.ZodType<T>,input:unknown):T{const parsed=boundedOutlineSchema(schema,16384).safeParse(input);if(!parsed.success)throw new ApiError('INVALID_REQUEST');return parsed.data;}
function formalSelection(query:OutlineFormalListQuery,revision:number,items:readonly {ref:OutlineFormalRef;plan:{id:string;version:number}}[]){return (query.revision===undefined||revision===query.revision)&&(query.limit===undefined||items.length<=query.limit)&&items.every(item=>(query.collection===undefined||item.ref.collection===query.collection)&&(query.planId===undefined||item.plan.id===query.planId));}
function sameOutlineEntries<T>(left:readonly T[],right:readonly T[],key:(value:T)=>string){
  const ordered=(items:readonly T[])=>items.toSorted((a,b)=>key(a).localeCompare(key(b)));
  return JSON.stringify(ordered(left))===JSON.stringify(ordered(right));
}
export class ApiClient {
  readonly #credential: string; readonly #transport: typeof fetch;
  constructor(token: string, transport: typeof fetch = fetch) {
    if (!/^cmry_[A-Za-z0-9_-]{43}$(?![\s\S])/.test(token)) throw new ApiError('INVALID_CREDENTIAL');
    this.#credential = token; this.#transport = transport;
  }
  private async request<T>(path: string, schema: z.ZodType<T> | null, init: RequestInit = {}, workbench = false): Promise<T> {
    let response: Response;
    try {
      const deadline = AbortSignal.timeout(30_000);
      const headers = new Headers(init.headers); headers.set('Authorization',`Bearer ${this.#credential}`);
      // WebIDL fetch rejects an arbitrary class receiver in real browsers; injected transports must stay unbound too.
      const transport = this.#transport;
      response = await transport(`/api/v1${path}`, { ...init, signal: init.signal ? AbortSignal.any([init.signal,deadline]) : deadline, mode: 'same-origin', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
        headers });
    } catch (error) { throw new ApiError(error instanceof Error && error.name === 'AbortError' ? 'CANCELLED' : error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_FAILED'); }
    if (!response.ok) {
      const statusCodes: Record<number,string> = { 400: 'INVALID_INPUT', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'INPUT_LIMIT', 415: 'UNSUPPORTED_FORMAT', 422: 'MALFORMED_DOCUMENT', 503: 'STORAGE_FAILED' };
      if(workbench){
        const allowed:Record<string,number>={SCHEMA_UPGRADE_REQUIRED:409,PROJECT_BINDING_MISSING:409,PRINCIPAL_BINDING_MISSING:403,SOURCE_POLICY_MISSING:409,SNAPSHOT_STALE:409,WRITE_VERSION_CONFLICT:409,ASSET_NOT_READY:409};
        try{const problem=z.strictObject({code:z.string(),requestId:Id}).safeParse(await response.json());if(problem.success&&allowed[problem.data.code]===response.status)throw new ApiError(problem.data.code);}catch(problem){if(problem instanceof ApiError)throw problem;}
      }
      throw new ApiError(statusCodes[response.status] ?? 'HTTP_FAILED');
    }
    if (schema === null) return undefined as T;
    let data: unknown;
    try { data = await response.json(); } catch { throw new ApiError('BAD_RESPONSE'); }
    const parsed = schema.safeParse(data); if (!parsed.success) throw new ApiError('BAD_RESPONSE'); return parsed.data;
  }
  me() { return this.request('/me',Me); }
  access(projectId: string, signal?: AbortSignal) { return this.request(`/projects/${id(projectId)}/access`,Access,signal ? { signal } : {}); }
  list(projectId: string, cursor?: string, signal?: AbortSignal) {
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    return this.request(`/projects/${id(projectId)}/sources${query}`,SourceListSchema,signal ? { signal } : {});
  }
  read(projectId: string, kind: SourceKind, documentId: string, offset?: number, signal?: AbortSignal, before?: number) {
    if (offset !== undefined && before !== undefined || [offset,before].some(value=>value!==undefined && (!Number.isSafeInteger(value) || value<0))) throw new ApiError('INVALID_REQUEST');
    const query=before!==undefined?`?before=${before}`:offset===undefined?'':`?offset=${offset}`;
    return this.request(`/projects/${id(projectId)}/${kind === 'novel' ? 'novels' : 'scripts'}/${id(documentId)}${query}`,SourcePageSchema,signal ? { signal } : {});
  }
  append(projectId: string, documentId: string, command: { batchId: string; text: string; expectedRevision: number; title?: string }) {
    return this.request(`/projects/${id(projectId)}/novels/${id(documentId)}/batches`,AppendReceiptSchema,{ method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(command) });
  }
  script(projectId: string, documentId: string, format: Exclude<UploadFormat,'novel'>, title: string, bytes: Uint8Array) {
    return this.request(`/projects/${id(projectId)}/scripts/${id(documentId)}/${format}?title=${encodeURIComponent(title)}`,ScriptReceiptSchema,
      { method: 'PUT', headers: { 'Content-Type':'application/octet-stream' }, body: Uint8Array.from(bytes).buffer });
  }
  checkpoint(projectId: string, documentId: string, command: { sourceDigest: string; offset: number; expectedVersion: number }) {
    return this.request(`/projects/${id(projectId)}/novels/${id(documentId)}/checkpoint`,Progress,{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command) });
  }
  signOut() { return this.request<void>('/auth/sign-out',null,{method:'POST'}); }
  bibleCapabilities(projectId:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/bibles/capabilities`,BibleCapabilitiesSchema,signal?{signal}:{});}
  bibleList(projectId:string,cursor?:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/bibles${cursor===undefined?'':`?cursor=${encodeURIComponent(cursor)}`}`,boundedBibleSchema(BibleRunListSchema),signal?{signal}:{});}
  bibleStatus(projectId:string,runId:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/bibles/${id(runId)}/status`,BibleStatusSchema,signal?{signal}:{});}
  bibleRead(projectId:string,runId:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/bibles/${id(runId)}`,boundedBibleSchema(BibleRunViewSchema),signal?{signal}:{});}
  bibleSource(projectId:string,runId:string,target=0,signal?:AbortSignal,direction?:'before'){
    if(!Number.isSafeInteger(target)||target<0)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/bibles/${id(runId)}/source?${direction==='before'?'before':'offset'}=${target}`,SourcePageSchema,signal?{signal}:{});
  }
  bibleStart(projectId:string,command:BibleStart){
    const parsed=BibleStartSchema.safeParse(command);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/bibles`,BibleStatusSchema,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed.data)});
  }
  bibleConfirm(projectId:string,runId:string,decision:BibleConfirm){
    const parsed=boundedBibleSchema(BibleConfirmSchema).safeParse(decision);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/bibles/${id(runId)}/confirm`,boundedBibleSchema(BibleRunViewSchema),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed.data)});
  }
  bibleReject(projectId:string,runId:string,reason:string){
    const parsed=BibleRejectSchema.safeParse({reason});if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/bibles/${id(runId)}/reject`,boundedBibleSchema(BibleRunViewSchema),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed.data)});
  }
  developmentCapabilities(projectId:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/development/capabilities`,DevelopmentCapabilitiesSchema,signal?{signal}:{});}
  outlineCapabilities(projectId:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/outlines/capabilities`,OutlineCapabilitiesSchema,signal?{signal}:{});}
  outlineBriefList(projectId:string,cursor?:string,signal?:AbortSignal){
    const query=OutlineBriefListQuerySchema.safeParse(cursor===undefined?{}:{cursor});if(!query.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/outlines/briefs${workbenchQuery(query.data)}`,OutlineBriefListSchema,signal?{signal}:{});
  }
  outlineBrief(projectId:string,briefId:string,revision?:number,signal?:AbortSignal){
    if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))throw new ApiError('INVALID_REQUEST');
    const query=OutlineReadBriefQuerySchema.safeParse(revision===undefined?{}:{revision:String(revision)});if(!query.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/outlines/briefs/${id(briefId)}${workbenchQuery(query.data)}`,OutlineBriefViewSchema.refine(value=>value.brief.briefId===briefId&&(revision===undefined||value.brief.revision===revision)),signal?{signal}:{});
  }
  outlineSaveBrief(projectId:string,command:OutlineBriefWrite){
    const parsed=OutlineBriefWriteSchema.safeParse(command);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/outlines/briefs`,OutlineBriefViewSchema.refine(value=>value.brief.briefId===parsed.data.briefId&&value.brief.revision===parsed.data.expectedRevision+1),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed.data)});
  }
  outlineSources(projectId:string,kind:'development'|'bible',cursor?:string,signal?:AbortSignal){
    const query=OutlineSourceListQuerySchema.safeParse(cursor===undefined?{kind}:{kind,cursor});if(!query.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/outlines/sources${workbenchQuery(query.data)}`,OutlineSourceListSchema.refine(value=>value.items.every(item=>item.source.kind===query.data.kind)),signal?{signal}:{});
  }
  outlineList(projectId:string,cursor?:string,signal?:AbortSignal){
    const query=OutlineListQuerySchema.safeParse(cursor===undefined?{}:{cursor});if(!query.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/outlines${workbenchQuery(query.data)}`,OutlineRunListSchema,signal?{signal}:{});
  }
  outlineStatus(projectId:string,runId:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/outlines/${id(runId)}/status`,OutlineStatusSchema.refine(value=>value.runId===runId),signal?{signal}:{});}
  outlineRead(projectId:string,runId:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/outlines/${id(runId)}`,OutlineRunViewSchema.refine(value=>value.runId===runId),signal?{signal}:{});}
  outlineStart(projectId:string,command:OutlineStart){
    const parsed=OutlineStartSchema.safeParse(command);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/outlines`,OutlineStatusSchema.refine(value=>value.runId===parsed.data.runId&&value.briefId===parsed.data.briefId&&value.briefRevision===parsed.data.expectedRevision),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed.data)});
  }
  outlineConfirm(projectId:string,runId:string,decision:OutlineConfirm){
    const parsed=OutlineConfirmSchema.safeParse(decision);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    // An HTTP success must contain this human decision; a pending or unrelated audit cannot acknowledge it.
    const response=OutlineRunViewSchema.refine(value=>value.runId===runId&&value.candidate?.digest===parsed.data.candidateDigest&&value.review?.status==='reviewed'&&value.review.candidateDigest===parsed.data.candidateDigest&&JSON.stringify(value.review.output)===JSON.stringify(parsed.data.output)&&sameOutlineEntries(value.review.ablations,parsed.data.ablations,item=>item.genre)&&sameOutlineEntries(value.review.waivers,parsed.data.waivers,item=>item.issueId));
    return this.request(`/projects/${id(projectId)}/outlines/${id(runId)}/confirm`,response,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed.data)});
  }
  outlineReject(projectId:string,runId:string,reason:string){
    const parsed=OutlineRejectSchema.safeParse({reason});if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/outlines/${id(runId)}/reject`,OutlineRunViewSchema.refine(value=>value.runId===runId&&value.review?.status==='rejected'&&value.review.reason===parsed.data.reason),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed.data)});
  }
  private workbenchRequest<T>(path:string,schema:z.ZodType<T>,init:RequestInit={}){return this.request(path,schema,init,true);}
  private outlineRequest<T>(path:string,schema:z.ZodType<T>,init:RequestInit={}){return this.workbenchRequest(path,boundedOutlineSchema(workbenchEnvelope(schema),983040),init).then(value=>value.data);}
  workbenchUpgradeCandidate(projectId:string,candidateId:string,signal?:AbortSignal){
    outlineInput(OutlineFormalRefSchema.shape.id,candidateId);
    return this.outlineRequest(`/projects/${id(projectId)}/workbench/schema-upgrades/${id(candidateId)}`,OutlineUpgradeCandidateSchema.refine(value=>value.candidate.projectKey===projectId&&value.candidate.candidateId===candidateId),{signal:signal??null});
  }
  outlinePrepareCandidate(projectId:string,runId:string,command:OutlinePrepareCommand,signal?:AbortSignal){
    const parsed=outlineInput(OutlinePrepareCommandSchema,command);
    return this.outlineRequest(`/projects/${id(projectId)}/outline/${id(runId)}/candidates`,OutlineCandidateSchema.refine(value=>value.projectKey===projectId&&value.runId===runId&&value.applicationId===parsed.applicationId),{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':parsed.applicationId},body:JSON.stringify(parsed),signal:signal??null});
  }
  outlineCandidates(projectId:string,query:OutlineCandidateListQuery={},signal?:AbortSignal){
    const selection=outlineInput(OutlineCandidateListQuerySchema,query);
    return this.outlineRequest(`/projects/${id(projectId)}/outline-adoption/candidates${workbenchQuery(selection)}`,OutlineCandidatePageSchema.refine(value=>(selection.limit===undefined||value.items.length<=selection.limit)&&value.items.every(item=>selection.runId===undefined||item.runId===selection.runId)),{signal:signal??null});
  }
  outlineCandidate(projectId:string,candidateId:string,signal?:AbortSignal){
    outlineInput(OutlineFormalRefSchema.shape.id,candidateId);
    return this.outlineRequest(`/projects/${id(projectId)}/outline-adoption/candidates/${id(candidateId)}`,OutlineCandidateSchema.refine(value=>value.projectKey===projectId&&value.candidateId===candidateId),{signal:signal??null});
  }
  outlineAdoptCandidate(projectId:string,candidateId:string,requestId:string,command:OutlineAdoptCommand,signal?:AbortSignal){return this.outlineDecision(projectId,candidateId,requestId,'adopt',outlineInput(OutlineAdoptCommandSchema,command),signal);}
  outlineRejectCandidate(projectId:string,candidateId:string,requestId:string,command:OutlineRejectCommand,signal?:AbortSignal){return this.outlineDecision(projectId,candidateId,requestId,'reject',outlineInput(OutlineRejectCommandSchema,command),signal);}
  private outlineDecision(projectId:string,candidateId:string,requestId:string,action:'adopt'|'reject',command:OutlineAdoptCommand|OutlineRejectCommand,signal?:AbortSignal){
    outlineInput(OutlineFormalRefSchema.shape.id,candidateId);outlineInput(Id,requestId);
    // Failed operations can retain an earlier native adoption/rejection audit; that evidence is not a new successful decision.
    const response=OutlineReceiptSchema.refine(value=>value.projectKey===projectId&&value.candidateId===candidateId&&value.kind==='decision'&&value.requestId===requestId&&(value.issueCount>0||(action==='adopt'?value.rejection===null:value.adoption===null&&(!value.rejection||'reason' in command&&value.rejection.reason===command.reason))));
    return this.outlineRequest(`/projects/${id(projectId)}/outline-adoption/candidates/${id(candidateId)}/${action}`,response,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':requestId},body:JSON.stringify(command),signal:signal??null});
  }
  outlineReceiptMessages(projectId:string,candidateId:string,query:OutlineReceiptQuery,signal?:AbortSignal){
    outlineInput(OutlineFormalRefSchema.shape.id,candidateId);const selection=outlineInput(OutlineReceiptQuerySchema,query);
    const response=OutlineReceiptPageSchema.refine(value=>value.projectKey===projectId&&value.candidateId===candidateId&&value.kind===selection.kind&&value.requestId===selection.requestId&&value.section===selection.section&&(selection.limit===undefined||value.items.length<=selection.limit));
    return this.outlineRequest(`/projects/${id(projectId)}/outline-adoption/candidates/${id(candidateId)}/receipts${workbenchQuery(selection)}`,response,{signal:signal??null});
  }
  formalOutlineList(projectId:string,query:OutlineFormalListQuery={},signal?:AbortSignal){
    const selection=outlineInput(OutlineFormalListQuerySchema,query);
    return this.outlineRequest(`/projects/${id(projectId)}/formal-outline${workbenchQuery(selection)}`,OutlineFormalListSchema.refine(value=>value.projectKey===projectId&&formalSelection(selection,value.snapshotRevision,value.items)),{signal:signal??null});
  }
  formalOutlineRows(projectId:string,query:OutlineFormalListQuery={},signal?:AbortSignal){
    const selection=outlineInput(OutlineFormalListQuerySchema,query);
    return this.outlineRequest(`/projects/${id(projectId)}/formal-outline/rows${workbenchQuery(selection)}`,OutlineFormalRowsSchema.refine(value=>value.projectKey===projectId&&formalSelection(selection,value.snapshotRevision,value.rows)),{signal:signal??null});
  }
  formalOutlineObject(projectId:string,collection:OutlineFormalCollection,objectId:string,query:OutlineFormalObjectQuery={},signal?:AbortSignal){
    outlineInput(OutlineFormalCollectionSchema,collection);outlineInput(OutlineFormalRefSchema.shape.id,objectId);const selection=outlineInput(OutlineFormalObjectQuerySchema,query);
    return this.outlineRequest(`/projects/${id(projectId)}/formal-outline/${id(collection)}/${id(objectId)}${workbenchQuery(selection)}`,OutlineFormalObjectSchema.refine(value=>value.projectKey===projectId&&value.ref.collection===collection&&value.ref.id===objectId&&(selection.revision===undefined||value.snapshotRevision===selection.revision)),{signal:signal??null});
  }
  formalOutlineSection(projectId:string,collection:OutlineFormalCollection,objectId:string,query:OutlineFormalSectionQuery,signal?:AbortSignal){
    outlineInput(OutlineFormalCollectionSchema,collection);outlineInput(OutlineFormalRefSchema.shape.id,objectId);const selection=outlineInput(OutlineFormalSectionQuerySchema,query);if(OUTLINE_FORMAL_SECTIONS[selection.section].collection!==collection)throw new ApiError('INVALID_REQUEST');
    const response=OutlineFormalSectionPageSchema.refine(value=>value.projectKey===projectId&&value.ref.collection===collection&&value.ref.id===objectId&&value.section===selection.section&&(selection.revision===undefined||value.snapshotRevision===selection.revision)&&(selection.limit===undefined||value.items.length<=selection.limit));
    return this.outlineRequest(`/projects/${id(projectId)}/formal-outline/${id(collection)}/${id(objectId)}/sections${workbenchQuery(selection)}`,response,{signal:signal??null});
  }
  readWorkbenchSnapshot(projectId:string,query:WorkbenchReadQuery={},signal?:AbortSignal){
    const parsed=WorkbenchReadQuerySchema.safeParse(query);if(!parsed.success)throw new ApiError('INVALID_REQUEST');const selection=parsed.data;
    const response=WorkbenchSnapshotSchema.refine(value=>value.projectKey===projectId&&(selection.expectedRevision===undefined||value.snapshotRevision===selection.expectedRevision)&&value.renditionId===(selection.renditionId??null)&&
      (selection.sceneId?value.scope.kind==='scene'&&value.scope.id===selection.sceneId:selection.episodeId?value.scope.kind==='episode'&&value.scope.id===selection.episodeId:value.scope.kind==='project'&&value.scope.id===value.projectId)&&
      (selection.collection===undefined||value.rows.every(row=>row.role==='context'||row.ref.collection===selection.collection)));
    return this.workbenchRequest(`/projects/${id(projectId)}/workbench${workbenchQuery(selection)}`,workbenchEnvelope(response),{signal:signal??null}).then(value=>value.data);
  }
  readWorkbenchObjectHistory(projectId:string,collection:WorkbenchObjectRef['collection'],objectId:string,query:WorkbenchHistoryQuery={},signal?:AbortSignal){
    const parsed=WorkbenchHistoryQuerySchema.safeParse(query);if(!parsed.success||!WorkbenchCollectionSchema.safeParse(collection).success||!WorkbenchObjectRefSchema.shape.id.safeParse(objectId).success)throw new ApiError('INVALID_REQUEST');
    const response=WorkbenchObjectHistorySchema.refine(value=>value.projectKey===projectId&&value.collection===collection&&value.objectId===objectId&&(parsed.data.expectedRevision===undefined||value.snapshotRevision===parsed.data.expectedRevision)&&value.items.every(row=>row.ref.collection===collection&&row.ref.id===objectId&&row.snapshotRevision<=value.snapshotRevision));
    return this.workbenchRequest(`/projects/${id(projectId)}/workbench/objects/${id(collection)}/${id(objectId)}/history${workbenchQuery(parsed.data)}`,workbenchEnvelope(response),{signal:signal??null}).then(value=>value.data);
  }
  checkWorkbenchReadyAsset(projectId:string,assetId:string,version:number,expectedRevision?:number,signal?:AbortSignal){
    const parsed=WorkbenchReadyAssetQuerySchema.safeParse({expectedRevision});if(!parsed.success||!WorkbenchObjectRefSchema.shape.id.safeParse(assetId).success||!WorkbenchObjectRefSchema.shape.version.safeParse(version).success)throw new ApiError('INVALID_REQUEST');
    // No media transport is enabled: even a successful HTTP response must not become a fabricated URL.
    return this.workbenchRequest(`/projects/${id(projectId)}/workbench/assets/${id(assetId)}/versions/${version}${workbenchQuery(parsed.data)}`,workbenchEnvelope(z.never()),{signal:signal??null}).then(value=>value.data);
  }
  getWorkbenchState(projectId:string,signal?:AbortSignal){
    return this.workbenchRequest(`/projects/${id(projectId)}/workbench/state`,workbenchEnvelope(WorkbenchStateSchema.refine(value=>value.projectKey===projectId)),{signal:signal??null}).then(value=>value.data);
  }
  listWorkbenchCandidates(projectId:string,runId?:string,cursor?:string,signal?:AbortSignal){
    const parsed=WorkbenchCandidateListQuerySchema.safeParse({runId,cursor});if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    const params=[...(parsed.data.runId===undefined?[]:[`runId=${encodeURIComponent(parsed.data.runId)}`]),...(cursor===undefined?[]:[`cursor=${encodeURIComponent(cursor)}`])];const query=params.length?`?${params.join('&')}`:'';
    return this.workbenchRequest(`/projects/${id(projectId)}/workbench/candidates${query}`,workbenchEnvelope(WorkbenchCandidatePageSchema.refine(value=>value.items.every(item=>item.projectKey===projectId&&(runId===undefined||item.source.kind!=='development'||item.source.runId===runId)))),{signal:signal??null}).then(value=>value.data);
  }
  getWorkbenchCandidate(projectId:string,candidateId:string,signal?:AbortSignal){
    const parsed=WorkbenchCandidateDetailSchema.shape.candidateId.safeParse(candidateId);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.workbenchRequest(`/projects/${id(projectId)}/workbench/candidates/${id(candidateId)}`,workbenchEnvelope(WorkbenchCandidateDetailSchema.refine(value=>value.projectKey===projectId&&value.candidateId===candidateId)),{signal:signal??null}).then(value=>value.data);
  }
  prepareDevelopmentCandidate(projectId:string,runId:string,command:DevelopmentCandidatePrepare,signal?:AbortSignal){
    const parsed=DevelopmentCandidatePrepareSchema.safeParse(command);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.workbenchRequest(`/projects/${id(projectId)}/development/${id(runId)}/candidates`,workbenchEnvelope(WorkbenchCandidateDetailSchema.refine(value=>value.projectKey===projectId&&value.applicationId===parsed.data.applicationId&&value.source.kind==='development'&&value.source.runId===runId)),{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':parsed.data.applicationId},body:JSON.stringify(parsed.data),signal:signal??null}).then(value=>value.data);
  }
  prepareWorkbenchUpgrade(projectId:string,command:WorkbenchUpgradeInput,signal?:AbortSignal){
    const parsed=WorkbenchUpgradeSchema.safeParse(command);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.workbenchRequest(`/projects/${id(projectId)}/workbench/schema-upgrade`,workbenchEnvelope(WorkbenchCandidateDetailSchema.refine(value=>value.projectKey===projectId&&value.applicationId===parsed.data.applicationId&&value.source.kind==='manual')),{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':parsed.data.applicationId},body:JSON.stringify(parsed.data),signal:signal??null}).then(value=>value.data);
  }
  adoptWorkbenchCandidate(projectId:string,candidateId:string,requestId:string,command:WorkbenchAdoptInput,signal?:AbortSignal){
    const parsed=WorkbenchAdoptSchema.safeParse(command);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.workbenchDecision(projectId,candidateId,requestId,'adopt',parsed.data,signal);
  }
  rejectWorkbenchCandidate(projectId:string,candidateId:string,requestId:string,command:WorkbenchRejectInput,signal?:AbortSignal){
    const parsed=WorkbenchRejectSchema.safeParse(command);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.workbenchDecision(projectId,candidateId,requestId,'reject',parsed.data,signal);
  }
  private workbenchDecision(projectId:string,candidateId:string,requestId:string,action:'adopt'|'reject',command:WorkbenchAdoptInput|WorkbenchRejectInput,signal?:AbortSignal){
    if(!WorkbenchCandidateDetailSchema.shape.candidateId.safeParse(candidateId).success||!Id.safeParse(requestId).success)throw new ApiError('INVALID_REQUEST');
    return this.workbenchRequest(`/projects/${id(projectId)}/workbench/candidates/${id(candidateId)}/${action}`,workbenchEnvelope(WorkbenchActionReceiptSchema.refine(value=>value.changeId===candidateId)),{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':requestId},body:JSON.stringify(command),signal:signal??null}).then(value=>value.data);
  }
  developmentBriefList(projectId:string,cursor?:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/development/briefs${cursor===undefined?'':`?cursor=${encodeURIComponent(cursor)}`}`,boundedDevelopmentSchema(DevelopmentBriefListSchema),signal?{signal}:{});}
  developmentList(projectId:string,cursor?:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/development${cursor===undefined?'':`?cursor=${encodeURIComponent(cursor)}`}`,boundedDevelopmentSchema(DevelopmentRunListSchema),signal?{signal}:{});}
  developmentBrief(projectId:string,briefId:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/development/briefs/${id(briefId)}`,boundedDevelopmentSchema(DevelopmentBriefViewSchema.refine(value=>value.brief.briefId===briefId)),signal?{signal}:{});}
  developmentPutBrief(projectId:string,command:DevelopmentBriefWrite){
    const parsed=boundedDevelopmentSchema(DevelopmentBriefWriteSchema).safeParse(command);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/development/briefs`,boundedDevelopmentSchema(DevelopmentBriefViewSchema.refine(value=>value.brief.briefId===parsed.data.briefId&&value.brief.revision===parsed.data.expectedRevision+1)),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed.data)});
  }
  developmentStart(projectId:string,command:DevelopmentStart){
    const parsed=DevelopmentStartSchema.safeParse(command);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/development`,DevelopmentStatusSchema.refine(value=>value.runId===parsed.data.runId),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed.data)});
  }
  developmentRead(projectId:string,runId:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/development/${id(runId)}`,boundedDevelopmentSchema(DevelopmentRunViewSchema.refine(value=>value.runId===runId)),signal?{signal}:{});}
  developmentStatus(projectId:string,runId:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/development/${id(runId)}/status`,DevelopmentStatusSchema.refine(value=>value.runId===runId),signal?{signal}:{});}
  developmentRedoOptions(projectId:string,runId:string,signal?:AbortSignal){return this.request(`/projects/${id(projectId)}/development/${id(runId)}/redo`,boundedDevelopmentSchema(DevelopmentRedoOptionsSchema.refine(value=>value.runId===runId)),signal?{signal}:{});}
  developmentRedo(projectId:string,sourceRunId:string,stage:'foundation'|'episodes',command:DevelopmentRedo){
    if(stage!=='foundation'&&stage!=='episodes')throw new ApiError('INVALID_REQUEST');
    const parsed=boundedDevelopmentSchema(DevelopmentRedoSchema).safeParse(command);if(!parsed.success||parsed.data.runId===sourceRunId||(stage==='foundation')!==(parsed.data.expectedFoundationReviewDigest===null))throw new ApiError('INVALID_REQUEST');
    const expected=parsed.data;
    const response=DevelopmentRunViewSchema.refine(value=>value.runId===expected.runId&&value.brief.digest===expected.expectedBriefDigest&&value.origin?.sourceRunId===sourceRunId&&value.origin.sourceRunDigest===expected.expectedSourceRunDigest&&value.origin.stage===stage
      &&(stage==='foundation'?value.origin.foundation===null:value.origin.foundation?.reviewDigest===expected.expectedFoundationReviewDigest&&value.foundation.review?.status==='reviewed'&&value.foundation.review.digest===expected.expectedFoundationReviewDigest));
    return this.request(`/projects/${id(projectId)}/development/${id(sourceRunId)}/redo/${stage}`,boundedDevelopmentSchema(response),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(expected)});
  }
  developmentConfirm(projectId:string,runId:string,stage:'foundation'|'episodes',decision:DevelopmentFoundationConfirm|DevelopmentEpisodesConfirm){
    if(stage!=='foundation'&&stage!=='episodes')throw new ApiError('INVALID_REQUEST');
    const parsed=stage==='foundation'?boundedDevelopmentSchema(DevelopmentFoundationConfirmSchema).safeParse(decision):boundedDevelopmentSchema(DevelopmentEpisodesConfirmSchema).safeParse(decision);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/development/${id(runId)}/${stage}/confirm`,boundedDevelopmentSchema(DevelopmentRunViewSchema.refine(value=>value.runId===runId)),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed.data)});
  }
  developmentReject(projectId:string,runId:string,stage:'foundation'|'episodes',reason:string){
    if(stage!=='foundation'&&stage!=='episodes')throw new ApiError('INVALID_REQUEST');
    const parsed=DevelopmentRejectSchema.safeParse({reason});if(!parsed.success)throw new ApiError('INVALID_REQUEST');
    return this.request(`/projects/${id(projectId)}/development/${id(runId)}/${stage}/reject`,boundedDevelopmentSchema(DevelopmentRunViewSchema.refine(value=>value.runId===runId)),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed.data)});
  }
}
