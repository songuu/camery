import {z} from 'zod';
import {AccessError,authorize,parseIdentity,permissionsFor} from '@camery/access';
import type {Permission,SessionIdentity} from '@camery/access';
import {StableId} from '@camery/ir';
import {OutlinePrepareCommandSchema,OutlineAdoptCommandSchema,OutlineRejectCommandSchema,OutlineCandidateSchema,OutlineCandidateListQuerySchema,OutlineReceiptQuerySchema} from '@camery/ir/outline-adoption';
import {captureOutlineAdoptionProgress,prepareOutlineMappingDraft,createOutlineSourceGuard} from '@camery/script/outline/node';
import {OutlineError} from '@camery/script/outline/contracts';
import type {StoredVersionState,VersionProjectKey} from '@camery/versioning/node';
import {VersionPersistenceError} from '@camery/versioning/node';
import {ProjectIdentityScopeSchema,ProjectIdentityError} from './contracts.js';
import type {OutlineAdoptionOptions} from './outline-adoption-options.js';
import {ProjectApplicationError} from './intent-contracts.js';
import type {OutlineCandidateIntent,OutlineDecisionIntentBody} from './outline-intent-contracts.js';
import {captureOutlineIntent,outlineIntentDigest} from './outline-intent-data.js';
import {resolveProjectAuthority} from './authority.js';
import {outlineAcknowledgement,outlineReceiptPage} from './outline-adoption-projection.js';

interface Context{subject:unknown;projectId:string}
const id=ProjectIdentityScopeSchema.shape.projectId,stable=StableId.refine(value=>value.length===26);
const capture=<S extends z.ZodType>(schema:S,input:unknown)=>captureOutlineIntent(schema,input,'outline adoption command',16384);
const expected=(value:{expectedSnapshotRevision:number;expectedWriteVersion:number})=>({expectedSnapshotRevision:value.expectedSnapshotRevision,expectedWriteVersion:value.expectedWriteVersion});
const sameTarget=(a:VersionProjectKey,b:VersionProjectKey)=>a.tenantId===b.tenantId&&a.projectId===b.projectId;
function safeOperation<A extends unknown[],R>(operation:string,action:(...args:A)=>Promise<R>):(...args:A)=>Promise<R>{
  return async(...args)=>{try{return await action(...args);}catch(error){let known=false;try{known=error instanceof AccessError||error instanceof ProjectIdentityError||error instanceof ProjectApplicationError||error instanceof OutlineError||error instanceof VersionPersistenceError;}catch{/* Unknown dependency proxies never supply public diagnostics. */}if(known)throw error;throw new ProjectApplicationError('STORAGE_FAILED',operation);}};
}

/** Authenticated host composition. Model output and source hashes never authorize a formal write. */
export class OutlineAdoptionApplication{
  private readonly options:OutlineAdoptionOptions;
  constructor(options:OutlineAdoptionOptions){
    this.options=Object.freeze({...options,outline:Object.freeze({...options.outline})});
    this.prepareOutline=safeOperation('outline preparation',this.prepareOutline.bind(this));this.candidate=safeOperation('outline candidate detail',this.candidate.bind(this));this.listCandidates=safeOperation('outline candidate list',this.listCandidates.bind(this));
    this.adoptCandidate=safeOperation('outline adoption',this.adoptCandidate.bind(this));this.rejectCandidate=safeOperation('outline rejection',this.rejectCandidate.bind(this));this.receiptMessages=safeOperation('outline receipt messages',this.receiptMessages.bind(this));
  }
  private context(input:Context,permission:Permission){const subject=parseIdentity(input.subject),projectId=capture(id,input.projectId);authorize(subject,this.options.tenantId,projectId,permission);return {subject,projectId};}
  private async authority(input:Context,permission:Permission){const context=this.context(input,permission),bound=await resolveProjectAuthority({identities:this.options.identities,...context,permission});return {...bound,...context,actor:{kind:'user' as const,key:context.subject.userId,id:bound.principal.id}};}
  private async target(subject:SessionIdentity,projectId:string){
    const binding=await this.options.identities.resolveProject({tenantId:subject.tenantId,projectId});
    if(binding.tenantId!==subject.tenantId||binding.projectId!==projectId||!stable.safeParse(binding.versionKey.tenantId).success||!stable.safeParse(binding.versionKey.projectId).success)throw new ProjectApplicationError('STORAGE_FAILED','outline project binding');return binding.versionKey;
  }
  private async read(target:VersionProjectKey):Promise<StoredVersionState>{const stored=await this.options.versions.read(target);if(!stored)throw new ProjectApplicationError('NOT_FOUND','outline formal project');if(stored.state.head.project.id!==target.projectId)throw new ProjectApplicationError('STORAGE_FAILED','outline formal project binding');return stored;}
  private bound(intent:OutlineCandidateIntent,scope:{tenantId:string;projectId:string},target:VersionProjectKey):void{
    if(intent.scope.tenantId!==scope.tenantId||intent.scope.projectId!==scope.projectId||!sameTarget(intent.target,target))throw new ProjectApplicationError('STORAGE_FAILED','outline candidate binding');
  }
  private async required(scope:{tenantId:string;projectId:string},target:VersionProjectKey,candidateId:string){const intent=await this.options.intents.candidateForChange({scope,changeId:candidateId});if(!intent)throw new ProjectApplicationError('NOT_FOUND','outline candidate');this.bound(intent,scope,target);if(intent.changeId!==candidateId)throw new ProjectApplicationError('STORAGE_FAILED','outline candidate address');return intent;}
  private async reviewer(tenantId:string,key:string){
    const resolved=await this.options.identities.resolvePrincipal({tenantId,kind:'user',key});
    if(resolved.tenantId!==tenantId||resolved.key!==key||resolved.kind!=='user'||resolved.principal.kind!=='user'||!stable.safeParse(resolved.principal.id).success)throw new ProjectApplicationError('STORAGE_FAILED','outline human reviewer binding');return {key,id:resolved.principal.id};
  }
  private async finish(context:Context,intent:OutlineCandidateIntent){
    const key={scope:intent.scope,applicationId:intent.applicationId};
    if(!await this.options.intents.readPreparationReceipt(key)){
      if(!intent.request)throw new ProjectApplicationError('STORAGE_FAILED','outline unchanged original receipt');
      await this.options.versions.submitWithReceipt(intent.target,intent.request,{expectation:intent.expectation},this.options.intents.preparationReceiptWriter(intent));
    }
    return this.candidate({...context,candidateId:intent.changeId});
  }
  async prepareOutline(input:Context&{runId:string;command:unknown}){
    const command=capture(OutlinePrepareCommandSchema,input.command),runId=capture(id,input.runId),authority=await this.authority(input,'candidate:write');
    const source={...authority.scope,runId,runDigest:command.runDigest,briefDigest:command.briefDigest,candidateDigest:command.candidateDigest,reviewDigest:command.reviewDigest,sourceDigest:command.sourceDigest};
    const commandDigest=outlineIntentDigest({version:1,scope:authority.scope,target:authority.versionKey,actor:authority.actor,runId,command}),key={scope:authority.scope,applicationId:command.applicationId};
    const existing=await this.options.intents.findCandidate(key);
    if(existing){this.bound(existing,authority.scope,authority.versionKey);if(existing.applicationId!==command.applicationId||existing.actor.id!==authority.actor.id||existing.actor.key!==authority.actor.key||existing.commandDigest!==commandDigest)throw new ProjectApplicationError('CONFLICT','outline application identity');return this.finish(authority,existing);}
    const stored=await this.read(authority.versionKey);
    if(stored.state.head.revision.number!==command.expectedSnapshotRevision)throw new ProjectApplicationError('SNAPSHOT_STALE','outline mapping base');
    if(stored.writeVersion!==command.expectedWriteVersion)throw new ProjectApplicationError('WRITE_VERSION_CONFLICT','outline mapping base');
    if(stored.state.head.schema_version!=='0.7.0-draft'&&stored.state.head.schema_version!=='0.8.0-draft')throw new ProjectApplicationError('SCHEMA_UPGRADE_REQUIRED','outline formal mapping');
    const prepared=await this.options.outline.identities.prepare({source,target:authority.versionKey}),progress=captureOutlineAdoptionProgress(source,prepared.progress),reviewer=await this.reviewer(authority.scope.tenantId,progress.review.actorId);
    const draft=prepareOutlineMappingDraft({progress,source,identities:prepared.identities,reviewer,head:stored.state.head}),changeId=this.options.newId();
    const saved=await this.options.intents.putCandidate({version:1,scope:authority.scope,applicationId:command.applicationId,actor:authority.actor,target:authority.versionKey,commandDigest,source:{kind:'outline',mapperVersion:1,source,identities:prepared.identities,reviewer},expectation:expected(command),changeId,draft,operationIds:draft.operations.map(row=>({slot:row.slot,id:this.options.newId()}))});
    this.bound(saved,authority.scope,authority.versionKey);return this.finish(authority,saved);
  }
  async listCandidates(input:Context&{command:unknown}){const query=capture(OutlineCandidateListQuerySchema,input.command),context=this.context(input,'project:read'),target=await this.target(context.subject,context.projectId);return this.options.catalog.list({scope:{tenantId:context.subject.tenantId,projectId:context.projectId},target,subjectId:context.subject.userId,...query});}
  private async sourceState(intent:OutlineCandidateIntent):Promise<'current'|'stale'|'unavailable'>{
    const source=intent.source.source,key={tenantId:source.tenantId,projectId:source.projectId,runId:source.runId};
    try{const progress=await this.options.outline.store.read(key);captureOutlineAdoptionProgress(source,progress);return await this.options.outline.store.isCurrent(key)===true?'current':'stale';}
    catch(error){return error instanceof OutlineError&&['CONFLICT','INCOMPLETE','NOT_FOUND'].includes(error.code)?'stale':'unavailable';}
  }
  async candidate(input:Context&{candidateId:string}){
    const candidateId=capture(stable,input.candidateId),context=this.context(input,'project:read'),target=await this.target(context.subject,context.projectId),scope={tenantId:context.subject.tenantId,projectId:context.projectId};
    const intent=await this.required(scope,target,candidateId),stored=await this.read(target),receipt=await this.options.intents.readPreparationReceipt({scope,applicationId:intent.applicationId}),native=stored.state.changes.find(change=>change.request.id===candidateId);
    if(native&&(!intent.request||outlineIntentDigest(native.request)!==outlineIntentDigest(intent.request)))throw new ProjectApplicationError('STORAGE_FAILED','outline native candidate request');
    let canReview=permissionsFor(context.subject,this.options.tenantId,context.projectId).includes('candidate:review');
    if(canReview)try{await this.reviewer(scope.tenantId,context.subject.userId);}catch(error){if(error instanceof ProjectIdentityError&&error.code==='PRINCIPAL_BINDING_MISSING')canReview=false;else throw error;}
    const status=native?.status??receipt?.status??'prepared';
    return OutlineCandidateSchema.parse({contractVersion:1,projectKey:context.projectId,candidateId,applicationId:intent.applicationId,runId:intent.source.source.runId,status,snapshotRevision:stored.state.head.revision.number,writeVersion:stored.writeVersion,baseRevision:intent.expectation.expectedSnapshotRevision,operationCount:intent.draft.operations.length,sourceState:await this.sourceState(intent),canReview:canReview&&intent.request!==null&&native?.status==='candidate',preparation:receipt?outlineAcknowledgement(context.projectId,candidateId,'preparation',intent.applicationId,receipt):null});
  }
  async adoptCandidate(input:Context&{candidateId:string;requestId:string;command:unknown}){return this.decide(input,'adopt');}
  async rejectCandidate(input:Context&{candidateId:string;requestId:string;command:unknown}){return this.decide(input,'reject');}
  private async decide(input:Context&{candidateId:string;requestId:string;command:unknown},action:'adopt'|'reject'){
    const command=action==='adopt'?capture(OutlineAdoptCommandSchema,input.command):capture(OutlineRejectCommandSchema,input.command),candidateId=capture(stable,input.candidateId),requestId=capture(id,input.requestId),authority=await this.authority(input,'candidate:review');
    const candidate=await this.required(authority.scope,authority.versionKey,candidateId);if(!candidate.request)throw new ProjectApplicationError('CONFLICT','outline unchanged decision');
    const key={scope:authority.scope,actorKind:'user' as const,actorKey:authority.actor.key,requestId},previous=await this.options.intents.findDecision(key);
    const body:OutlineDecisionIntentBody={version:1,scope:authority.scope,requestId,actor:authority.actor,changeId:candidateId,action,adoptionScope:{kind:'project',id:authority.versionKey.projectId},expectation:expected(command),reason:'reason' in command&&typeof command.reason==='string'?command.reason:null,at:previous?.at??this.options.now?.()??new Date().toISOString()};
    const decision=await this.options.intents.putDecision(body);let receipt=await this.options.intents.readDecisionReceipt(key);
    if(!receipt){const options={actor:authority.principal,scope:decision.adoptionScope,at:decision.at,authorize:authority.authorize,expectation:decision.expectation},writer=this.options.intents.decisionReceiptWriter(decision,candidate);
      if(action==='adopt')await this.options.versions.adoptGuarded(authority.versionKey,candidateId,options,createOutlineSourceGuard(this.options.outline.store,candidate.source.source),writer);
      else await this.options.versions.rejectWithReceipt(authority.versionKey,candidateId,options,decision.reason!,writer);
      receipt=await this.options.intents.readDecisionReceipt(key);
    }
    if(!receipt)throw new ProjectApplicationError('STORAGE_FAILED','outline decision receipt');return outlineAcknowledgement(authority.scope.projectId,candidateId,'decision',requestId,receipt);
  }
  async receiptMessages(input:Context&{candidateId:string;command:unknown}){
    const query=capture(OutlineReceiptQuerySchema,input.command),candidateId=capture(stable,input.candidateId),context=this.context(input,'project:read'),target=await this.target(context.subject,context.projectId),scope={tenantId:context.subject.tenantId,projectId:context.projectId},intent=await this.required(scope,target,candidateId);
    let receipt;
    if(query.kind==='preparation'){
      if(query.requestId!==intent.applicationId)throw new ProjectApplicationError('INVALID_INPUT','outline preparation receipt address');receipt=await this.options.intents.readPreparationReceipt({scope,applicationId:intent.applicationId});
    }else{
      const key={scope,actorKind:'user' as const,actorKey:context.subject.userId,requestId:query.requestId},decision=await this.options.intents.findDecision(key);
      if(!decision||decision.changeId!==candidateId)throw new ProjectApplicationError('NOT_FOUND','outline decision receipt');receipt=await this.options.intents.readDecisionReceipt(key);
    }
    if(!receipt)throw new ProjectApplicationError('NOT_FOUND','outline receipt');if(receipt.changeId!==candidateId)throw new ProjectApplicationError('STORAGE_FAILED','outline receipt address');return outlineReceiptPage({subjectId:context.subject.userId,intent,receipt,query});
  }
}
