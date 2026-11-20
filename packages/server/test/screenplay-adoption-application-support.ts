import {vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {Role,SessionIdentity} from '@camery/access';
import {createVersionState,submitChangeSet,adoptChangeSet,rejectChangeSet} from '@camery/versioning';
import type {ChangeResult} from '@camery/versioning';
import {VersionPersistenceError} from '@camery/versioning/node';
import type {VersionTransactionReceipt,VersionTransactionContext,VersionWriteExpectation,PersistedSubmitOptions,PersistedAdoptOptions,VersionAdoptionGuard,VersionProjectKey} from '@camery/versioning/node';
import {prepareScreenplayNativeMapping,screenplayNativeSlots} from '@camery/script/screenplay/node';
import {ScreenplayError} from '@camery/script/screenplay';
import {screenplayNativeFixture} from '../../script/test/screenplay-native-support.js';
import {ScreenplayAdoptionApplication} from '../src/projects/screenplay-adoption-application.js';
import type {ScreenplayAdoptionOptions} from '../src/projects/screenplay-adoption-options.js';
import {ProjectApplicationError} from '../src/projects/intent-contracts.js';
import {captureScreenplayProjectIntent,captureScreenplayProjectDecision,screenplayCandidateBusiness,screenplayDecisionBusiness,screenplayJournalDigest} from '../src/projects/screenplay-intent-codec.js';
import type {ScreenplayProjectIntentBody,ScreenplayProjectIntent,ScreenplayProjectDecisionBody,ScreenplayProjectDecision,ScreenplayProjectReceipt} from '../src/projects/screenplay-intent-contracts.js';

/** The real compiler and native engine are exercised; domain persistence hooks are explicit protocol doubles, not PostgreSQL evidence. */
const hooks=vi.hoisted(()=>({submission:vi.fn(),guard:vi.fn(),adoption:vi.fn()}));
vi.mock('@camery/script/screenplay/node',async original=>({...await original<typeof import('@camery/script/screenplay/node')>(),createScreenplayNativeSubmissionReceipt:()=>hooks.submission,createScreenplayNativeAdoptionHooks:()=>({guard:hooks.guard,receipt:hooks.adoption})}));
export const screenplayHooks=hooks;

export async function screenplayApplicationFixture(){
  const f=await screenplayNativeFixture(),scope=f.scope,target=f.target;
  let state=createVersionState(f.head),writeVersion=1,sequence=0;
  const control={current:true,pending:false,sourceAvailable:true,proofAvailable:true,ledgerReady:false,omitPreparation:false,omitDecision:false,losePreparation:false,loseDecision:false};
  type Mapping=typeof f.mapping;type Execution={key:typeof f.key;mapping:Mapping;ids:typeof f.ids;expectation:VersionWriteExpectation};
  let binding:{key:typeof f.key;mapping:Mapping;ids:typeof f.ids;digest:string}|null=null,activeExecution:Execution|null=null;
  const candidates=new Map<string,ScreenplayProjectIntent>(),decisions=new Map<string,ScreenplayProjectDecision>(),preparations=new Map<string,ScreenplayProjectReceipt>(),receipts=new Map<string,ScreenplayProjectReceipt>();
  const actorFor=(key:string)=>({kind:'user' as const,id:key==='operator'?f.author.id:f.id('host-reviewer-'+key)});
  const subject=(role:Role='reviewer',userId='operator'):SessionIdentity=>({tenantId:scope.tenantId,userId,sessionId:'sc-unit-'+userId,grants:[{projectId:scope.projectId,role}]});
  const identities={resolve:vi.fn(async(input:{key:string})=>({scope,versionKey:target,principal:actorFor(input.key)})),resolveProject:vi.fn(async()=>({...scope,versionKey:target})),resolvePrincipal:vi.fn(async(input:{key:string})=>({tenantId:scope.tenantId,kind:'user',key:input.key,principal:actorFor(input.key)}))};
  const producer=()=>control.pending?{kind:'pending_generation' as const,runId:'pending-generation'}:{kind:'manual' as const};
  function materialize(intent:ScreenplayProjectIntent){
    const slots=screenplayNativeSlots(f.review.output.draft),ids=slots.map((slot,index)=>({slot,id:intent.ids[index]!}));
    const mapping=prepareScreenplayNativeMapping({head:f.head,context:f.context,candidate:f.candidate,review:f.review,target,changeId:intent.changeId,author:{kind:'user',id:intent.actor.id},ids});
    return {head:f.head,progress:f.progress,producer:producer(),binding,execution:{key:f.key,mapping,ids,expectation:intent.expectation}};
  }
  const source={
    readReviewed:vi.fn(async()=>{if(!control.sourceAvailable)throw new Error('private source transport token');if(!control.current)throw new ScreenplayError('CONFLICT','fixture upstream changed','source');return {head:f.head,progress:f.progress,producer:producer()};}),
    materialize:vi.fn(async(intent:ScreenplayProjectIntent)=>materialize(intent)),
    nativeCandidate:vi.fn(async()=>binding?{head:f.head,progress:f.progress,producer:producer(),binding}:null),
    sourceBinding:vi.fn(async()=>binding),
    handoff:vi.fn(async()=>{if(!control.proofAvailable)throw new ScreenplayError('INCOMPLETE','fixture missing proof','original proof');if(!control.current)throw new ScreenplayError('CONFLICT','fixture writing changed','current writing dependencies');return {state:control.ledgerReady?'handoff_ready':'ledger_pending',script:{changeId:binding!.mapping.request.id,digest:'a'.repeat(64),scope:{kind:'episode',id:f.context.episode.id},fromRevision:f.head.revision.number,toRevision:f.head.revision.number+1},adopted:control.ledgerReady?{changeId:f.id('fixture-ledger-change'),digest:'b'.repeat(64),snapshot:{id:f.id('fixture-ledger-snapshot'),version:1},adoptedRevision:f.head.revision.number+2}:null,lineBook:{lineCount:f.review.output.lineBook.lineCount},candidate:{issues:[]}};}),
    adoptionProof:vi.fn(async()=>{if(!control.proofAvailable)throw new ScreenplayError('INCOMPLETE','fixture missing proof','original proof');const audit=state.adoptions.at(-1)!;return {receipt:{changeId:audit.change_set_id,actor:{kind:'user',id:audit.actor_id},fromRevision:audit.from_revision,toRevision:audit.to_revision,at:audit.at,scope:audit.scope}};}),
  };
  const keyFor=(input:{actorKey:string;requestId:string})=>input.actorKey+':'+input.requestId;
  const intents={
    findCandidate:vi.fn(async(input:{applicationId:string})=>candidates.get(input.applicationId)??null),
    candidateForChange:vi.fn(async(input:{changeId:string})=>[...candidates.values()].find(row=>row.changeId===input.changeId)??null),
    putCandidate:vi.fn(async(body:ScreenplayProjectIntentBody)=>{const old=candidates.get(body.applicationId);if(old){if(old.businessDigest!==screenplayCandidateBusiness(body))throw new ProjectApplicationError('CONFLICT','unit immutable command');return old;}const intent=captureScreenplayProjectIntent({...body,digest:screenplayJournalDigest(body),businessDigest:screenplayCandidateBusiness(body),createdAt:'2026-11-20T09:00:00.000Z'});candidates.set(body.applicationId,intent);return intent;}),
    findDecision:vi.fn(async(input:{actorKey:string;requestId:string})=>decisions.get(keyFor(input))??null),
    putDecision:vi.fn(async(body:ScreenplayProjectDecisionBody)=>{const key=keyFor({actorKey:body.actor.key,requestId:body.requestId}),old=decisions.get(key);if(old){if(old.businessDigest!==screenplayDecisionBusiness(body))throw new ProjectApplicationError('CONFLICT','unit immutable decision');return old;}const intent=captureScreenplayProjectDecision({...body,digest:screenplayJournalDigest(body),businessDigest:screenplayDecisionBusiness(body),createdAt:'2026-11-20T09:00:00.000Z'});decisions.set(key,intent);return intent;}),
    readPreparationReceipt:vi.fn(async(input:{applicationId:string})=>preparations.get(input.applicationId)??null),
    readDecisionReceipt:vi.fn(async(input:{actorKey:string;requestId:string})=>receipts.get(keyFor(input))??null),
    preparationReceiptWriter:vi.fn((intent:ScreenplayProjectIntent,execution:Execution)=>{activeExecution=execution;return async(_client:PoolClient,result:ChangeResult&{writeVersion:number})=>{if(!control.omitPreparation)preparations.set(intent.applicationId,receipt(result,intent.changeId));};}),
    decisionReceiptWriter:vi.fn((intent:ScreenplayProjectDecision,execution:Execution)=>{activeExecution=execution;return async(_client:PoolClient,result:ChangeResult&{writeVersion:number})=>{if(!control.omitDecision)receipts.set(keyFor({actorKey:intent.actor.key,requestId:intent.requestId}),receipt(result,intent.changeId));};}),
  };
  function receipt(result:ChangeResult&{writeVersion:number},changeId:string):ScreenplayProjectReceipt{return {version:1,changeId,status:result.status,snapshotRevision:result.state.head.revision.number,writeVersion:result.writeVersion,issues:result.issues,warnings:result.warnings,adoption:result.state.adoptions.find(row=>row.change_set_id===changeId)??null,rejection:result.state.changes.find(row=>row.request.id===changeId)?.rejection??null};}
  const client={} as PoolClient;
  function compare(expected:VersionWriteExpectation|undefined){if(expected?.expectedSnapshotRevision!==state.head.revision.number)throw new VersionPersistenceError('SNAPSHOT_STALE','unit SC CAS',target.projectId);if(expected.expectedWriteVersion!==writeVersion)throw new VersionPersistenceError('WRITE_VERSION_CONFLICT','unit SC CAS',target.projectId);}
  async function persist(result:ChangeResult,context:VersionTransactionContext,writer:VersionTransactionReceipt){const next=JSON.stringify(state)===JSON.stringify(result.state)?writeVersion:writeVersion+1;await writer(client,{...result,writeVersion:next},context);state=result.state;writeVersion=next;return {...result,writeVersion};}
  const versions={
    read:vi.fn(async()=>({state,writeVersion})),
    submitWithReceipt:vi.fn(async(key:VersionProjectKey,request:unknown,options:PersistedSubmitOptions,writer:VersionTransactionReceipt)=>{compare(options.expectation);const result=await persist(submitChangeSet(state,request),{operation:'submit',project:key,expectation:options.expectation!,requestSignature:JSON.stringify(request)},writer);if(control.losePreparation){control.losePreparation=false;throw new VersionPersistenceError('DATABASE_ERROR','unit explicit post-commit loss',target.projectId);}return result;}),
    adoptGuarded:vi.fn(async(key:VersionProjectKey,changeId:string,options:PersistedAdoptOptions,guard:VersionAdoptionGuard,writer:VersionTransactionReceipt)=>{const replayed=state.changes.some(row=>row.request.id===changeId&&row.status==='adopted');if(!replayed){await guard(client);compare(options.expectation);}const result=adoptChangeSet(state,changeId,{actor:options.actor,scope:options.scope,at:options.at,authorize:()=>options.authorize(options.actor,key,options.scope)});const written=await persist(result,{operation:'adopt',project:key,changeId,actor:options.actor,scope:options.scope,at:options.at,expectation:options.expectation!,replayed},writer);if(control.loseDecision){control.loseDecision=false;throw new VersionPersistenceError('DATABASE_ERROR','unit explicit post-commit loss',target.projectId);}return written;}),
    rejectWithReceipt:vi.fn(async(key:VersionProjectKey,changeId:string,options:PersistedAdoptOptions,reason:string,writer:VersionTransactionReceipt)=>{compare(options.expectation);return persist(rejectChangeSet(state,changeId,{actor:options.actor,scope:options.scope,at:options.at,authorize:()=>options.authorize(options.actor,key,options.scope)},reason),{operation:'reject',project:key,changeId,actor:options.actor,scope:options.scope,at:options.at,reason,expectation:options.expectation!},writer);}),
  };
  screenplayHooks.submission.mockReset().mockImplementation(async()=>{binding={key:activeExecution!.key,mapping:activeExecution!.mapping,ids:activeExecution!.ids,digest:'a'.repeat(64)};});
  screenplayHooks.guard.mockReset().mockImplementation(async()=>{if(!control.current)throw new ScreenplayError('CONFLICT','unit upstream changed','source');});screenplayHooks.adoption.mockReset().mockResolvedValue(undefined);
  const newId=vi.fn(()=>f.id('unit-sc-allocation-'+sequence++)),now=vi.fn(()=> '2026-11-20T09:00:00.000Z');
  const options={tenantId:scope.tenantId,identities,versions,intents,source,scripts:{},newId,now} as unknown as ScreenplayAdoptionOptions,application=new ScreenplayAdoptionApplication(options);
  const command=(applicationId='unit-sc-command')=>({applicationId,sourceCandidateId:f.key.candidateId,preparationDigest:f.progress.preparation.digest,reviewDigest:f.review.digest,expectedSnapshotRevision:state.head.revision.number,expectedWriteVersion:writeVersion});
  const prepare=(value=command(),actor=subject())=>application.prepareScreenplay({subject:actor,projectId:scope.projectId,command:value});
  const readInput=(candidateId:string,actor=subject())=>({subject:actor,projectId:scope.projectId,candidateId});
  const decision=(candidateId:string,action:'adopt'|'reject'='adopt',actor=subject(),requestId='unit-sc-decision')=>({...readInput(candidateId,actor),requestId,command:{expectedSnapshotRevision:state.head.revision.number,expectedWriteVersion:writeVersion,...(action==='reject'?{reason:'人工明确拒绝整集候选'}:{})}});
  function legacy(){state=submitChangeSet(state,f.mapping.request).state;writeVersion++;binding={key:f.key,mapping:f.mapping,ids:f.ids,digest:'a'.repeat(64)};return f.mapping.request.id;}
  return {f,scope,target,subject,actorFor,identities,source,intents,versions,options,application,control,candidates,decisions,preparations,receipts,newId,now,command,prepare,readInput,decision,legacy,getState:()=>({state,writeVersion}),binding:()=>binding};
}
