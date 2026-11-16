import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { MethodRegistry } from '@camery/methods';
import { createOriginalFoundationMethodPack,createOriginalEpisodesMethodPack } from '../src/method-assets.js';
import { PostgresDevelopmentStore } from '../src/node/store.js';
import { PostgresDevelopmentCatalog } from '../src/node/catalog.js';
import { migrateDevelopment } from '../src/node/migrate.js';
import type { StartDevelopmentRun } from '../src/node/contracts.js';
const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for development catalog tests');
const pool=new Pool({connectionString:databaseUrl});const tenants:string[]=[];const store=new PostgresDevelopmentStore(pool);const catalog=new PostgresDevelopmentCatalog(pool);
const registry=new MethodRegistry();const methods={foundation:registry.register(createOriginalFoundationMethodPack()),episodes:registry.register(createOriginalEpisodesMethodPack())};
const execution={connectionId:'fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture-model',evidence:'synthetic_replay' as const,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:2,tokens:200,costMicros:0}};
beforeAll(async()=>{await migrateDevelopment(pool);});
afterAll(async()=>{for(const tenantId of tenants)for(const table of ['reviews','candidates','runs','briefs'])await pool.query(`DELETE FROM camery_script.${table} WHERE tenant_id=$1`,[tenantId]);await pool.end();});
async function fixture(){
  const tenantId='development-catalog-'+randomUUID();tenants.push(tenantId);const scope={tenantId,projectId:'project'};
  const put={...scope,briefId:'idea',expectedRevision:0,actorId:'author',idea:'港城邮差收到明天寄出的钟声记录。',episodeCount:10,targetSeconds:120};const saved=await store.putBrief(put);
  const command=(runId:string):StartDevelopmentRun=>({...scope,runId,briefId:'idea',expectedRevision:1,expectedBriefDigest:saved.brief.digest,methods,execution});
  return {scope,put,saved,command};
}
it('paginates tied and submillisecond times without gaps, with exact scope/filter isolation and a matching C index',async()=>{
  const x=await fixture();for(let index=0;index<25;index++)await store.start(x.command('run-'+String(index).padStart(2,'0')));
  await pool.query("UPDATE camery_script.runs SET created_at=CASE WHEN run_id>'run-03' THEN '2026-11-16T12:00:00.123456Z'::timestamptz ELSE '2026-11-16T12:00:00.123455Z'::timestamptz END WHERE tenant_id=$1",[x.scope.tenantId]);
  const first=await catalog.list({...x.scope,briefId:'idea'});expect(first.items).toHaveLength(20);expect(first.items[0]!.runId).toBe('run-24');expect(first.nextCursor).not.toBeNull();
  const cursor=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString());expect(cursor.at).toBe('2026-11-16T12:00:00.123456Z');
  const second=await catalog.list({...x.scope,briefId:'idea',cursor:first.nextCursor!});expect([...first.items,...second.items].map(item=>item.runId)).toEqual(Array.from({length:25},(_,index)=>'run-'+String(24-index).padStart(2,'0')));expect(second.nextCursor).toBeNull();
  for(const changed of [{tenantId:'other'},{projectId:'other'},{briefId:'other'}])expect((await catalog.list({...x.scope,...changed})).items).toEqual([]);
  const index=await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname='camery_script' AND indexname='development_runs_catalog_idx'");expect(index.rows[0].indexdef).toContain('COLLATE "C" DESC');
});
it('projects stage headers only, excludes terminal runs from pending scans and retains dependency invariants',async()=>{
  const x=await fixture();for(const runId of ['awaiting','rejected','finished'])await store.start(x.command(runId));
  // Deliberately non-authoritative payloads prove the catalog never loads or validates raw records.
  // Store.read, not this metadata view, is responsible for rejecting such a payload as an invalid candidate/audit.
  const raw=JSON.stringify({fixture:'metadata-only, not a model result or human approval',padding:'x'.repeat(100000)});
  for(const runId of ['awaiting','rejected','finished'])await pool.query("INSERT INTO camery_script.candidates(tenant_id,project_id,run_id,stage,upstream_digest,digest,record) VALUES($1,$2,$3,'foundation',NULL,$4,$5::jsonb)",[x.scope.tenantId,x.scope.projectId,runId,'a'.repeat(64),raw]);
  for(const [runId,status] of [['rejected','rejected'],['finished','reviewed']])await pool.query("INSERT INTO camery_script.reviews(tenant_id,project_id,run_id,stage,status,request_digest,digest,record) VALUES($1,$2,$3,'foundation',$4,$5,$6,$7::jsonb)",[x.scope.tenantId,x.scope.projectId,runId,status,'b'.repeat(64),'c'.repeat(64),raw]);
  await pool.query("INSERT INTO camery_script.candidates(tenant_id,project_id,run_id,stage,upstream_digest,digest,record) VALUES($1,$2,'finished','episodes',$3,$4,$5::jsonb)",[x.scope.tenantId,x.scope.projectId,'c'.repeat(64),'d'.repeat(64),raw]);
  await pool.query("INSERT INTO camery_script.reviews(tenant_id,project_id,run_id,stage,status,request_digest,digest,record) VALUES($1,$2,'finished','episodes','reviewed',$3,$4,$5::jsonb)",[x.scope.tenantId,x.scope.projectId,'b'.repeat(64),'e'.repeat(64),raw]);
  const pending=await catalog.list({...x.scope,pendingOnly:true});expect(pending.items.map(item=>item.runId)).toEqual(['awaiting']);
  const summary=await catalog.summary({...x.scope,runId:'finished'});expect(summary).toMatchObject({foundationCandidateDigest:'a'.repeat(64),foundationReviewStatus:'reviewed',episodesCandidateDigest:'d'.repeat(64),episodesReviewStatus:'reviewed'});expect(summary).not.toHaveProperty('record');
  await expect(store.read({...x.scope,runId:'finished'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  await expect(catalog.summary({...x.scope,runId:'finished',projectId:'other'})).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('observes a newer brief by revision/digest metadata without replacing the run snapshot',async()=>{
  const x=await fixture();const key={...x.scope,runId:'run'};const run=await store.start(x.command(key.runId));expect((await catalog.summary(key)).sourceChanged).toBe(false);
  await store.putBrief({...x.put,expectedRevision:1,idea:'邮差决定不再独自校准那座钟。'});expect((await catalog.summary(key)).sourceChanged).toBe(true);expect(await store.isCurrent(key)).toBe(false);
  expect((await store.read(key)).run.brief).toEqual(run.brief);
});
