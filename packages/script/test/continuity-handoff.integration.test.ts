import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import type {VersionProjectKey} from '@camery/versioning/node';
import {fixtureId as id,makePackage} from '../../ir/test/fixtures.js';
import {nativeEpisodeSnapshotPins,readAdoptedEpisodeHandoff} from '../src/continuity/node/handoff.js';
const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('Explicit test PostgreSQL is required for continuity handoff integration');
const admin=new Pool({connectionString:databaseUrl,max:3,connectionTimeoutMillis:5000}),targets:VersionProjectKey[]=[];
beforeAll(async()=>{await migrateVersioning(admin);});
afterAll(async()=>{try{for(const target of targets){const client=await admin.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query('DELETE FROM camery_versioning.'+table+' WHERE tenant_id=$1 AND project_id=$2',[target.tenantId,target.projectId]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}}finally{await admin.end();}});
async function fixture(){
  const suffix=randomBytes(12).toString('hex'),baseline=structuredClone(makePackage());baseline.revision.number=1;const target={tenantId:id('continuity-tenant-'+suffix),projectId:baseline.project.id};targets.push(target);const versions=new PostgresVersionStore(admin);await versions.initialize(target,baseline);
  const snapshot={id:id('continuity-snapshot-'+suffix),version:1,episode_id:id('ep_1'),based_on:nativeEpisodeSnapshotPins(baseline,id('ep_1')),status:'adopted',facts:['便签被发现'],knowledge:[{character_id:id('char_lin'),fact:'便签被发现',source:'正式第一集便签事件'}],characters:[],plot_threads:[]};
  const actor={kind:'user' as const,id:id('continuity-human-'+suffix)},request={schema_version:'0.5.0-draft',id:id('continuity-change-'+suffix),author:actor,status:'candidate',base_revision:1,base_revisions:[],ops:[{op:'add',op_id:id('continuity-op-'+suffix),collection:'episode_state_snapshots',value:snapshot}]};
  const prepared=await versions.submit(target,request,{expectation:{expectedSnapshotRevision:1,expectedWriteVersion:1}});expect(prepared.status).toBe('candidate');
  const approval={actor,scope:{kind:'episode' as const,id:id('ep_1')},at:'2026-11-18T13:00:00.000Z',authorize:()=>true,expectation:{expectedSnapshotRevision:1,expectedWriteVersion:2}};
  return {target,versions,snapshot,request,approval,suffix};
}
it('reads an actually adopted four-ledger snapshot through a fresh read-only LOGIN with no writes',async()=>{
  const f=await fixture();expect((await f.versions.adopt(f.target,f.request.id,f.approval)).status).toBe('adopted');const role='ct_reader_'+f.suffix,password=randomBytes(24).toString('hex');let created=false;let reader:Pool|undefined;
  try{
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION`);created=true;
    await admin.query(`GRANT USAGE ON SCHEMA camery_versioning TO "${role}"`);await admin.query(`GRANT SELECT ON camery_versioning.projects,camery_versioning.snapshots,camery_versioning.changes,camery_versioning.object_revisions,camery_versioning.adoptions TO "${role}"`);
    const url=new URL(databaseUrl!);url.username=role;url.password=password;reader=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000});const versions=new PostgresVersionStore(reader),before=await f.versions.read(f.target);
    const result=await readAdoptedEpisodeHandoff(versions,f.target,{episodeId:id('ep_2'),expectedRevision:2});expect(result).toMatchObject({kind:'ready',snapshot:f.snapshot,headRevision:2,snapshotAdoptedRevision:2,writeVersion:3});
    expect(await readAdoptedEpisodeHandoff(versions,f.target,{episodeId:id('ep_2')})).toEqual(result);expect(await f.versions.read(f.target)).toEqual(before);
    await expect(reader.query('UPDATE camery_versioning.projects SET write_version=write_version WHERE tenant_id=$1 AND project_id=$2',[f.target.tenantId,f.target.projectId])).rejects.toMatchObject({code:'42501'});
    await expect(readAdoptedEpisodeHandoff(versions,{...f.target,tenantId:id('foreign-tenant')},{episodeId:id('ep_2')})).rejects.toMatchObject({code:'NOT_FOUND'});
  }finally{await reader?.end();if(created){await admin.query(`DROP OWNED BY "${role}"`);await admin.query(`DROP ROLE "${role}"`);}}
},45000);
it('does not hand a prepared or rolled-back native snapshot to the next episode',async()=>{
  const f=await fixture();await expect(readAdoptedEpisodeHandoff(f.versions,f.target,{episodeId:id('ep_2')})).rejects.toMatchObject({code:'INCOMPLETE'});
  await expect(f.versions.adoptGuarded(f.target,f.request.id,f.approval,async()=>{},async()=>{throw new Error('Owned continuity receipt failure');})).rejects.toMatchObject({code:'DATABASE_ERROR'});
  expect((await f.versions.read(f.target))?.state.head.revision.number).toBe(1);await expect(readAdoptedEpisodeHandoff(f.versions,f.target,{episodeId:id('ep_2')})).rejects.toMatchObject({code:'INCOMPLETE'});
  expect((await f.versions.adopt(f.target,f.request.id,f.approval)).status).toBe('adopted');expect((await readAdoptedEpisodeHandoff(f.versions,f.target,{episodeId:id('ep_2')})).snapshot?.id).toBe(f.snapshot.id);
},45000);
