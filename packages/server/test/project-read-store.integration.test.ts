import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';
import {PostgresProjectReadStore} from '../src/projects/read-store.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for project read tests');
const admin=new Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000});const owned:string[]=[];
beforeAll(async()=>{await migrateVersioning(admin);});
afterAll(async()=>{let failed=false;for(const tenantId of owned){const client=await admin.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1`,[tenantId]);await client.query('COMMIT');}catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}}await admin.end();if(failed)throw new Error('Project read fixture cleanup failed');});
async function fixture(){const tenantId=id('read-store-'+randomUUID());owned.push(tenantId);const target={tenantId,projectId:id('prj_demo')};const versions=new PostgresVersionStore(admin);await versions.initialize(target,makePackage());return {target,versions,reads:new PostgresProjectReadStore(admin)};}
const author={kind:'user' as const,id:id('user_1')};
const at='2026-11-17T09:00:00.000Z';
it('reads real committed headers, candidate counts and native object history without a second fact store',async()=>{
  const f=await fixture();const baseline=await f.reads.head(f.target);expect(baseline).toMatchObject({writeVersion:1,pendingCount:0,head:{revision:{number:5}}});
  const request=changeSet([{op:'update',op_id:id('read-update-op'),collection:'shots',target:id('sh_1'),set:{action:'历史读取中的实际修改'}}],{id:id('read-update'),base_revisions:[{id:id('sh_1'),version:1}]});
  await f.versions.submit(f.target,request);expect(await f.reads.head(f.target)).toMatchObject({writeVersion:2,pendingCount:1,head:{revision:{number:5}}});
  const adopted=await f.versions.adopt(f.target,request.id,{actor:author,scope:{kind:'project',id:f.target.projectId},at,authorize:()=>true});expect(adopted.status).toBe('adopted');
  const reopened=new Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:5000});try{
    const read=new PostgresProjectReadStore(reopened);expect(await read.head(f.target)).toMatchObject({writeVersion:3,pendingCount:0,head:{revision:{number:6}}});
    const page=await read.history({target:f.target,collection:'shots',objectId:id('sh_1'),expectedRevision:6,limit:1});expect(page?.items).toHaveLength(1);expect(page?.items[0]).toMatchObject({version:2,parent_version:1,snapshot_revision:6,change_set_id:request.id,value:{action:'历史读取中的实际修改'}});
    const previous=await read.history({target:f.target,collection:'shots',objectId:id('sh_1'),expectedRevision:6,beforeVersion:2,limit:51});expect(previous?.items).toHaveLength(1);expect(previous?.items[0]).toMatchObject({version:1,parent_version:null,snapshot_revision:5,change_set_id:null});
    await expect(read.history({target:f.target,collection:'shots',objectId:id('sh_1'),expectedRevision:5,limit:51})).rejects.toMatchObject({code:'SNAPSHOT_STALE'});
  }finally{await reopened.end();}
});
it('retains an actually deleted object as a versioned tombstone and distinguishes missing objects/projects',async()=>{
  const f=await fixture();const objectId=id('read-prop');const create=changeSet([{op:'add',op_id:id('read-prop-add-op'),collection:'props',value:{id:objectId,version:1,name:'旧怀表',description:'可移除的独立道具'}}],{id:id('read-prop-add'),base_revisions:[]});
  await f.versions.submit(f.target,create);expect((await f.versions.adopt(f.target,create.id,{actor:author,scope:{kind:'project',id:f.target.projectId},at,authorize:()=>true})).status).toBe('adopted');
  const remove=changeSet([{op:'remove',op_id:id('read-prop-remove-op'),collection:'props',target:objectId}],{id:id('read-prop-remove'),base_revision:6,base_revisions:[{id:objectId,version:1}]});await f.versions.submit(f.target,remove);expect((await f.versions.adopt(f.target,remove.id,{actor:author,scope:{kind:'project',id:f.target.projectId},at,authorize:()=>true})).status).toBe('adopted');
  const history=await f.reads.history({target:f.target,collection:'props',objectId,expectedRevision:7,limit:51});expect(history?.items.map(row=>({version:row.version,value:row.value}))).toEqual([{version:2,value:null},{version:1,value:{id:objectId,version:1,name:'旧怀表',description:'可移除的独立道具'}}]);
  expect((await f.reads.history({target:f.target,collection:'props',objectId:id('absent'),expectedRevision:7,limit:51}))?.items).toEqual([]);expect((await f.reads.history({target:f.target,collection:'shots',objectId,expectedRevision:7,limit:51}))?.items).toEqual([]);
  expect(await f.reads.head({tenantId:id('missing-tenant'),projectId:f.target.projectId})).toBeNull();expect(await f.reads.history({target:{tenantId:id('missing-tenant'),projectId:f.target.projectId},collection:'props',objectId,expectedRevision:7,limit:51})).toBeNull();
});
it('separates equal project/object IDs under two actual IR tenants and never writes while reading',async()=>{
  const a=await fixture();const b=await fixture();const request=changeSet([{op:'update',op_id:id('read-tenant-op'),collection:'shots',target:id('sh_1'),set:{action:'只属于第二租户'}}],{id:id('read-tenant-change'),base_revisions:[{id:id('sh_1'),version:1}]});await b.versions.submit(b.target,request);await b.versions.adopt(b.target,request.id,{actor:author,scope:{kind:'project',id:b.target.projectId},at,authorize:()=>true});
  const counts=async()=>Promise.all(['snapshots','changes','object_revisions','adoptions'].map(async table=>(await admin.query<{n:string}>(`SELECT count(*)::text n FROM camery_versioning.${table} WHERE tenant_id=ANY($1::text[])`,[[a.target.tenantId,b.target.tenantId]])).rows[0]!.n));const before=await counts();
  expect((await a.reads.head(a.target))?.head.shots.find(row=>row.id===id('sh_1'))?.action).not.toBe('只属于第二租户');expect((await b.reads.head(b.target))?.head.shots.find(row=>row.id===id('sh_1'))?.action).toBe('只属于第二租户');
  expect((await a.reads.history({target:a.target,collection:'shots',objectId:id('sh_1'),expectedRevision:5,limit:51}))?.items).toHaveLength(1);expect((await b.reads.history({target:b.target,collection:'shots',objectId:id('sh_1'),expectedRevision:6,limit:51}))?.items).toHaveLength(2);expect(await counts()).toEqual(before);
});
