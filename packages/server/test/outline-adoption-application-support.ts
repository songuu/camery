import {vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {Role,SessionIdentity} from '@camery/access';
import {adoptChangeSet,createVersionState,rejectChangeSet,submitChangeSet} from '@camery/versioning';
import type {ChangeResult,VersionState} from '@camery/versioning';
import {VersionPersistenceError} from '@camery/versioning/node';
import type {PersistedAdoptOptions,PersistedSubmitOptions,VersionAdoptionGuard,VersionProjectKey,VersionTransactionContext,VersionTransactionReceipt,VersionWriteExpectation} from '@camery/versioning/node';
import {OutlineError} from '@camery/script/outline/contracts';
import {captureOutlineAdoptionProgress} from '@camery/script/outline/node';
import {outlineFormalMappingFixture} from '../../script/test/outline-formal-mapping-support.js';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {OutlineAdoptionApplication} from '../src/projects/outline-adoption-application.js';
import type {OutlineAdoptionOptions} from '../src/projects/outline-adoption-options.js';
import {PostgresOutlineProjectIntents,outlineIntentDigest} from '../src/projects/outline-intent-store.js';
import type {OutlineActionReceipt} from '../src/projects/outline-intent-contracts.js';
import {outlineIntentMemory} from './outline-intent-memory.js';

/** Actual reviewed domain source and native engine; SQL transport here is an explicit protocol double, never PG evidence. */
export async function outlineAdoptionApplicationFixture(){
  const f=await outlineFormalMappingFixture(),scope={tenantId:f.source.tenantId,projectId:f.source.projectId},target=f.identities.target;
  const db=outlineIntentMemory();let state=createVersionState(f.head),writeVersion=1,sequence=0,current=true;
  const actorFor=(key:string)=>({kind:'user' as const,id:key===f.reviewer.key?f.reviewer.id:id('outline-app-actor:'+key)});
  const subject=(role:Role='admin',userId=role==='reviewer'?'decider':role==='viewer'?'observer':'preparer'):SessionIdentity=>({tenantId:scope.tenantId,userId,sessionId:'outline-app-session-'+userId,grants:[{projectId:scope.projectId,role}]});
  const identities={
    resolveProject:vi.fn(async(_input:{tenantId:string;projectId:string})=>({...scope,versionKey:target})),
    resolvePrincipal:vi.fn(async(input:{tenantId:string;kind:'user'|'agent_run'|'system';key:string})=>({...input,principal:actorFor(input.key)})),
    resolve:vi.fn(async(input:{tenantId:string;projectId:string;kind:'user'|'agent_run'|'system';key:string})=>({scope,versionKey:target,principal:actorFor(input.key)})),
  };
  const sourceKey={tenantId:scope.tenantId,projectId:scope.projectId,runId:f.source.runId};
  const outline={
    store:{read:vi.fn(async(_input:typeof sourceKey)=>f.progress),isCurrent:vi.fn(async(_input:typeof sourceKey)=>current),readForAdoption:vi.fn(async(_client:PoolClient,source:typeof f.source)=>{if(!current)throw new OutlineError('CONFLICT','test source changed','source');return captureOutlineAdoptionProgress(source,f.progress);})},
    identities:{prepare:vi.fn(async(command:{source:typeof f.source;target:VersionProjectKey})=>{if(!current)throw new OutlineError('CONFLICT','test source changed','source');return {identities:f.identities,progress:captureOutlineAdoptionProgress(command.source,f.progress)};})},
  };
  function syncHead(){db.state.headRows=[{snapshot_revision:state.head.revision.number,write_version:writeVersion,schema_version:state.head.schema_version}];}
  syncHead();
  function compare(expected:VersionWriteExpectation|undefined){if(expected&&expected.expectedSnapshotRevision!==state.head.revision.number)throw new VersionPersistenceError('SNAPSHOT_STALE','unit native CAS',target.projectId);if(expected&&expected.expectedWriteVersion!==writeVersion)throw new VersionPersistenceError('WRITE_VERSION_CONFLICT','unit native CAS',target.projectId);}
  async function persist(result:ChangeResult,context:VersionTransactionContext,writer:VersionTransactionReceipt){
    const nextVersion=JSON.stringify(result.state)===JSON.stringify(state)?writeVersion:writeVersion+1;
    await writer(db.client as unknown as PoolClient,{...result,writeVersion:nextVersion},context);
    state=result.state;writeVersion=nextVersion;syncHead();return {...result,writeVersion};
  }
  const versions={
    read:vi.fn(async(_key:VersionProjectKey)=>({state,writeVersion})),
    submitWithReceipt:vi.fn(async(key:VersionProjectKey,request:unknown,options:PersistedSubmitOptions,writer:VersionTransactionReceipt)=>{
      compare(options.expectation);const result=submitChangeSet(state,request);return persist(result,{operation:'submit',project:key,...(options.expectation?{expectation:options.expectation}:{}),requestSignature:JSON.stringify(request)},writer);
    }),
    adoptGuarded:vi.fn(async(key:VersionProjectKey,changeId:string,options:PersistedAdoptOptions,guard:VersionAdoptionGuard,writer:VersionTransactionReceipt)=>{
      const replayed=state.changes.some(row=>row.request.id===changeId&&row.status==='adopted');if(!replayed){await guard(db.client as unknown as PoolClient);compare(options.expectation);}
      const result=adoptChangeSet(state,changeId,{actor:options.actor,scope:options.scope,at:options.at,authorize:()=>options.authorize(options.actor,key,options.scope)});
      return persist(result,{operation:'adopt',project:key,...(options.expectation?{expectation:options.expectation}:{}),changeId,actor:options.actor,scope:options.scope,at:options.at,replayed},writer);
    }),
    rejectWithReceipt:vi.fn(async(key:VersionProjectKey,changeId:string,options:PersistedAdoptOptions,reason:string,writer:VersionTransactionReceipt)=>{
      compare(options.expectation);const result=rejectChangeSet(state,changeId,{actor:options.actor,scope:options.scope,at:options.at,authorize:()=>options.authorize(options.actor,key,options.scope)},reason);
      return persist(result,{operation:'reject',project:key,...(options.expectation?{expectation:options.expectation}:{}),changeId,actor:options.actor,scope:options.scope,at:options.at,reason},writer);
    }),
  };
  const intentStore=new PostgresOutlineProjectIntents(db.pool);
  const intents={findCandidate:vi.fn(intentStore.findCandidate.bind(intentStore)),candidateForChange:vi.fn(intentStore.candidateForChange.bind(intentStore)),findDecision:vi.fn(intentStore.findDecision.bind(intentStore)),putCandidate:vi.fn(intentStore.putCandidate.bind(intentStore)),putDecision:vi.fn(intentStore.putDecision.bind(intentStore)),readPreparationReceipt:vi.fn(intentStore.readPreparationReceipt.bind(intentStore)),readDecisionReceipt:vi.fn(intentStore.readDecisionReceipt.bind(intentStore)),preparationReceiptWriter:vi.fn(intentStore.preparationReceiptWriter.bind(intentStore)),decisionReceiptWriter:vi.fn(intentStore.decisionReceiptWriter.bind(intentStore))};
  const catalog={list:vi.fn(async(_input:{scope:typeof scope;target:VersionProjectKey;subjectId:string;runId?:string;cursor?:string;limit?:number})=>({contractVersion:1 as const,items:[],nextCursor:null}))};
  const newId=vi.fn(()=>id('outline-application-allocation:'+sequence++)),now=vi.fn(()=> '2026-11-18T09:30:00.000Z');
  const options={tenantId:scope.tenantId,identities,versions,intents,catalog,outline,newId,now} satisfies OutlineAdoptionOptions;
  const application=new OutlineAdoptionApplication(options);
  const command=(applicationId='outline-app-command')=>({applicationId,runDigest:f.source.runDigest,briefDigest:f.source.briefDigest,candidateDigest:f.source.candidateDigest,reviewDigest:f.source.reviewDigest,sourceDigest:f.source.sourceDigest,expectedSnapshotRevision:state.head.revision.number,expectedWriteVersion:writeVersion});
  const prepare=(input=command(),principal=subject('editor'))=>application.prepareOutline({subject:principal,projectId:scope.projectId,runId:f.source.runId,command:input});
  const decisionInput=(candidateId:string,action:'adopt'|'reject'='adopt',requestId='outline-app-decision')=>({subject:subject('reviewer'),projectId:scope.projectId,candidateId,requestId,command:{expectedSnapshotRevision:state.head.revision.number,expectedWriteVersion:writeVersion,...(action==='reject'?{reason:'人工明确要求重做人物选择'}:{})}});
  const readInput=(candidateId:string,principal=subject('viewer'))=>({subject:principal,projectId:scope.projectId,candidateId});
  /** Pagination fixtures alter only the SQL double's stored report and recalculate its envelope hash; they do not claim actual kernel warnings. */
  function seedPreparationMessages(items:OutlineActionReceipt['warnings'],section:'issues'|'warnings'='warnings'){
    const row=db.rows.get('preparation');if(!row)throw new Error('Prepare before seeding an explicit stored-report fixture');
    const record=structuredClone(row['record']) as OutlineActionReceipt;record[section]=items;row['record']=record;row['digest']=outlineIntentDigest({intentDigest:row['intent_digest'],receipt:record});
  }
  return {f,scope,target,subject,actorFor,db,identities,outline,versions,intents,intentStore,catalog,newId,now,options,application,command,prepare,decisionInput,readInput,seedPreparationMessages,getState:()=>({state,writeVersion}),setState:(next:VersionState,counter:number)=>{state=next;writeVersion=counter;syncHead();},setCurrent:(value:boolean)=>{current=value;}};
}
