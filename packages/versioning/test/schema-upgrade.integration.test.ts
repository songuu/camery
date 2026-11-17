import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {ChangeSetV06,SCHEMA_VERSION} from '@camery/ir';
import {migrateVersioning,PostgresVersionStore} from '../src/node/index';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';
const url=process.env['CAMERY_TEST_DATABASE_URL'];if(!url)throw new Error('CAMERY_TEST_DATABASE_URL required for schema upgrade integration');
const pool=new Pool({connectionString:url});const key={tenantId:id(randomUUID()),projectId:id('prj_demo')};
const approval={actor:{kind:'user' as const,id:id('user_1')},scope:{kind:'project' as const,id:key.projectId},at:'2026-11-17T04:00:00.000Z',authorize:()=>true};
beforeAll(async()=>{await migrateVersioning(pool);});
afterAll(async()=>{const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}});
it('restores old pending semantics through new pools and explicitly upgrades the persisted head without rewriting old requests or object history',async()=>{
  const store=new PostgresVersionStore(pool);await store.initialize(key,makePackage());
  const legacy=changeSet([{op_id:id('op-pre-upgrade'),op:'update',collection:'shots',target:id('sh_1'),set:{action:'升级前人工确认的修改。'}}],{id:id('pre-upgrade'),base_revisions:[{id:id('sh_1'),version:1}]});await store.submit(key,legacy);
  const pending=(await store.read(key))!;const upgrade=ChangeSetV06.parse({...legacy,schema_version:SCHEMA_VERSION,id:id('schema-upgrade'),base_revisions:[],ops:[{op_id:id('op-upgrade'),op:'upgrade_schema',from:'0.5.0-draft',to:SCHEMA_VERSION}]});
  const blocked=await store.submit(key,upgrade);expect(blocked.issues[0]!.code).toBe('SCHEMA_UPGRADE_PENDING_CHANGES');expect(await store.read(key)).toEqual(pending);
  const replacement=new Pool({connectionString:url});try{
    const next=new PostgresVersionStore(replacement);expect(await next.read(key)).toEqual(pending);const adoptedLegacy=await next.adopt(key,legacy.id,approval);expect(adoptedLegacy.status).toBe('adopted');expect(adoptedLegacy.state.head.schema_version).toBe('0.5.0-draft');
    const command={...upgrade,base_revision:adoptedLegacy.state.head.revision.number};const preview=await next.submit(key,command);expect(preview.status).toBe('candidate');expect(preview.state.head.schema_version).toBe('0.5.0-draft');expect(preview.state.changes.find(change=>change.request.id===command.id)!.preview!.schema_version).toBe(SCHEMA_VERSION);
    const result=await next.adopt(key,command.id,approval);expect(result.status).toBe('adopted');expect(result.state.head.schema_version).toBe(SCHEMA_VERSION);expect(result.state.revisions).toEqual(adoptedLegacy.state.revisions);expect(result.state.changes[0]).toEqual(adoptedLegacy.state.changes[0]);expect(result.state.adoptions).toHaveLength(2);
    expect((await store.read(key))!.state).toEqual(result.state);expect((await store.submit(key,legacy)).state).toEqual(result.state);expect((await store.adopt(key,legacy.id,approval)).state).toEqual(result.state);expect((await store.adopt(key,command.id,approval)).state).toEqual(result.state);
    expect((await store.adopt(key,command.id,{...approval,authorize:()=>false})).issues[0]!.code).toBe('ADOPTION_AUTHORITY');expect((await store.read(key))!.state).toEqual(result.state);
    expect((await pool.query('SELECT count(*)::int n FROM camery_versioning.snapshots WHERE tenant_id=$1 AND project_id=$2',[key.tenantId,key.projectId])).rows[0]!.n).toBe(3);
    const oldWire=(await pool.query('SELECT record FROM camery_versioning.changes WHERE tenant_id=$1 AND project_id=$2 AND change_id=$3',[key.tenantId,key.projectId,legacy.id])).rows[0]!.record;expect(oldWire.request).toEqual(legacy);expect(oldWire.preview.schema_version).toBe('0.5.0-draft');
  }finally{await replacement.end();}
});
