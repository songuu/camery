import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient,QueryConfig} from 'pg';
import {AccessService,issueSession} from '@camery/access';
import {PostgresSessionStore} from '@camery/access/node';
import {upgradeV05Package,upgradeV06Package} from '@camery/ir';
import {PostgresVersionStore} from '@camery/versioning/node';
import type {VersionWriteExpectation} from '@camery/versioning/node';
import {PostgresOutlineIrIdentities,prepareOutlineMappingDraft} from '@camery/script/outline/node';
import {fixtureId as id,makePackage} from '../../ir/test/fixtures.js';
import {outlineIdentityPgFixture} from '../../script/test/outline-ir-identities-pg-support.js';
import {ProjectIdentityRegistrar,PostgresProjectIdentityStore} from '../src/projects/identity-map.js';
import {resolveProjectAuthority} from '../src/projects/authority.js';
import {projectIntentDigest} from '../src/projects/intent-store.js';
import {PostgresOutlineProjectIntents} from '../src/projects/outline-intent-store.js';
import type {OutlineCandidateIntent,OutlineCandidateIntentBody,OutlineDecisionIntentBody} from '../src/projects/outline-intent-contracts.js';

export const allocateOutlineIntentId=()=>id(randomUUID());

/** The adapter text is explicitly synthetic; source review, identity, intent and version writes use actual PG. */
export async function outlineIntentPgFixture(pool:Pool,owned:string[],options:{capacity?:boolean}={}){
  const f=await outlineIdentityPgFixture(pool,owned,{count:options.capacity?100:3,capacity:options.capacity===true});
  const versions=new PostgresVersionStore(pool),intents=new PostgresOutlineProjectIntents(pool);
  const baseline=upgradeV06Package(upgradeV05Package(makePackage()));
  for(const [name,value] of Object.entries(baseline))if(Array.isArray(value))(baseline as unknown as Record<string,unknown>)[name]=[];
  baseline.project.id=f.target.projectId;baseline.project.source_ids=[];baseline.project.rights_status='unknown';
  baseline.project.scope={label:'明确的独立大纲采用基线',expected_episode_count:0,expected_scene_count:0,expected_required_beat_count:0};
  baseline.revision={number:1,status:'adopted',note:'Explicit synthetic fixture installation'};
  await versions.initialize(f.target,baseline);
  const registrar=new ProjectIdentityRegistrar(pool);
  await registrar.registerTenant({tenantId:f.scope.tenantId,irTenantId:f.target.tenantId});
  await registrar.registerProject({...f.scope,irProjectId:f.target.projectId});
  for(const key of ['editor','reviewer','registry-editor'])await registrar.registerPrincipal({tenantId:f.scope.tenantId,kind:'user',key,irActorId:id(f.scope.tenantId+key)});
  const sessions=new PostgresSessionStore(pool),access=new AccessService({tenantId:f.scope.tenantId,store:sessions}),tokens={editor:'',reviewer:''};
  for(const role of ['editor','reviewer'] as const){
    await sessions.provisionMember({...f.scope,userId:role,role});
    tokens[role]='Bearer '+(await issueSession({tenantId:f.scope.tenantId,userId:role,ttlSeconds:3600},sessions)).token;
  }
  const registry=new PostgresProjectIdentityStore(pool);
  const authority=async(role:'editor'|'reviewer')=>resolveProjectAuthority({identities:registry,subject:await access.authenticate(tokens[role]),projectId:f.scope.projectId,permission:role==='editor'?'candidate:write':'candidate:review'});
  const prepared=await new PostgresOutlineIrIdentities(pool,f.store,allocateOutlineIntentId).prepare({source:f.source,target:f.target});
  const reviewer={key:'registry-editor',id:id(f.scope.tenantId+'registry-editor')};
  const author=await authority('editor');
  function bodyFor(applicationId='application',head:unknown=baseline,expectation:VersionWriteExpectation={expectedSnapshotRevision:1,expectedWriteVersion:1}):OutlineCandidateIntentBody{
    const draft=prepareOutlineMappingDraft({progress:prepared.progress,identities:prepared.identities,source:f.source,reviewer,head});
    return {version:1,scope:f.scope,applicationId,actor:{kind:'user',id:author.principal.id,key:'editor'},target:f.target,commandDigest:projectIntentDigest({source:f.source,expectation}),source:{kind:'outline',mapperVersion:1,source:f.source,identities:prepared.identities,reviewer},expectation,changeId:allocateOutlineIntentId(),draft,operationIds:draft.operations.map(op=>({slot:op.slot,id:allocateOutlineIntentId()}))};
  }
  const proposed=bodyFor(),candidate=await intents.putCandidate(proposed);
  const submit=(value:OutlineCandidateIntent=candidate,store:PostgresVersionStore=versions)=>{
    if(value.request===null)throw new Error('Nonempty candidate required for native submit');
    return store.submitWithReceipt(f.target,value.request,{expectation:value.expectation},intents.preparationReceiptWriter(value));
  };
  async function decision(action:'adopt'|'reject'='adopt',requestId='decision',value:OutlineCandidateIntent=candidate,expectation:VersionWriteExpectation={expectedSnapshotRevision:1,expectedWriteVersion:2},at='2026-11-18T06:00:00.000Z'){
    const actor=await authority('reviewer');
    const body:OutlineDecisionIntentBody={version:1,scope:f.scope,requestId,actor:{kind:'user',id:actor.principal.id,key:'reviewer'},changeId:value.changeId,action,adoptionScope:{kind:'project',id:f.target.projectId},expectation,reason:action==='reject'?'明确拒绝本次大纲候选':null,at};
    const intent=await intents.putDecision(body);
    return {body,intent,options:{actor:actor.principal,scope:intent.adoptionScope,at:intent.at,authorize:actor.authorize,expectation:intent.expectation},receipt:intents.decisionReceiptWriter(intent,value),key:{scope:f.scope,actorKind:'user' as const,actorKey:'reviewer',requestId}};
  }
  return {...f,prepared,reviewer,baseline,proposed,candidate,bodyFor,submit,decision,authority,sessions,versions,intents};
}

export async function outlineVersionCounts(pool:Pool,target:{tenantId:string;projectId:string}){
  return Promise.all(['snapshots','changes','object_revisions','adoptions'].map(async table=>Number((await pool.query<{count:string}>(`SELECT count(*)::text count FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[target.tenantId,target.projectId])).rows[0]!.count)));
}

/** Execute COMMIT first, then optionally lose only its acknowledgement. Observers use the same native client. */
export function observeOutlinePool(pool:Pool,observe:(client:PoolClient,text:string)=>Promise<void>,afterCommit?:()=>void):Pool{
  return new Proxy(pool,{get(target,property){
    if(property==='connect')return async()=>{
      const client=await target.connect();
      return new Proxy(client,{get(connection,field){
        if(field==='query')return async(input:string|QueryConfig,values?:unknown[])=>{
          const text=typeof input==='string'?input:input.text;
          const result=await connection.query(input,values);await observe(connection,text);
          if(text.trim().toUpperCase()==='COMMIT')afterCommit?.();return result;
        };
        const value:unknown=Reflect.get(connection,field);return typeof value==='function'?value.bind(connection):value;
      }});
    };
    const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
  }});
}
