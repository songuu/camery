import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {QueryConfig} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {ChangeSetV06,ChangeSetV07,outlineDependencyIssues} from '@camery/ir';
import {migrateVersioning,PostgresVersionStore} from '../src/node/index';
import type {PersistedAdoptOptions,PersistedChangeResult,VersionProjectKey,VersionTransactionReceipt} from '../src/node/types';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';
import {makeOutlinePackage} from '../../ir/test/outline-formal-fixture';

const url=process.env['CAMERY_TEST_DATABASE_URL'];if(!url)throw new Error('CAMERY_TEST_DATABASE_URL required for outline schema upgrade integration');
const pool=new Pool({connectionString:url,max:4,connectionTimeoutMillis:5000});
const receiptTable='camery_versioning.outline_receipt_probe_'+randomUUID().replaceAll('-','');let receiptTableCreated=false;
const key=():VersionProjectKey=>({tenantId:id(randomUUID()),projectId:id(randomUUID())});
const approval=(key:VersionProjectKey):PersistedAdoptOptions=>({actor:{kind:'user',id:id('user_1')},scope:{kind:'project',id:key.projectId},at:'2026-11-18T04:00:00.000Z',authorize:()=>true});
function upgrade06(base:number){return ChangeSetV06.parse({...changeSet([]),id:id('outline-pg-v06'),schema_version:'0.6.0-draft',base_revision:base,ops:[{op_id:id('outline-pg-v06-op'),op:'upgrade_schema',from:'0.5.0-draft',to:'0.6.0-draft'}]});}
function upgrade07(base:number){return ChangeSetV07.parse({...changeSet([]),id:id('outline-pg-v07'),schema_version:'0.7.0-draft',base_revision:base,ops:[{op_id:id('outline-pg-v07-op'),op:'upgrade_schema',from:'0.6.0-draft',to:'0.7.0-draft'}]});}
async function counts(key:VersionProjectKey){return Promise.all(['snapshots','changes','object_revisions','adoptions'].map(async table=>Number((await pool.query<{total:string}>(`SELECT count(*)::text total FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId])).rows[0]!.total)));}
async function cleanup(key:VersionProjectKey){
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');if(receiptTableCreated)await client.query(`DELETE FROM ${receiptTable} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
/** Intercept only this store's owned connection, after the real server has committed, as in the existing receipt integration gate. */
function lostCommitPool(afterCommit:()=>void):Pool{
  const connect=async()=>{const client=await pool.connect();return new Proxy(client,{get(target,property){if(property==='query')return async(input:string|QueryConfig,values?:unknown[])=>{const result=await target.query(input,values);const text=typeof input==='string'?input:input.text;if(text.trim().toUpperCase()==='COMMIT')afterCommit();return result;};const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});};
  return new Proxy(pool,{get(target,property){if(property==='connect')return connect;const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
}
const outcome=(result:Readonly<PersistedChangeResult>)=>({status:result.status,revision:result.state.head.revision.number,schemaVersion:result.state.head.schema_version,writeVersion:result.writeVersion,adoptions:result.state.adoptions});
beforeAll(async()=>{await migrateVersioning(pool);await pool.query(`CREATE TABLE ${receiptTable}(tenant_id text NOT NULL,project_id text NOT NULL,receipt_key text NOT NULL,record jsonb NOT NULL,PRIMARY KEY(tenant_id,project_id,receipt_key),FOREIGN KEY(tenant_id,project_id) REFERENCES camery_versioning.projects(tenant_id,project_id))`);receiptTableCreated=true;});
afterAll(async()=>{try{if(receiptTableCreated)await pool.query(`DROP TABLE ${receiptTable}`);}finally{await pool.end();}});

it('persists separate v05→v06→v07 human upgrades across fresh pools without rewriting old requests, snapshots or object revisions',async()=>{
  const scope=key(),store=new PostgresVersionStore(pool),baseline=structuredClone(makePackage());baseline.project.id=scope.projectId;
  try{
    await store.initialize(scope,baseline);const legacy=changeSet([{op_id:id('outline-pg-old-edit-op'),op:'update',collection:'shots',target:id('sh_1'),set:{action:'升级前已人工采用的旧版本修改。'}}],{id:id('outline-pg-old-edit'),base_revisions:[{id:id('sh_1'),version:1}]});
    await store.submit(scope,legacy);const pending=(await store.read(scope))!;const blocked=await store.submit(scope,upgrade06(5));expect(blocked.issues.map(issue=>issue.code)).toContain('SCHEMA_UPGRADE_PENDING_CHANGES');expect(await store.read(scope)).toEqual(pending);
    const firstPool=new Pool({connectionString:url,max:1});
    let adopted06:PersistedChangeResult;let oldAdoption:PersistedChangeResult;
    try{const next=new PostgresVersionStore(firstPool);expect(await next.read(scope)).toEqual(pending);oldAdoption=await next.adopt(scope,legacy.id,approval(scope));expect(oldAdoption.status).toBe('adopted');expect(oldAdoption.state.head.schema_version).toBe('0.5.0-draft');const command06=upgrade06(oldAdoption.state.head.revision.number);expect((await next.submit(scope,command06)).status).toBe('candidate');adopted06=await next.adopt(scope,command06.id,approval(scope));expect(adopted06.status).toBe('adopted');expect(adopted06.state.head.schema_version).toBe('0.6.0-draft');expect(adopted06.state.revisions).toEqual(oldAdoption.state.revisions);}finally{await firstPool.end();}
    const secondPool=new Pool({connectionString:url,max:1});
    try{
      const next=new PostgresVersionStore(secondPool),restored=(await next.read(scope))!;expect(restored.state).toEqual(adopted06.state);const command07=upgrade07(restored.state.head.revision.number),before=structuredClone(restored.state);
      const proposed=await next.submit(scope,command07);expect(proposed.status).toBe('candidate');expect(proposed.state.head).toEqual(before.head);expect(proposed.state.changes.at(-1)!.preview!.schema_version).toBe('0.7.0-draft');
      const adopted07=await next.adopt(scope,command07.id,approval(scope));expect(adopted07.status).toBe('adopted');expect(adopted07.state.head.schema_version).toBe('0.7.0-draft');expect(adopted07.state.revisions).toEqual(oldAdoption.state.revisions);expect(adopted07.state.changes.slice(0,2)).toEqual(before.changes);expect(adopted07.state.adoptions).toHaveLength(3);
      const beforeCounts=await counts(scope);expect((await store.submit(scope,legacy)).state).toEqual(adopted07.state);expect((await store.submit(scope,upgrade06(oldAdoption.state.head.revision.number))).state).toEqual(adopted07.state);expect((await store.adopt(scope,legacy.id,approval(scope))).state).toEqual(adopted07.state);expect((await store.adopt(scope,command07.id,approval(scope))).state).toEqual(adopted07.state);expect(await counts(scope)).toEqual(beforeCounts);
      expect((await store.adopt(scope,command07.id,{...approval(scope),authorize:()=>false})).issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');expect((await store.read(scope))!.state).toEqual(adopted07.state);expect((await counts(scope))[0]).toBe(4);
      const snapshots=(await pool.query<{revision:string;package:unknown}>('SELECT revision::text revision,package FROM camery_versioning.snapshots WHERE tenant_id=$1 AND project_id=$2 ORDER BY revision',[scope.tenantId,scope.projectId])).rows;expect(snapshots[0]!.package).toEqual(baseline);expect(snapshots[1]!.package).toEqual(oldAdoption.state.head);expect(snapshots[2]!.package).toEqual(adopted06.state.head);expect(snapshots[3]!.package).toEqual(adopted07.state.head);
      const records=(await pool.query<{record:{request:unknown;preview:{schema_version:string}}}>('SELECT record FROM camery_versioning.changes WHERE tenant_id=$1 AND project_id=$2 ORDER BY sequence',[scope.tenantId,scope.projectId])).rows;expect(records.map(row=>row.record.request)).toEqual([legacy,upgrade06(oldAdoption.state.head.revision.number),command07]);expect(records.map(row=>row.record.preview.schema_version)).toEqual(['0.5.0-draft','0.6.0-draft','0.7.0-draft']);
    }finally{await secondPool.end();}
  }finally{await cleanup(scope);}
});

it('persists typed outline locks, explicit owner unlock and version history while retaining stale child parent pins',async()=>{
  const scope=key(),store=new PostgresVersionStore(pool),baseline=makeOutlinePackage();baseline.project.id=scope.projectId;const plan=baseline.adaptation_plans[0]!,lock={id:id('outline-pg-lock'),version:1,target:plan.id,fields:['adaptation'],owner_id:id('user_1'),reason:'人工定稿的大纲说明。'};baseline.locks.push(lock);
  const edit={op_id:id('outline-pg-plan-edit-op'),op:'update' as const,collection:'adaptation_plans' as const,target:plan.id,set:{adaptation:{...plan.adaptation,title:'正式采用后的人改大纲'}}};
  try{
    await store.initialize(scope,baseline);const blocked=ChangeSetV07.parse({...changeSet([edit]),schema_version:'0.7.0-draft',id:id('outline-pg-blocked'),base_revisions:[{id:plan.id,version:1}]});expect((await store.submit(scope,blocked)).issues.map(issue=>issue.code)).toContain('LOCKED');expect((await store.read(scope))!.state.head).toEqual(baseline);
    const request=ChangeSetV07.parse({...changeSet([{op_id:id('outline-pg-unlock-op'),op:'unlock',lock_id:lock.id,reason:'人工明确允许本次修订。'},edit]),schema_version:'0.7.0-draft',id:id('outline-pg-unlock-edit'),base_revisions:[{id:lock.id,version:1},{id:plan.id,version:1}]});
    const candidate=await store.submit(scope,request);expect(candidate.status).toBe('candidate');const denied=await store.adopt(scope,request.id,{...approval(scope),actor:{kind:'user',id:id('other-human')}});expect(denied.issues.map(issue=>issue.code)).toContain('LOCK_AUTHORITY');expect((await store.read(scope))!.state.head).toEqual(baseline);
    const adopted=await store.adopt(scope,request.id,approval(scope));expect(adopted.status).toBe('adopted');if(adopted.state.head.schema_version!=='0.7.0-draft')throw new Error('Expected actual v07 head');expect(adopted.state.head.adaptation_plans[0]).toMatchObject({version:2,adaptation:{title:'正式采用后的人改大纲'}});expect(adopted.state.head.locks).not.toContainEqual(lock);expect(adopted.state.head.outline_beats[0]!.adaptation_plan).toEqual({id:plan.id,version:1});expect(outlineDependencyIssues(adopted.state.head)).toContainEqual({objectId:baseline.outline_beats[0]!.id,referenceId:plan.id,expectedVersion:1,actualVersion:2});expect(adopted.warnings.map(issue=>issue.code)).toContain('STALE_OUTLINE_DEPENDENCY');
    const history=adopted.state.revisions.filter(row=>row.object_id===plan.id);expect(history.map(row=>({version:row.version,parent:row.parent_version}))).toEqual([{version:1,parent:null},{version:2,parent:1}]);expect(history[0]!.value).toEqual(plan);expect(history[1]!.value).toEqual(adopted.state.head.adaptation_plans[0]);expect(adopted.state.revisions.find(row=>row.object_id===lock.id&&row.version===2)!.value).toBeNull();
    const nextPool=new Pool({connectionString:url,max:1});try{const next=new PostgresVersionStore(nextPool);expect((await next.read(scope))!.state).toEqual(adopted.state);const beforeCounts=await counts(scope);expect((await next.adopt(scope,request.id,approval(scope))).state).toEqual(adopted.state);expect((await next.submit(scope,request)).state).toEqual(adopted.state);expect(await counts(scope)).toEqual(beforeCounts);}finally{await nextPool.end();}
    expect((await pool.query<{package:unknown}>('SELECT package FROM camery_versioning.snapshots WHERE tenant_id=$1 AND project_id=$2 AND revision=5',[scope.tenantId,scope.projectId])).rows[0]!.package).toEqual(baseline);
  }finally{await cleanup(scope);}
});

it('rolls back failed typed adoption receipts and recovers the actual committed outline after lost COMMIT ACK through a new pool',async()=>{
  const scope=key(),store=new PostgresVersionStore(pool),baseline=makeOutlinePackage();baseline.project.id=scope.projectId;const plan=baseline.adaptation_plans[0]!;
  const request=ChangeSetV07.parse({...changeSet([{op_id:id('outline-pg-receipt-edit-op'),op:'update',collection:'adaptation_plans',target:plan.id,set:{adaptation:{...plan.adaptation,title:'丢失ACK后仍保留的人改'}}}]),schema_version:'0.7.0-draft',id:id('outline-pg-receipt-edit'),base_revisions:[{id:plan.id,version:1}]});
  const saved=async()=>{return (await pool.query<{record:ReturnType<typeof outcome>}>(`SELECT record FROM ${receiptTable} WHERE tenant_id=$1 AND project_id=$2`,[scope.tenantId,scope.projectId])).rows;};
  const receipt:VersionTransactionReceipt=async(client,result)=>{await client.query(`INSERT INTO ${receiptTable}(tenant_id,project_id,receipt_key,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,[scope.tenantId,scope.projectId,'outline-adopt',JSON.stringify(outcome(result))]);};
  try{
    await store.initialize(scope,baseline);expect((await store.submit(scope,request)).status).toBe('candidate');const pending=(await store.read(scope))!,beforeCounts=await counts(scope);const expectation={expectedSnapshotRevision:5,expectedWriteVersion:pending.writeVersion};
    await expect(store.adoptGuarded(scope,request.id,{...approval(scope),expectation},async()=>{},async(client,result,context)=>{await receipt(client,result,context);throw new Error('Synthetic outline receipt storage failure after INSERT');})).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(await saved()).toEqual([]);expect(await store.read(scope)).toEqual(pending);expect(await counts(scope)).toEqual(beforeCounts);
    let lose=true;const observed=new PostgresVersionStore(lostCommitPool(()=>{if(lose){lose=false;throw new Error('Synthetic outline committed ACK lost');}}));const guard=vi.fn(async()=>{});
    await expect(observed.adoptGuarded(scope,request.id,{...approval(scope),expectation},guard,receipt)).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(guard).toHaveBeenCalledOnce();
    const replacement=new Pool({connectionString:url,max:1});try{
      const next=new PostgresVersionStore(replacement),actual=(await next.read(scope))!;expect(actual.state.changes.find(row=>row.request.id===request.id)!.status).toBe('adopted');expect(actual.state.adoptions).toHaveLength(1);if(actual.state.head.schema_version!=='0.7.0-draft')throw new Error('Expected recovered v07 head');expect(actual.state.head.adaptation_plans[0]).toMatchObject({version:2,adaptation:{title:'丢失ACK后仍保留的人改'}});expect((await saved()).map(row=>row.record)).toEqual([outcome({state:actual.state,status:'adopted',issues:[],warnings:[],writeVersion:actual.writeVersion})]);
      const committedCounts=await counts(scope),replayGuard=vi.fn(async()=>{throw new Error('A known adopted outline must not rerun its source guard');}),authorize=vi.fn(()=>true);const replay=await next.adoptGuarded(scope,request.id,{...approval(scope),authorize,expectation},replayGuard,receipt);expect(replay.state).toEqual(actual.state);expect(replay.writeVersion).toBe(actual.writeVersion);expect(replayGuard).not.toHaveBeenCalled();expect(authorize).toHaveBeenCalledWith(approval(scope).actor,scope,approval(scope).scope);expect(await counts(scope)).toEqual(committedCounts);expect(await saved()).toHaveLength(1);
    }finally{await replacement.end();}
  }finally{await cleanup(scope);}
});
