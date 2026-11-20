import {z} from 'zod';
import {AccessError,authorize,parseIdentity,permissionsFor} from '@camery/access';
import type {SessionIdentity} from '@camery/access';
import {StableId} from '@camery/ir';
import {ScreenplayPrepareCommandSchema,ScreenplayAdoptCommandSchema,ScreenplayRejectCommandSchema,ScreenplayCandidateSchema,ScreenplayHandoffSchema} from '@camery/ir/screenplay-adoption';
import {CandidateReceiptQuerySchema} from '@camery/ir/candidate-receipts';
import {ScreenplayError} from '@camery/script/screenplay';
import {createScreenplayNativeSubmissionReceipt,createScreenplayNativeAdoptionHooks,prepareScreenplayNativeMapping,screenplayNativeSlots} from '@camery/script/screenplay/node';
import {VersionPersistenceError} from '@camery/versioning/node';
import type {VersionProjectKey,StoredVersionState} from '@camery/versioning/node';
import {ProjectIdentityError,ProjectIdentityScopeSchema} from './contracts.js';
import {ProjectApplicationError} from './intent-contracts.js';
import {resolveProjectAuthority} from './authority.js';
import {captureProjectCommand,projectCommandDigest} from './project-command-data.js';
import {createScreenplayProjectHost} from './screenplay-project-host.js';
import {SCREENPLAY_JOURNAL_BYTES} from './screenplay-intent-contracts.js';
import type {ScreenplayProjectIntent,ScreenplayProjectDecisionBody,ScreenplayProjectReceipt} from './screenplay-intent-contracts.js';
import {captureScreenplayExecution} from './screenplay-intent-receipts.js';
import {candidateAcknowledgement,candidateReceiptPage} from './candidate-action-projection.js';
import type {ScreenplayAdoptionOptions} from './screenplay-adoption-options.js';

interface Context{subject:unknown;projectId:string}
const stable=StableId.refine(value=>value.length===26),ordinary=ProjectIdentityScopeSchema.shape.projectId;
const capture=<S extends z.ZodType>(schema:S,input:unknown)=>captureProjectCommand(schema,input,'screenplay project command',16384);
const expected=(value:{expectedSnapshotRevision:number;expectedWriteVersion:number})=>({expectedSnapshotRevision:value.expectedSnapshotRevision,expectedWriteVersion:value.expectedWriteVersion});
const same=(a:unknown,b:unknown)=>projectCommandDigest(a,67108864)===projectCommandDigest(b,67108864);
const sameTarget=(a:VersionProjectKey,b:VersionProjectKey)=>a.tenantId===b.tenantId&&a.projectId===b.projectId;
function safeOperation<A extends unknown[],R>(operation:string,action:(...args:A)=>Promise<R>):(...args:A)=>Promise<R>{return async(...args)=>{try{return await action(...args);}catch(error){let known=false;try{known=error instanceof AccessError||error instanceof ProjectIdentityError||error instanceof ProjectApplicationError||error instanceof ScreenplayError||error instanceof VersionPersistenceError;}catch{/* Opaque dependency errors never supply public diagnostics. */}if(known)throw error;throw new ProjectApplicationError('STORAGE_FAILED',operation);}};}

/** Finalization of actual reviewed SC sources. Source proof and shared ACK always use the same native transaction. */
export class ScreenplayAdoptionApplication{
  private readonly options:ScreenplayAdoptionOptions;
  constructor(options:ScreenplayAdoptionOptions){
    this.options=Object.freeze({...options});
    this.prepareScreenplay=safeOperation('screenplay project preparation',this.prepareScreenplay.bind(this));this.candidate=safeOperation('screenplay candidate detail',this.candidate.bind(this));this.readBundle=safeOperation('screenplay candidate evidence',this.readBundle.bind(this));
    this.adoptCandidate=safeOperation('screenplay project adoption',this.adoptCandidate.bind(this));this.rejectCandidate=safeOperation('screenplay project rejection',this.rejectCandidate.bind(this));this.receiptMessages=safeOperation('screenplay receipt messages',this.receiptMessages.bind(this));this.handoff=safeOperation('screenplay ledger handoff',this.handoff.bind(this));
  }
  private context(input:Context,permission:'project:read'|'candidate:review'){
    const subject=parseIdentity(input.subject),projectId=capture(ordinary,input.projectId);authorize(subject,this.options.tenantId,projectId,permission);return {subject,projectId};
  }
  private async authority(input:Context){const context=this.context(input,'candidate:review'),bound=await resolveProjectAuthority({identities:this.options.identities,...context,permission:'candidate:review'});return {...bound,...context,actor:{kind:'user' as const,key:context.subject.userId,id:bound.principal.id}};}
  private async target(subject:SessionIdentity,projectId:string){const mapped=await this.options.identities.resolveProject({tenantId:subject.tenantId,projectId});if(mapped.tenantId!==subject.tenantId||mapped.projectId!==projectId||!stable.safeParse(mapped.versionKey.tenantId).success||!stable.safeParse(mapped.versionKey.projectId).success)throw new ProjectApplicationError('STORAGE_FAILED','screenplay project mapping');return Object.freeze({...mapped.versionKey});}
  private async read(target:VersionProjectKey):Promise<StoredVersionState>{const stored=await this.options.versions.read(target);if(!stored)throw new ProjectApplicationError('NOT_FOUND','screenplay native project');if(stored.state.head.project.id!==target.projectId)throw new ProjectApplicationError('STORAGE_FAILED','screenplay native project binding');return stored;}
  private now(){return this.options.now?.()??new Date().toISOString();}
  private bound(intent:ScreenplayProjectIntent,scope:{tenantId:string;projectId:string},target:VersionProjectKey){if(!same(intent.scope,scope)||!sameTarget(intent.target,target))throw new ProjectApplicationError('STORAGE_FAILED','screenplay journal target');}
  private checkBase(stored:StoredVersionState,command:{expectedSnapshotRevision:number;expectedWriteVersion:number}){
    if(stored.state.head.revision.number!==command.expectedSnapshotRevision)throw new ProjectApplicationError('SNAPSHOT_STALE','screenplay preparation base');
    if(stored.writeVersion!==command.expectedWriteVersion)throw new ProjectApplicationError('WRITE_VERSION_CONFLICT','screenplay preparation base');
  }
  private async finish(context:Context,intent:ScreenplayProjectIntent){
    const key={scope:intent.scope,applicationId:intent.applicationId};
    if(!await this.options.intents.readPreparationReceipt(key)){
      const subject=this.context(context,'candidate:review').subject,host=createScreenplayProjectHost(subject,this.options.tenantId,context.projectId,this.now(),true);
      const original=await this.options.source.sourceBinding({key:intent.sourceKey,target:intent.target},host);
      if(original)throw new ProjectApplicationError(original.mapping.request.id===intent.changeId?'STORAGE_FAILED':'CONFLICT','screenplay original preparation acknowledgement missing');
      const material=await this.options.source.materialize(intent,host);if(material.producer.kind==='pending_generation')throw new ProjectApplicationError('CONFLICT','screenplay generation delivery pending');
      const execution=material.execution,domain=this.options.scripts,sourceReceipt=createScreenplayNativeSubmissionReceipt(execution,domain,host),sharedReceipt=this.options.intents.preparationReceiptWriter(intent,execution,host);
      await this.options.versions.submitWithReceipt(intent.target,execution.mapping.request,{expectation:intent.expectation},async(client,result,actual)=>{await sourceReceipt(client,result,actual);await sharedReceipt(client,result,actual);});
      if(!await this.options.intents.readPreparationReceipt(key))throw new ProjectApplicationError('STORAGE_FAILED','screenplay original preparation receipt');
    }
    return this.candidate({...context,candidateId:intent.changeId});
  }
  async prepareScreenplay(input:Context&{command:unknown}){
    const command=capture(ScreenplayPrepareCommandSchema,input.command),authority=await this.authority(input),context={subject:authority.subject,projectId:authority.projectId};
    const commandDigest=projectCommandDigest({version:1,scope:authority.scope,target:authority.versionKey,actor:authority.actor,command},SCREENPLAY_JOURNAL_BYTES),key={scope:authority.scope,applicationId:command.applicationId},previous=await this.options.intents.findCandidate(key);
    if(previous){this.bound(previous,authority.scope,authority.versionKey);if(previous.commandDigest!==commandDigest||previous.actor.key!==authority.actor.key||previous.actor.id!==authority.actor.id)throw new ProjectApplicationError('CONFLICT','screenplay command identity');return this.finish(context,previous);}
    const stored=await this.read(authority.versionKey);this.checkBase(stored,command);
    const host=createScreenplayProjectHost(authority.subject,this.options.tenantId,authority.projectId,this.now(),true),sourceKey={...authority.scope,candidateId:command.sourceCandidateId};
    const source=await this.options.source.readReviewed({key:sourceKey,target:authority.versionKey},host),p=source.progress.preparation,review=source.progress.review!;
    if(p.digest!==command.preparationDigest||review.digest!==command.reviewDigest||p.source.native.snapshotRevision!==command.expectedSnapshotRevision||!same(source.head,stored.state.head))throw new ProjectApplicationError('CONFLICT','screenplay actual reviewed source');
    if(source.producer.kind==='pending_generation')throw new ProjectApplicationError('CONFLICT','screenplay generation delivery pending');
    if(await this.options.source.sourceBinding({key:sourceKey,target:authority.versionKey},host))throw new ProjectApplicationError('CONFLICT','screenplay source already has an original native candidate');
    const slots=screenplayNativeSlots(review.output.draft),changeId=this.options.newId(),ids=slots.map(slot=>({slot,id:this.options.newId()}));
    // Validate the complete compile before persisting identities; the returned winner is materialized again after a race.
    prepareScreenplayNativeMapping({head:source.head,context:p.context,candidate:p.candidate,review,target:authority.versionKey,changeId,author:authority.principal as {kind:'user';id:string},ids});
    const saved=await this.options.intents.putCandidate({version:1,scope:authority.scope,applicationId:command.applicationId,actor:authority.actor,target:authority.versionKey,sourceKey,preparationDigest:p.digest,reviewDigest:review.digest,packageDigest:p.source.native.packageDigest,contextDigest:p.source.contextDigest,episodeId:p.context.episode.id,expectation:expected(command),commandDigest,changeId,slotsDigest:projectCommandDigest(slots,8388608),ids:ids.map(row=>row.id)});
    this.bound(saved,authority.scope,authority.versionKey);return this.finish(context,saved);
  }
  private async data(input:Context&{candidateId:string}){
    const context=this.context(input,'project:read'),candidateId=capture(stable,input.candidateId),scope={tenantId:context.subject.tenantId,projectId:context.projectId},target=await this.target(context.subject,context.projectId),stored=await this.read(target),intent=await this.options.intents.candidateForChange({scope,changeId:candidateId});
    if(intent)this.bound(intent,scope,target);
    const host=createScreenplayProjectHost(context.subject,this.options.tenantId,context.projectId,this.now(),false);
    const material=intent?await this.options.source.materialize(intent,host):await this.options.source.nativeCandidate({scope,target,changeId:candidateId},host);
    if(!material)throw new ProjectApplicationError('NOT_FOUND','screenplay original candidate');
    const binding=material.binding,execution='execution' in material?material.execution:null,mapping=execution?.mapping??binding!.mapping;
    const native=stored.state.changes.find(row=>row.request.id===candidateId),preparation=intent?await this.options.intents.readPreparationReceipt({scope,applicationId:intent.applicationId}):null;
    if(native&&(!binding||!same(native.request,mapping.request))||binding&&!native||preparation&&(!native||!binding))throw new ProjectApplicationError('STORAGE_FAILED','screenplay native request and proof');
    return {...context,scope,target,stored,intent,material,mapping,binding,native,preparation,host,candidateId};
  }
  async readBundle(input:Context&{candidateId:string}){return this.data(input);}
  async candidate(input:Context&{candidateId:string}){
    const data=await this.data(input),{intent,material,mapping,native,stored,subject,projectId,candidateId}=data;let principalId:string|null=null;
    let canReview=permissionsFor(subject,this.options.tenantId,projectId).includes('candidate:review');
    if(canReview)try{const mapped=await this.options.identities.resolvePrincipal({tenantId:subject.tenantId,kind:'user',key:subject.userId});if(mapped.principal.kind!=='user'||!stable.safeParse(mapped.principal.id).success)throw new ProjectApplicationError('STORAGE_FAILED','screenplay reviewer mapping');principalId=mapped.principal.id;}catch(error){if(error instanceof ProjectIdentityError&&error.code==='PRINCIPAL_BINDING_MISSING')canReview=false;else throw error;}
    let sourceState:'current'|'stale'|'unavailable'='current';const blockingReasons:string[]=[];
    if(material.producer.kind==='pending_generation'){sourceState='unavailable';blockingReasons.push('GENERATION_PROVENANCE_PENDING');}
    else try{
      if(native?.status==='adopted')await this.options.source.handoff({scope:data.scope,target:data.target,changeId:candidateId},data.host);
      else{const current=await this.options.source.readReviewed({key:material.progress.preparation.key,target:data.target},data.host);if(current.producer.kind==='pending_generation'||current.progress.preparation.digest!==material.progress.preparation.digest||current.progress.review?.digest!==material.progress.review?.digest)sourceState='stale';}
    }catch(error){sourceState=error instanceof ScreenplayError&&['CONFLICT','INCOMPLETE','NOT_FOUND'].includes(error.code)?'stale':'unavailable';}
    if(sourceState!=='current'&&!blockingReasons.length)blockingReasons.push(sourceState==='stale'?'SOURCE_STALE':'SOURCE_UNAVAILABLE');
    if(!canReview)blockingReasons.push('REVIEW_PERMISSION_REQUIRED');if(principalId!==mapping.request.author.id)blockingReasons.push('LOCK_AUTHOR_REQUIRED');if(!native)blockingReasons.push('PREPARATION_INCOMPLETE');
    const live=native?.status==='candidate';
    return ScreenplayCandidateSchema.parse({contractVersion:1,projectKey:projectId,candidateId,applicationId:intent?.applicationId??null,sourceCandidateId:material.progress.preparation.key.candidateId,episodeId:material.progress.preparation.context.episode.id,authorId:mapping.request.author.id,status:native?.status??'prepared',snapshotRevision:stored.state.head.revision.number,writeVersion:stored.writeVersion,baseRevision:mapping.sourceRevision,operationCount:mapping.request.ops.length,sourceState,canReview,canAdopt:live&&canReview&&principalId===mapping.request.author.id&&sourceState==='current',canReject:live&&canReview,scope:{kind:'episode',id:material.progress.preparation.context.episode.id},blockingReasons,preparation:data.preparation?candidateAcknowledgement(projectId,candidateId,'preparation',intent!.applicationId,data.preparation,'screenplay'):null});
  }
  async adoptCandidate(input:Context&{candidateId:string;requestId:string;command:unknown}){return this.decide(input,'adopt');}
  async rejectCandidate(input:Context&{candidateId:string;requestId:string;command:unknown}){return this.decide(input,'reject');}
  private async verifyAdoptedReceipt(scope:{tenantId:string;projectId:string},target:VersionProjectKey,receipt:ScreenplayProjectReceipt,host:ReturnType<typeof createScreenplayProjectHost>){
    if(receipt.status!=='adopted'||receipt.issues.length)return;
    const proof=await this.options.source.adoptionProof({scope,target,changeId:receipt.changeId},host),audit=receipt.adoption,actual=proof.receipt;
    if(!audit||audit.change_set_id!==actual.changeId||audit.actor_id!==actual.actor.id||audit.from_revision!==actual.fromRevision||audit.to_revision!==actual.toRevision||audit.at!==actual.at||!same(audit.scope,actual.scope))throw new ProjectApplicationError('STORAGE_FAILED','screenplay original adoption acknowledgement proof');
  }
  private async decide(input:Context&{candidateId:string;requestId:string;command:unknown},action:'adopt'|'reject'){
    const command=action==='adopt'?capture(ScreenplayAdoptCommandSchema,input.command):capture(ScreenplayRejectCommandSchema,input.command),candidateId=capture(stable,input.candidateId),requestId=capture(ordinary,input.requestId),authority=await this.authority(input),key={scope:authority.scope,actorKind:'user' as const,actorKey:authority.actor.key,requestId},previous=await this.options.intents.findDecision(key);
    const data=previous?null:await this.data({subject:authority.subject,projectId:authority.projectId,candidateId});
    const episodeId=previous?.adoptionScope.id??data!.material.progress.preparation.context.episode.id;
    const body:ScreenplayProjectDecisionBody={version:1,scope:authority.scope,requestId,actor:authority.actor,target:authority.versionKey,changeId:candidateId,action,adoptionScope:{kind:'episode',id:episodeId},expectation:expected(command),reason:'reason' in command&&typeof command.reason==='string'?command.reason:null,at:previous?.at??this.now()};
    const decision=await this.options.intents.putDecision(body),host=createScreenplayProjectHost(authority.subject,this.options.tenantId,authority.projectId,decision.at,true);let receipt=await this.options.intents.readDecisionReceipt(key);
    if(receipt){await this.verifyAdoptedReceipt(authority.scope,authority.versionKey,receipt,host);return candidateAcknowledgement(authority.projectId,candidateId,'decision',requestId,receipt,'screenplay');}
    const original=data??await this.data({subject:authority.subject,projectId:authority.projectId,candidateId});if(!original.binding||!original.native)throw new ProjectApplicationError('CONFLICT','screenplay preparation incomplete');
    if(action==='adopt'&&(original.mapping.request.author.kind!=='user'||original.mapping.request.author.id!==authority.principal.id))throw new AccessError('FORBIDDEN');
    if(action==='adopt'&&original.material.producer.kind==='pending_generation')throw new ProjectApplicationError('CONFLICT','screenplay generation delivery pending');
    const execution=captureScreenplayExecution({key:original.binding.key,mapping:original.binding.mapping,ids:original.binding.ids,expectation:decision.expectation}),sharedReceipt=this.options.intents.decisionReceiptWriter(decision,execution,host),options={actor:authority.principal,scope:decision.adoptionScope,at:decision.at,authorize:authority.authorize,expectation:decision.expectation};
    if(action==='adopt'){
      const hooks=createScreenplayNativeAdoptionHooks({...execution,actorId:authority.principal.id},this.options.scripts,host);
      await this.options.versions.adoptGuarded(authority.versionKey,candidateId,options,hooks.guard,async(client,result,actual)=>{await hooks.receipt(client,result,actual);await sharedReceipt(client,result,actual);});
    }else await this.options.versions.rejectWithReceipt(authority.versionKey,candidateId,options,decision.reason!,sharedReceipt);
    receipt=await this.options.intents.readDecisionReceipt(key);if(!receipt)throw new ProjectApplicationError('STORAGE_FAILED','screenplay decision receipt');await this.verifyAdoptedReceipt(authority.scope,authority.versionKey,receipt,host);return candidateAcknowledgement(authority.projectId,candidateId,'decision',requestId,receipt,'screenplay');
  }
  async receiptMessages(input:Context&{candidateId:string;command:unknown}){
    const query=capture(CandidateReceiptQuerySchema,input.command),context=this.context(input,'project:read'),candidateId=capture(stable,input.candidateId),scope={tenantId:context.subject.tenantId,projectId:context.projectId},target=await this.target(context.subject,context.projectId);let receipt:ScreenplayProjectReceipt|null;
    if(query.kind==='preparation'){const intent=await this.options.intents.candidateForChange({scope,changeId:candidateId});if(!intent)throw new ProjectApplicationError('NOT_FOUND','screenplay preparation intent');this.bound(intent,scope,target);if(query.requestId!==intent.applicationId)throw new ProjectApplicationError('INVALID_INPUT','screenplay preparation receipt address');receipt=await this.options.intents.readPreparationReceipt({scope,applicationId:intent.applicationId});}
    else{const key={scope,actorKind:'user' as const,actorKey:context.subject.userId,requestId:query.requestId},intent=await this.options.intents.findDecision(key);if(!intent||intent.changeId!==candidateId)throw new ProjectApplicationError('NOT_FOUND','screenplay decision receipt');if(!sameTarget(intent.target,target))throw new ProjectApplicationError('STORAGE_FAILED','screenplay decision receipt target');receipt=await this.options.intents.readDecisionReceipt(key);}
    if(!receipt)throw new ProjectApplicationError('NOT_FOUND','screenplay action receipt');return candidateReceiptPage({source:'screenplay',subjectId:context.subject.userId,intent:{scope,target,changeId:candidateId},receipt,query});
  }
  async handoff(input:Context&{candidateId:string}){
    const context=this.context(input,'project:read'),candidateId=capture(stable,input.candidateId),scope={tenantId:context.subject.tenantId,projectId:context.projectId},target=await this.target(context.subject,context.projectId),host=createScreenplayProjectHost(context.subject,this.options.tenantId,context.projectId,this.now(),false),result=await this.options.source.handoff({scope,target,changeId:candidateId},host),script=result.script,adopted=result.adopted;
    return ScreenplayHandoffSchema.parse({contractVersion:1,projectKey:context.projectId,candidateId,episodeId:script.scope.id,state:result.state,script:{changeId:script.changeId,digest:script.digest,fromRevision:script.fromRevision,toRevision:script.toRevision},ledger:adopted?{changeId:adopted.changeId,proofDigest:adopted.digest,snapshot:adopted.snapshot,adoptedRevision:adopted.adoptedRevision}:null,lineCount:result.lineBook.lineCount,warningCount:result.candidate.issues.filter(row=>row.severity==='warning').length});
  }
}
