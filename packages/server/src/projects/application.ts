import {z} from 'zod';
import {AccessError,authorize,parseIdentity,permissionsFor} from '@camery/access';
import type {Permission,SessionIdentity} from '@camery/access';
import {Asset,ChangeSet,StableId,OUTLINE_COLLECTIONS} from '@camery/ir';
import {WorkbenchStateSchema,WorkbenchPreviewSchema,WorkbenchSubmitSchema,WorkbenchUpgradeSchema,WorkbenchAdoptSchema,WorkbenchRejectSchema,DevelopmentCandidatePrepareSchema,WorkbenchCandidateListQuerySchema,WorkbenchReadQuerySchema,WorkbenchHistoryQuerySchema,WorkbenchObjectHistorySchema,WorkbenchCollectionSchema,WorkbenchReadyAssetQuerySchema,WorkbenchCompareSchema,WorkbenchCompareResultSchema,WorkbenchSelectionSchema} from '@camery/ir/workbench';
import type {WorkbenchCompareResult,WorkbenchSelectionInput} from '@camery/ir/workbench';
import {OutlineUpgradeCandidateSchema} from '@camery/ir/outline-adoption';
import {freeze} from '@camery/methods';
import {snapshotJson,JsonBoundaryError} from '@camery/methods/json';
import {submitChangeSet,compareVersionSnapshots,selectChangeOperations} from '@camery/versioning';
import type {StoredVersionState,VersionProjectKey} from '@camery/versioning/node';
import {prepareDevelopmentDraft,finalizeDevelopmentChangeSet,createDevelopmentSourceGuard} from '@camery/script/node';
import {Id} from '@camery/script/contracts';
import {ProjectIdentityError} from './contracts.js';
import {ProjectApplicationError} from './intent-contracts.js';
import type {CandidateIntent,CandidateIntentBody,DecisionIntentBody} from './intent-contracts.js';
import {projectIntentDigest} from './intent-store.js';
import {resolveProjectAuthority} from './authority.js';
import {projectCandidateDetail,projectPreview,redactDifference} from './projection.js';
import type {ProjectApplicationOptions} from './options.js';
import {projectReadSnapshot,redactReadObject} from './read-projection.js';
import {encodeReadCursor,decodeReadCursor} from './read-cursor.js';

interface Context {subject:unknown;projectId:string}
const stable=StableId.refine(value=>value.length===26);
function capture<S extends z.ZodType>(schema:S,input:unknown):z.infer<S>{
  try{const parsed=schema.safeParse(snapshotJson(input,540672));if(parsed.success)return freeze(parsed.data) as z.infer<S>;}
  catch(error){if(error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT')throw new ProjectApplicationError('INPUT_LIMIT','command boundary');}
  throw new ProjectApplicationError('INVALID_INPUT','command boundary');
}
const expectation=(value:{expectedSnapshotRevision:number;expectedWriteVersion:number})=>({expectedSnapshotRevision:value.expectedSnapshotRevision,expectedWriteVersion:value.expectedWriteVersion});
const sameTarget=(left:VersionProjectKey,right:VersionProjectKey)=>left.tenantId===right.tenantId&&left.projectId===right.projectId;

/** One host boundary for authenticated project commands. Reads never allocate identities or initialize projects. */
export class ProjectApplication{
  constructor(private readonly options:ProjectApplicationOptions){}
  private subject(input:Context,permission:Permission):SessionIdentity{
    const subject=parseIdentity(input.subject);authorize(subject,this.options.tenantId,input.projectId,permission);return subject;
  }
  private async authority(input:Context,permission:Permission){
    const subject=this.subject(input,permission);
    const bound=await resolveProjectAuthority({identities:this.options.identities,subject,projectId:input.projectId,permission});
    return {...bound,subject,actor:{kind:'user' as const,key:subject.userId,id:bound.principal.id}};
  }
  private async read(key:VersionProjectKey):Promise<StoredVersionState>{
    const stored=await this.options.versions.read(key);if(!stored)throw new ProjectApplicationError('NOT_FOUND','project snapshot');
    if(stored.state.head.project.id!==key.projectId)throw new ProjectApplicationError('STORAGE_FAILED','project snapshot binding');return stored;
  }
  private checkBase(stored:StoredVersionState,command:{expectedSnapshotRevision:number;expectedWriteVersion?:number}):void{
    if(stored.state.head.revision.number!==command.expectedSnapshotRevision)throw new ProjectApplicationError('SNAPSHOT_STALE','snapshot base');
    if(command.expectedWriteVersion!==undefined&&stored.writeVersion!==command.expectedWriteVersion)throw new ProjectApplicationError('WRITE_VERSION_CONFLICT','write base');
  }
  private async readHead(key:VersionProjectKey){
    const stored=await this.options.reads.head(key);if(!stored)throw new ProjectApplicationError('NOT_FOUND','project snapshot');
    if(stored.head.project.id!==key.projectId)throw new ProjectApplicationError('STORAGE_FAILED','read snapshot binding');return stored;
  }
  private async readCapabilities(subject:SessionIdentity,projectId:string){
    let actorId:string|null=null;
    try{const actor=await this.options.identities.resolvePrincipal({tenantId:subject.tenantId,kind:'user',key:subject.userId});actorId=actor.principal.id;}
    catch(error){if(!(error instanceof ProjectIdentityError)||error.code!=='PRINCIPAL_BINDING_MISSING')throw error;}
    const permissions=permissionsFor(subject,this.options.tenantId,projectId);
    return {actorId,canWrite:actorId!==null&&permissions.includes('candidate:write'),canReview:actorId!==null&&permissions.includes('candidate:review')};
  }
  async state(input:Context){
    const subject=this.subject(input,'project:read');const projectId=input.projectId;
    const binding=await this.options.identities.resolveProject({tenantId:subject.tenantId,projectId});const stored=await this.readHead(binding.versionKey);const capabilities=await this.readCapabilities(subject,projectId);
    return WorkbenchStateSchema.parse({contractVersion:1,projectKey:projectId,projectId:binding.versionKey.projectId,schemaVersion:stored.head.schema_version,snapshotRevision:stored.head.revision.number,writeVersion:stored.writeVersion,...capabilities,nativePending:stored.pendingCount,
      counts:Object.entries(stored.head).filter(([,value])=>Array.isArray(value)).map(([collection,value])=>({collection,count:(value as unknown[]).length}))});
  }
  async readSnapshot(input:Context&{command:unknown}){
    const subject=this.subject(input,'project:read');const projectId=input.projectId;const query=capture(WorkbenchReadQuerySchema,input.command);
    const binding=await this.options.identities.resolveProject({tenantId:subject.tenantId,projectId});const stored=await this.readHead(binding.versionKey);const capabilities=await this.readCapabilities(subject,projectId);
    return projectReadSnapshot({projectKey:projectId,target:binding.versionKey,subjectId:subject.userId,...stored,query,capabilities:{canWrite:capabilities.canWrite,canReview:capabilities.canReview}});
  }
  async readObjectHistory(input:Context&{collection:string;objectId:string;command:unknown}){
    const subject=this.subject(input,'project:read');const projectId=input.projectId;const collection=capture(WorkbenchCollectionSchema,input.collection);const objectId=capture(stable,input.objectId);const query=capture(WorkbenchHistoryQuerySchema,input.command);
    const mapped=await this.options.identities.resolveProject({tenantId:subject.tenantId,projectId});const target=mapped.versionKey;const limit=query.limit??20;
    const binding={kind:'history',projectKey:projectId,target,subjectId:subject.userId,collection,objectId};
    const cursor=query.cursor?decodeReadCursor(binding,query.cursor,z.strictObject({snapshotRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),beforeVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)})):undefined;
    if(cursor&&query.expectedRevision!==undefined&&cursor.snapshotRevision!==query.expectedRevision)throw new ProjectApplicationError('INVALID_INPUT','history cursor revision');
    const expectedRevision=cursor?.snapshotRevision??query.expectedRevision??(await this.readHead(target)).head.revision.number;
    const read=await this.options.reads.history({target,collection,objectId,expectedRevision,...(cursor?{beforeVersion:cursor.beforeVersion}:{}),limit:limit+1});
    if(!read)throw new ProjectApplicationError('NOT_FOUND','project history');if(read.snapshotRevision!==expectedRevision)throw new ProjectApplicationError('SNAPSHOT_STALE','history snapshot');
    if(!read.items.length&&!cursor)throw new ProjectApplicationError('NOT_FOUND','object history');
    const items=read.items.slice(0,limit).map(row=>({ref:{collection,id:objectId,version:row.version},parentVersion:row.parent_version,snapshotRevision:row.snapshot_revision,changeId:row.change_set_id,deleted:row.value===null,value:row.value===null?null:redactReadObject(collection,row.value)}));
    const page=()=>WorkbenchObjectHistorySchema.parse({contractVersion:1,projectKey:projectId,projectId:target.projectId,collection,objectId,snapshotRevision:read.snapshotRevision,writeVersion:read.writeVersion,
      nextCursor:read.items.length>items.length&&items.length?encodeReadCursor(binding,{snapshotRevision:read.snapshotRevision,beforeVersion:items.at(-1)!.ref.version}):null,items});
    while(true){const result=page();try{snapshotJson(result,983040,65536);return result;}catch(error){if(!(error instanceof JsonBoundaryError)||error.code!=='INPUT_LIMIT')throw new ProjectApplicationError('STORAGE_FAILED','history response');if(items.length<=1)throw new ProjectApplicationError('INPUT_LIMIT','history object');items.pop();}}
  }
  async readReadyAsset(input:Context&{assetId:string;version:unknown;command:unknown}):Promise<never>{
    const subject=this.subject(input,'project:read');const projectId=input.projectId;const assetId=capture(stable,input.assetId);const version=capture(z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),input.version);const query=capture(WorkbenchReadyAssetQuerySchema,input.command);
    const binding=await this.options.identities.resolveProject({tenantId:subject.tenantId,projectId});const head=await this.readHead(binding.versionKey);const expectedRevision=query.expectedRevision??head.head.revision.number;
    if(head.head.revision.number!==expectedRevision)throw new ProjectApplicationError('SNAPSHOT_STALE','asset snapshot');
    const history=await this.options.reads.history({target:binding.versionKey,collection:'assets',objectId:assetId,expectedRevision,...(version<Number.MAX_SAFE_INTEGER?{beforeVersion:version+1}:{}),limit:1});
    const row=history?.items[0];if(!row||row.version!==version||row.value===null)throw new ProjectApplicationError('NOT_FOUND','asset version');
    if(!Asset.safeParse(row.value).success)throw new ProjectApplicationError('STORAGE_FAILED','asset version record');
    // A stored ready flag and path do not prove an authorized, archived media capability.
    throw new ProjectApplicationError('ASSET_NOT_READY','asset bytes capability unavailable');
  }
  async listCandidates(input:Context&{runId?:string;cursor?:string;limit?:number}){
    const subject=this.subject(input,'project:read');const projectId=input.projectId;const query=capture(WorkbenchCandidateListQuerySchema,{...(input.runId===undefined?{}:{runId:input.runId}),...(input.cursor===undefined?{}:{cursor:input.cursor}),...(input.limit===undefined?{}:{limit:input.limit})});
    const binding=await this.options.identities.resolveProject({tenantId:subject.tenantId,projectId});
    return this.options.intents.listCandidateHeaders({scope:{tenantId:subject.tenantId,projectId},target:binding.versionKey,subjectId:subject.userId,...query});
  }
  async candidate(input:Context&{candidateId:string}){return (await this.candidateData(input)).detail;}
  /** Compare immutable previews against one captured native state; never rebuild snapshots from object history. */
  async compareCandidates(input:Context&{command:unknown}){
    const command=capture(WorkbenchCompareSchema,input.command),subject=this.subject(input,'project:read'),projectId=input.projectId;
    const binding=await this.options.identities.resolveProject({tenantId:subject.tenantId,projectId}),stored=await this.read(binding.versionKey);this.checkBase(stored,command);
    const capabilities=await this.readCapabilities(subject,projectId);
    const side=async(selector:typeof command.left):Promise<{snapshot:typeof stored.state.head;view:WorkbenchCompareResult['left']}>=>{
      if(selector.kind==='head')return {snapshot:stored.state.head,view:{kind:'head',revision:stored.state.head.revision.number}};
      const native=stored.state.changes.find(row=>row.request.id===selector.candidateId);if(!native)throw new ProjectApplicationError('NOT_FOUND','comparison candidate');
      if(!native.preview)throw new ProjectApplicationError('CONFLICT','comparison preview unavailable');
      const scope={tenantId:subject.tenantId,projectId},intent=await this.options.intents.candidateForChange({scope,changeId:selector.candidateId});
      if(intent&&(!sameTarget(intent.target,binding.versionKey)||projectIntentDigest(intent.request)!==projectIntentDigest(native.request)))throw new ProjectApplicationError('STORAGE_FAILED','comparison source binding');
      const preparation=intent?await this.options.intents.readPreparationReceipt({scope,applicationId:intent.applicationId}):null;
      const detail=projectCandidateDetail({projectKey:projectId,state:stored.state,writeVersion:stored.writeVersion,candidateId:selector.candidateId,intent,preparation,canReview:capabilities.canReview,sourceState:await this.sourceState(intent)});
      const {candidateId,status,managed,source,baseRevision,issues,warnings,blockingReasons}=detail;
      return {snapshot:native.preview,view:{kind:'candidate',candidateId,status,managed,source,baseRevision,issues,warnings,blockingReasons}};
    };
    const left=await side(command.left),right=await side(command.right);
    const result=WorkbenchCompareResultSchema.parse({contractVersion:1,projectKey:projectId,projectId:binding.versionKey.projectId,snapshotRevision:stored.state.head.revision.number,writeVersion:stored.writeVersion,left:left.view,right:right.view,differences:compareVersionSnapshots(left.snapshot,right.snapshot).map(redactDifference)});
    try{return freeze(snapshotJson(result,983040,65536)) as WorkbenchCompareResult;}catch(error){if(error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT')throw new ProjectApplicationError('INPUT_LIMIT','comparison response');throw error;}
  }
  private async selectionRequest(authority:Awaited<ReturnType<ProjectApplication['authority']>>,candidateId:string,command:WorkbenchSelectionInput){
    const stored=await this.read(authority.versionKey);this.checkBase(stored,command);
    const origin=await this.options.intents.candidateForChange({scope:authority.scope,changeId:candidateId});
    if(!origin)throw new ProjectApplicationError('SOURCE_POLICY_MISSING','selection source');
    if(!sameTarget(origin.target,authority.versionKey))throw new ProjectApplicationError('STORAGE_FAILED','selection target');
    const native=stored.state.changes.find(row=>row.request.id===candidateId);
    if(!origin.request||!native||projectIntentDigest(origin.request)!==projectIntentDigest(native.request))throw new ProjectApplicationError('STORAGE_FAILED','selection original request');
    // A single immutable source link is sufficient here; nested selections require an explicit future lineage contract.
    if(origin.derivation)throw new ProjectApplicationError('CONFLICT','nested selection');
    if(await this.sourceState(origin)!=='current')throw new ProjectApplicationError('CONFLICT','selection source no longer current');
    const request=selectChangeOperations(stored.state,{sourceChangeId:candidateId,operationIds:command.operationIds,changeId:command.changeId,author:authority.principal});
    if(origin.source.kind==='manual')this.manualPolicy(request,stored);
    return {stored,origin,request};
  }
  async previewSelection(input:Context&{candidateId:string;command:unknown}){
    const command=capture(WorkbenchSelectionSchema,input.command),candidateId=capture(stable,input.candidateId),authority=await this.authority(input,'candidate:write');
    const {stored,request}=await this.selectionRequest(authority,candidateId,command);
    return projectPreview({state:stored.state,writeVersion:stored.writeVersion,result:submitChangeSet(stored.state,request),candidateId:request.id});
  }
  async prepareSelection(input:Context&{candidateId:string;command:unknown}){
    const command=capture(WorkbenchSelectionSchema,input.command),candidateId=capture(stable,input.candidateId),authority=await this.authority(input,'candidate:write');
    const context={subject:authority.subject,projectId:authority.scope.projectId},digest=this.digest(authority,'selection',{candidateId,command});
    const existing=await this.existing(authority,command.applicationId,digest);if(existing)return this.finishCandidate(context,existing);
    const {origin,request}=await this.selectionRequest(authority,candidateId,command);
    // The existing native transaction records validation failures with their actual receipt; a failed selection is never adoptable.
    const derivation={sourceChangeId:candidateId,requestDigest:projectIntentDigest(origin.request),operationIds:request.ops.map(op=>op.op_id)};
    const saved=await this.options.intents.putCandidate({version:1,scope:authority.scope,applicationId:command.applicationId,actor:authority.actor,target:authority.versionKey,commandDigest:digest,source:origin.source,derivation,expectation:expectation(command),changeId:request.id,request});
    return this.finishCandidate(context,saved);
  }
  async upgradeCandidate(input:Context&{candidateId:string}){
    const {intent,detail}=await this.candidateData(input,true),op=intent!.request!.ops[0]!;
    if(op.op!=='upgrade_schema')throw new ProjectApplicationError('STORAGE_FAILED','upgrade operation');
    return OutlineUpgradeCandidateSchema.parse({contractVersion:1,from:op.from,to:op.to,candidate:detail});
  }
  private async candidateData(input:Context&{candidateId:string},upgradeOnly=false){
    const subject=this.subject(input,'project:read');const candidateId=capture(stable,input.candidateId);const projectId=input.projectId;
    const binding=await this.options.identities.resolveProject({tenantId:subject.tenantId,projectId});const scope={tenantId:subject.tenantId,projectId};
    const intent=await this.options.intents.candidateForChange({scope,changeId:candidateId});
    if(intent&&!sameTarget(intent.target,binding.versionKey))throw new ProjectApplicationError('STORAGE_FAILED','candidate target');
    if(upgradeOnly&&(!intent||intent.source.kind!=='manual'||intent.request?.ops.length!==1||intent.request.ops[0]?.op!=='upgrade_schema'))throw new ProjectApplicationError('NOT_FOUND','schema upgrade candidate');
    const stored=await this.read(binding.versionKey);const preparation=intent?await this.options.intents.readPreparationReceipt({scope,applicationId:intent.applicationId}):null;
    if(upgradeOnly){const native=stored.state.changes.find(change=>change.request.id===candidateId);if(native&&projectIntentDigest(native.request)!==projectIntentDigest(intent!.request))throw new ProjectApplicationError('STORAGE_FAILED','upgrade native request');}
    let canReview=permissionsFor(subject,this.options.tenantId,projectId).includes('candidate:review');
    if(canReview){try{await this.options.identities.resolvePrincipal({tenantId:subject.tenantId,kind:'user',key:subject.userId});}catch(error){if(error instanceof ProjectIdentityError&&error.code==='PRINCIPAL_BINDING_MISSING')canReview=false;else throw error;}}
    const sourceState=await this.sourceState(intent);
    return {intent,detail:projectCandidateDetail({projectKey:projectId,state:stored.state,writeVersion:stored.writeVersion,candidateId,intent,preparation,canReview,sourceState})};
  }
  private async sourceState(intent:CandidateIntent|null):Promise<'current'|'stale'|'unavailable'>{
    let sourceState:'current'|'stale'|'unavailable'='current';
    if(intent?.source.kind==='development'){
      const source=intent.source.source;
      try{
        const progress=await this.options.development.store.read({tenantId:source.tenantId,projectId:source.projectId,runId:source.runId});
        const current=await this.options.development.store.isCurrent({tenantId:source.tenantId,projectId:source.projectId,runId:source.runId});
        sourceState=current&&progress.run.digest===source.runDigest&&progress.run.brief.digest===source.briefDigest&&progress.foundation.review?.status==='reviewed'&&progress.foundation.review.digest===source.foundationReviewDigest&&progress.episodes.review?.status==='reviewed'&&progress.episodes.review.digest===source.episodesReviewDigest?'current':'stale';
      }catch{sourceState='unavailable';}
    }
    return sourceState;
  }
  private manualPolicy(request:ChangeSet,stored:StoredVersionState):void{
    // A manual command cannot manufacture or rewrite a reviewed development source receipt.
    // Inspect commands directly: dependent split IDs can make a side-effect-free preview unavailable.
    const head=stored.state.head as unknown as Record<string,unknown>;
    for(const op of request.ops){
      // Outline evidence needs its own transactional source guard; the generic manual path must remain closed until then.
      if('collection' in op&&(OUTLINE_COLLECTIONS as readonly string[]).includes(op.collection))throw new ProjectApplicationError('SOURCE_POLICY_MISSING','manual outline source');
      // Four-ledger writes require their own complete reviewed source; the generic path cannot grant that authority.
      if('collection' in op&&op.collection==='continuity_snapshots')throw new ProjectApplicationError('SOURCE_POLICY_MISSING','manual continuity source');
      const targetId=op.op==='lock'?op.target:op.op==='unlock'?(head['locks'] as {id:string;target:string}[]).find(lock=>lock.id===op.lock_id)?.target:undefined;
      if(targetId&&((head['continuity_snapshots']??[]) as {id:string}[]).some(row=>row.id===targetId))throw new ProjectApplicationError('SOURCE_POLICY_MISSING','manual continuity source');
      if(!('collection' in op)||!['development_plans','episode_plans'].includes(op.collection))continue;
      if(op.op==='add')throw new ProjectApplicationError('SOURCE_POLICY_MISSING','manual development source');
      if(op.op!=='replace'&&op.op!=='update')continue;
      const before=(head[op.collection]??[]) as {id:string;source:unknown}[];const previous=before.find(row=>row.id===op.target);
      const fields=op.op==='replace'?op.value:op.set;
      if(op.op==='update'&&!Object.hasOwn(fields,'source'))continue;
      if(!previous||!Object.hasOwn(fields,'source')||projectIntentDigest(previous.source)!==projectIntentDigest(fields['source']))throw new ProjectApplicationError('SOURCE_POLICY_MISSING','manual development source');
    }
  }
  async previewChange(input:Context&{command:unknown}){
    const command=capture(WorkbenchPreviewSchema,input.command);const authority=await this.authority(input,'candidate:write');
    if(command.change.author.kind!=='user'||command.change.author.id!==authority.actor.id)throw new AccessError('FORBIDDEN');
    const stored=await this.read(authority.versionKey);this.checkBase(stored,command);this.manualPolicy(command.change,stored);
    return projectPreview({state:stored.state,writeVersion:stored.writeVersion,result:submitChangeSet(stored.state,command.change),candidateId:command.change.id});
  }
  private digest(authority:Awaited<ReturnType<ProjectApplication['authority']>>,action:string,command:unknown,runId?:string){
    return projectIntentDigest({version:1,scope:authority.scope,target:authority.versionKey,actor:authority.actor,action,command,...(runId===undefined?{}:{runId})});
  }
  private async existing(authority:Awaited<ReturnType<ProjectApplication['authority']>>,applicationId:string,commandDigest:string){
    const saved=await this.options.intents.findCandidate({scope:authority.scope,applicationId});
    if(saved&&(saved.commandDigest!==commandDigest||saved.actor.id!==authority.actor.id||saved.actor.key!==authority.actor.key||!sameTarget(saved.target,authority.versionKey)))throw new ProjectApplicationError('CONFLICT','application command identity');return saved;
  }
  private async finishCandidate(input:Context,intent:CandidateIntent){
    const key={scope:intent.scope,applicationId:intent.applicationId};
    if(!await this.options.intents.readPreparationReceipt(key)){
      if(!intent.request)throw new ProjectApplicationError('STORAGE_FAILED','unchanged preparation receipt');
      await this.options.versions.submitWithReceipt(intent.target,intent.request,{expectation:intent.expectation,newId:this.options.newId},this.options.intents.preparationReceiptWriter(intent));
    }
    return this.candidate({...input,candidateId:intent.changeId});
  }
  async prepareDevelopment(input:Context&{runId:string;command:unknown}){
    const command=capture(DevelopmentCandidatePrepareSchema,input.command);const runId=capture(Id,input.runId);const authority=await this.authority(input,'candidate:write');
    const context={subject:authority.subject,projectId:authority.scope.projectId};
    const digest=this.digest(authority,'development',command,runId);const existing=await this.existing(authority,command.applicationId,digest);if(existing)return this.finishCandidate(context,existing);
    const stored=await this.read(authority.versionKey);this.checkBase(stored,command);if(stored.state.head.schema_version==='0.5.0-draft')throw new ProjectApplicationError('SCHEMA_UPGRADE_REQUIRED','development preparation');
    const source={...authority.scope,runId,runDigest:command.runDigest,briefDigest:command.briefDigest,foundationReviewDigest:command.foundationReviewDigest,episodesReviewDigest:command.episodesReviewDigest};
    const prepared=await this.options.development.identities.prepare({source,target:authority.versionKey});
    const foundation=prepared.progress.foundation.review;const episodes=prepared.progress.episodes.review;
    if(foundation?.status!=='reviewed'||episodes?.status!=='reviewed')throw new ProjectApplicationError('CONFLICT','reviewed development source');
    const mapReviewer=async(key:string)=>({key,id:(await this.options.identities.resolvePrincipal({tenantId:authority.scope.tenantId,kind:'user',key})).principal.id});
    const reviewers={foundation:await mapReviewer(foundation.actorId),episodes:await mapReviewer(episodes.actorId)};
    const draft=prepareDevelopmentDraft({progress:prepared.progress,source,identities:prepared.identities,reviewers,head:stored.state.head});const changeId=this.options.newId();
    const request=draft.operations.length?finalizeDevelopmentChangeSet({draft,changeSetId:changeId,author:{kind:'user',id:authority.actor.id},operationIds:draft.operations.map(row=>({slot:row.slot,id:this.options.newId()}))}):null;
    const saved=await this.options.intents.putCandidate({version:1,scope:authority.scope,applicationId:command.applicationId,actor:authority.actor,target:authority.versionKey,commandDigest:digest,expectation:expectation(command),changeId,request,source:{kind:'development',mapperVersion:1,source,identities:prepared.identities,reviewers}} satisfies CandidateIntentBody);
    return this.finishCandidate(context,saved);
  }
  async submitCandidate(input:Context&{command:unknown}){
    const command=capture(WorkbenchSubmitSchema,input.command);const authority=await this.authority(input,'candidate:write');
    const context={subject:authority.subject,projectId:authority.scope.projectId};
    if(command.change.author.kind!=='user'||command.change.author.id!==authority.actor.id)throw new AccessError('FORBIDDEN');
    const digest=this.digest(authority,'manual',command);const existing=await this.existing(authority,command.applicationId,digest);if(existing)return this.finishCandidate(context,existing);
    const stored=await this.read(authority.versionKey);this.checkBase(stored,command);this.manualPolicy(command.change,stored);
    const saved=await this.options.intents.putCandidate({version:1,scope:authority.scope,applicationId:command.applicationId,actor:authority.actor,target:authority.versionKey,commandDigest:digest,source:{kind:'manual'},expectation:expectation(command),changeId:command.change.id,request:command.change} satisfies CandidateIntentBody);
    return this.finishCandidate(context,saved);
  }
  async prepareUpgrade(input:Context&{command:unknown}){
    const command=capture(WorkbenchUpgradeSchema,input.command);const authority=await this.authority(input,'candidate:write');
    const context={subject:authority.subject,projectId:authority.scope.projectId};
    const digest=this.digest(authority,'schema-upgrade',command);const existing=await this.existing(authority,command.applicationId,digest);if(existing)return this.finishCandidate(context,existing);
    const stored=await this.read(authority.versionKey);this.checkBase(stored,command);if(stored.state.head.schema_version==='0.8.0-draft')throw new ProjectApplicationError('CONFLICT','schema already upgraded');
    const from=stored.state.head.schema_version,to=from==='0.5.0-draft'?'0.6.0-draft':from==='0.6.0-draft'?'0.7.0-draft':'0.8.0-draft';
    const request=ChangeSet.parse({schema_version:to,id:this.options.newId(),author:{kind:'user',id:authority.actor.id},base_revision:stored.state.head.revision.number,base_revisions:[],status:'candidate',ops:[{op_id:this.options.newId(),op:'upgrade_schema',from,to}]});
    const result=submitChangeSet(stored.state,request);if(result.status!=='candidate')throw new ProjectApplicationError('CONFLICT','pending changes block schema upgrade');
    const saved=await this.options.intents.putCandidate({version:1,scope:authority.scope,applicationId:command.applicationId,actor:authority.actor,target:authority.versionKey,commandDigest:digest,source:{kind:'manual'},expectation:expectation(command),changeId:request.id,request});return this.finishCandidate(context,saved);
  }
  async adoptCandidate(input:Context&{candidateId:string;requestId:string;command:unknown}){return this.decide(input,'adopt');}
  async rejectCandidate(input:Context&{candidateId:string;requestId:string;command:unknown}){return this.decide(input,'reject');}
  private async decide(input:Context&{candidateId:string;requestId:string;command:unknown},action:'adopt'|'reject'){
    // Review authorization precedes all intent lookups, including exact historical ACK recovery.
    const projectId=input.projectId;const subject=this.subject({subject:input.subject,projectId},'candidate:review');
    const candidateId=capture(stable,input.candidateId);const requestId=capture(Id,input.requestId);
    const command=action==='adopt'?capture(WorkbenchAdoptSchema,input.command):capture(WorkbenchRejectSchema,input.command);
    const authority=await this.authority({subject,projectId},'candidate:review');
    const candidate=await this.options.intents.candidateForChange({scope:authority.scope,changeId:candidateId});
    if(!candidate)throw new ProjectApplicationError('SOURCE_POLICY_MISSING','unmanaged candidate decision');
    if(!sameTarget(candidate.target,authority.versionKey))throw new ProjectApplicationError('STORAGE_FAILED','decision target');
    if(!candidate.request)throw new ProjectApplicationError('CONFLICT','unchanged candidate decision');
    const key={scope:authority.scope,actorKind:authority.actor.kind,actorKey:authority.actor.key,requestId};const previous=await this.options.intents.findDecision(key);
    const body:DecisionIntentBody={version:1,scope:authority.scope,requestId,actor:authority.actor,changeId:candidateId,action,adoptionScope:command.scope,expectation:expectation(command),reason:'reason' in command&&typeof command.reason==='string'?command.reason:null,at:previous?.at??this.options.now?.()??new Date().toISOString()};
    const decision=await this.options.intents.putDecision(body);const receipt=await this.options.intents.readDecisionReceipt(key);if(receipt)return receipt;
    if(action==='adopt'&&candidate.source.kind==='manual')this.manualPolicy(candidate.request,await this.read(authority.versionKey));
    const options={actor:authority.principal,scope:decision.adoptionScope,at:decision.at,authorize:authority.authorize,expectation:decision.expectation};const writer=this.options.intents.decisionReceiptWriter(decision,candidate);
    if(action==='adopt'){
      const guard=candidate.source.kind==='development'?createDevelopmentSourceGuard(this.options.development.store,candidate.source.source):async()=>{};
      await this.options.versions.adoptGuarded(authority.versionKey,candidateId,options,guard,writer);
    }else await this.options.versions.rejectWithReceipt(authority.versionKey,candidateId,options,decision.reason!,writer);
    const saved=await this.options.intents.readDecisionReceipt(key);if(!saved)throw new ProjectApplicationError('STORAGE_FAILED','decision receipt');return saved;
  }
}
