import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {QueryConfig} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {ChangeSetV08} from '@camery/ir';
import {migrateVersioning,PostgresVersionStore} from '../src/node/index';
import type {PersistedAdoptOptions,PersistedChangeResult,VersionProjectKey,VersionTransactionReceipt} from '../src/node/types';
import {changeSet,fixtureId as id} from '../../ir/test/fixtures';
import {makeOutlinePackage} from '../../ir/test/outline-formal-fixture';
import {completeContinuitySnapshot,continuityAdd,continuityUpgrade,makeContinuityPackage} from './continuity-fixture';

const url=process.env['CAMERY_TEST_DATABASE_URL'];if(!url)throw new Error('CAMERY_TEST_DATABASE_URL required for continuity schema upgrade integration');
const pool=new Pool({connectionString:url,max:4,connectionTimeoutMillis:5000}),receiptTable='camery_versioning.continuity_receipt_probe_'+randomUUID().replaceAll('-','');let receiptTableCreated=false;
const key=():VersionProjectKey=>({tenantId:id(randomUUID()),projectId:id(randomUUID())});
const approval=(target:VersionProjectKey):PersistedAdoptOptions=>({actor:{kind:'user',id:id('user_1')},scope:{kind:'project',id:target.projectId},at:'2026-11-18T16:00:00.000Z',authorize:()=>true});
const counts=(target:VersionProjectKey)=>Promise.all(['snapshots','changes','object_revisions','adoptions'].map(async table=>Number((await pool.query<{total:string}>(`SELECT count(*)::text total FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[target.tenantId,target.projectId])).rows[0]!.total)));
async function cleanup(target:VersionProjectKey){
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');if(receiptTableCreated)await client.query(`DELETE FROM ${receiptTable} WHERE tenant_id=$1 AND project_id=$2`,[target.tenantId,target.projectId]);for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[target.tenantId,target.projectId]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
/** The fixture intercepts its own real connection only after PostgreSQL has committed. */
function lostCommitPool(afterCommit:()=>void):Pool{
  const connect=async()=>{const client=await pool.connect();return new Proxy(client,{get(target,property){if(property==='query')return async(input:string|QueryConfig,values?:unknown[])=>{const result=await target.query(input,values),text=typeof input==='string'?input:input.text;if(text.trim().toUpperCase()==='COMMIT')afterCommit();return result;};const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});};
  return new Proxy(pool,{get(target,property){if(property==='connect')return connect;const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
}
const outcome=(result:Readonly<PersistedChangeResult>)=>({status:result.status,revision:result.state.head.revision.number,schemaVersion:result.state.head.schema_version,writeVersion:result.writeVersion,adoptions:result.state.adoptions});
beforeAll(async()=>{await migrateVersioning(pool);await pool.query(`CREATE TABLE ${receiptTable}(tenant_id text NOT NULL,project_id text NOT NULL,receipt_key text NOT NULL,record jsonb NOT NULL,PRIMARY KEY(tenant_id,project_id,receipt_key),FOREIGN KEY(tenant_id,project_id) REFERENCES camery_versioning.projects(tenant_id,project_id))`);receiptTableCreated=true;});
afterAll(async()=>{try{if(receiptTableCreated)await pool.query(`DROP TABLE ${receiptTable}`);}finally{await pool.end();}});

it('persists an explicit v08 upgrade and typed episode ledger across fresh pools without rewriting v07 history or bypassing revoked authority',async()=>{
  const target=key(),store=new PostgresVersionStore(pool),baseline=makeOutlinePackage();baseline.project.id=target.projectId;
  try{
    const initial=await store.initialize(target,baseline),upgrade=continuityUpgrade(),pending=await store.submit(target,upgrade);expect(pending.status).toBe('candidate');expect(pending.state.head).toEqual(baseline);
    expect((await store.adopt(target,upgrade.id,{...approval(target),scope:{kind:'episode',id:baseline.episodes[0]!.id}})).issues.map(issue=>issue.code)).toContain('SCHEMA_UPGRADE_PROJECT_ONLY');expect((await store.read(target))!.state.head).toEqual(baseline);
    const upgraded=await store.adopt(target,upgrade.id,approval(target));expect(upgraded.status).toBe('adopted');expect(upgraded.state.revisions).toEqual(initial.state.revisions);if(upgraded.state.head.schema_version!=='0.8.0-draft')throw new Error('Expected actual v08 head');
    const command=continuityAdd(upgraded.state.head),episodeApproval={...approval(target),scope:{kind:'episode' as const,id:baseline.episodes[0]!.id}};expect((await store.submit(target,command)).status).toBe('candidate');expect((await store.adopt(target,command.id,{...episodeApproval,scope:{kind:'episode',id:id('wrong-episode')}})).issues.map(issue=>issue.code)).toContain('ADOPTION_SCOPE');
    const adopted=await store.adopt(target,command.id,episodeApproval);expect(adopted.status).toBe('adopted');const committed=await counts(target);
    const replacement=new Pool({connectionString:url,max:1});try{
      const next=new PostgresVersionStore(replacement),restored=(await next.read(target))!;expect(restored.state).toEqual(adopted.state);expect(await next.read({...target,tenantId:id(randomUUID())})).toBeNull();
      for(const request of [upgrade,command])expect((await next.submit(target,request)).state).toEqual(adopted.state);
      expect((await next.adopt(target,upgrade.id,approval(target))).state).toEqual(adopted.state);expect((await next.adopt(target,command.id,episodeApproval)).state).toEqual(adopted.state);expect(await counts(target)).toEqual(committed);
      expect((await next.adopt(target,command.id,{...episodeApproval,authorize:()=>false})).issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');expect((await next.read(target))!.state).toEqual(adopted.state);expect(await counts(target)).toEqual(committed);
      const old=(await pool.query<{package:unknown}>('SELECT package FROM camery_versioning.snapshots WHERE tenant_id=$1 AND project_id=$2 AND revision=5',[target.tenantId,target.projectId])).rows[0]!.package;expect(old).toEqual(baseline);
      const wire=(await pool.query<{record:{request:unknown;preview:{schema_version:string}}}>('SELECT record FROM camery_versioning.changes WHERE tenant_id=$1 AND project_id=$2 ORDER BY sequence',[target.tenantId,target.projectId])).rows;expect(wire.map(row=>row.record.request)).toEqual([upgrade,command]);expect(wire.map(row=>row.record.preview.schema_version)).toEqual(['0.8.0-draft','0.8.0-draft']);expect(committed[0]).toBe(3);
    }finally{await replacement.end();}
  }finally{await cleanup(target);}
});
it('preserves all four typed ledgers and exact evidence, then applies owner unlock with native history and episode ownership',async()=>{
  const target=key(),store=new PostgresVersionStore(pool),baseline=makeContinuityPackage();baseline.project.id=target.projectId;const snapshot=completeContinuitySnapshot(baseline),lock={id:id('continuity-pg-lock'),version:1,target:snapshot.id,fields:['ledger'],owner_id:id('user_1'),reason:'已核对的前集账本。'};baseline.continuity_snapshots.push(snapshot);baseline.locks.push(lock);
  const ledger=structuredClone(snapshot.ledger);ledger.characters[0]!.value.summary='人工明确决定带着疑问继续核对。';
  const operation={op_id:id('continuity-pg-edit-op'),op:'update' as const,collection:'continuity_snapshots' as const,target:snapshot.id,set:{ledger}},blocked=ChangeSetV08.parse({...changeSet([operation]),schema_version:'0.8.0-draft',id:id('continuity-pg-locked-edit'),base_revisions:[{id:snapshot.id,version:1}]});
  try{
    await store.initialize(target,baseline);expect((await store.submit(target,blocked)).issues.map(issue=>issue.code)).toContain('LOCKED');expect((await store.read(target))!.state.head).toEqual(baseline);
    const request=ChangeSetV08.parse({...blocked,id:id('continuity-pg-unlock-edit'),base_revisions:[...blocked.base_revisions,{id:lock.id,version:1}],ops:[{op_id:id('continuity-pg-unlock-op'),op:'unlock',lock_id:lock.id,reason:'明确允许本次人物状态修订。'},operation]});expect((await store.submit(target,request)).status).toBe('candidate');
    const episodeApproval={...approval(target),scope:{kind:'episode' as const,id:snapshot.episode_id}};expect((await store.adopt(target,request.id,{...episodeApproval,actor:{kind:'user',id:id('other-human')}})).issues.map(issue=>issue.code)).toContain('LOCK_AUTHORITY');
    const adopted=await store.adopt(target,request.id,episodeApproval);expect(adopted.status).toBe('adopted');if(adopted.state.head.schema_version!=='0.8.0-draft')throw new Error('Expected actual v08 head');expect(adopted.state.head.continuity_snapshots[0]).toEqual({...snapshot,version:2,ledger});
    expect(adopted.state.head.continuity_snapshots[0]!.ledger.facts).toEqual(snapshot.ledger.facts);expect(adopted.state.head.continuity_snapshots[0]!.ledger.knowledge).toEqual(snapshot.ledger.knowledge);expect(adopted.state.head.continuity_snapshots[0]!.ledger.threads).toEqual(snapshot.ledger.threads);expect(adopted.state.head.locks).not.toContainEqual(lock);
    const history=adopted.state.revisions.filter(row=>row.object_id===snapshot.id);expect(history.map(row=>({version:row.version,parent:row.parent_version}))).toEqual([{version:1,parent:null},{version:2,parent:1}]);expect(history[0]!.value).toEqual(snapshot);expect(history[1]!.value).toEqual({...snapshot,version:2,ledger});
    const replacement=new Pool({connectionString:url,max:1});try{const next=new PostgresVersionStore(replacement);expect((await next.read(target))!.state).toEqual(adopted.state);expect((await next.adopt(target,request.id,episodeApproval)).state).toEqual(adopted.state);}finally{await replacement.end();}
  }finally{await cleanup(target);}
});
it('rolls back the typed native ledger and receipt together, then recovers one actual commit after losing its ACK',async()=>{
  const target=key(),store=new PostgresVersionStore(pool),baseline=makeContinuityPackage();baseline.project.id=target.projectId;const command=continuityAdd(baseline,'continuity-pg-receipt-snapshot');
  const saved=async()=>(await pool.query<{record:ReturnType<typeof outcome>}>(`SELECT record FROM ${receiptTable} WHERE tenant_id=$1 AND project_id=$2`,[target.tenantId,target.projectId])).rows;
  const receipt:VersionTransactionReceipt=async(client,result)=>{await client.query(`INSERT INTO ${receiptTable}(tenant_id,project_id,receipt_key,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,[target.tenantId,target.projectId,'continuity-adopt',JSON.stringify(outcome(result))]);};
  try{
    await store.initialize(target,baseline);expect((await store.submit(target,command)).status).toBe('candidate');const pending=(await store.read(target))!,beforeCounts=await counts(target),expectation={expectedSnapshotRevision:5,expectedWriteVersion:pending.writeVersion};
    await expect(store.adoptGuarded(target,command.id,{...approval(target),expectation},async()=>{},async(client,result,context)=>{await receipt(client,result,context);throw new Error('Synthetic continuity receipt failure after real INSERT');})).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(await saved()).toEqual([]);expect(await store.read(target)).toEqual(pending);expect(await counts(target)).toEqual(beforeCounts);
    let lose=true;const observed=new PostgresVersionStore(lostCommitPool(()=>{if(lose){lose=false;throw new Error('Synthetic continuity committed ACK lost');}})),guard=vi.fn(async()=>{});
    await expect(observed.adoptGuarded(target,command.id,{...approval(target),expectation},guard,receipt)).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(guard).toHaveBeenCalledOnce();
    const replacement=new Pool({connectionString:url,max:1});try{
      const next=new PostgresVersionStore(replacement),actual=(await next.read(target))!;expect(actual.state.changes.find(row=>row.request.id===command.id)!.status).toBe('adopted');expect(actual.state.adoptions).toHaveLength(1);if(actual.state.head.schema_version!=='0.8.0-draft')throw new Error('Expected recovered v08 head');expect(actual.state.head.continuity_snapshots).toHaveLength(1);expect(actual.state.head.continuity_snapshots[0]!.id).toBe(id('continuity-pg-receipt-snapshot'));
      expect((await saved()).map(row=>row.record)).toEqual([outcome({state:actual.state,status:'adopted',issues:[],warnings:[],writeVersion:actual.writeVersion})]);
      const committed=await counts(target),replayGuard=vi.fn(async()=>{throw new Error('A known adopted native ledger must not rerun the source guard');}),authorize=vi.fn(()=>true);const replay=await next.adoptGuarded(target,command.id,{...approval(target),authorize,expectation},replayGuard,receipt);expect(replay.state).toEqual(actual.state);expect(replay.writeVersion).toBe(actual.writeVersion);expect(replayGuard).not.toHaveBeenCalled();expect(authorize).toHaveBeenCalledWith(approval(target).actor,target,approval(target).scope);expect(await saved()).toHaveLength(1);expect(await counts(target)).toEqual(committed);
    }finally{await replacement.end();}
  }finally{await cleanup(target);}
});
