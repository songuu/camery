import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { migrateBible,PostgresBibleStore } from '@camery/bible/node';
import { migrateIngest } from '../../ingest/src/node/index.js';
import { migrateDevelopment,PostgresDevelopmentStore } from '../src/node/index.js';
import { resolveOutlineSource } from '../src/outline/node/index.js';
import type { OutlineSourceSnapshot } from '../src/outline/generation-contracts.js';
import { createBibleSourceFixture,createDevelopmentSourceFixture,createOutlineProposal } from './outline-source-pg-support.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL is required for outline source integration tests');
const pool=new Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000});const tenants:string[]=[];
beforeAll(async()=>{await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);});
afterAll(async()=>{
  let failed=false;
  try{for(const tenant of tenants){
    for(const table of ['run_origins','reviews','candidates','runs','briefs'])try{await pool.query(`DELETE FROM camery_script.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
    for(const table of ['reviews','candidates','chunks','runs'])try{await pool.query(`DELETE FROM camery_bible.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
    for(const table of ['reading_checkpoints','documents'])try{await pool.query(`DELETE FROM camery_ingest.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
  }}finally{await pool.end();}
  if(failed)throw new Error('Outline source fixture cleanup failed');
});
function scope(){const tenantId='outline-source-'+randomUUID();tenants.push(tenantId);return {tenantId,projectId:'project'};}
const development=()=>createDevelopmentSourceFixture(pool,scope());
const bible=()=>createBibleSourceFixture(pool,scope());
async function propose(source:OutlineSourceSnapshot){
  const {review:reviewed,calls}=await createOutlineProposal(source);
  expect(calls).toBe(1);expect(reviewed.source).toEqual(source);expect(reviewed.actorId).toBe('fixture-editor');return reviewed;
}

// Actual old PG source/audit reads + real adapter protocol; not outline persistence, a live model or a human quality grade.
it('loads stored edited Development audits with a new pool and passes that exact source through one outline call/review',async()=>{
  const f=await development();const source=await resolveOutlineSource(f.descriptor,{development:f.store});
  expect((source.material as {foundation:{title:string}}).foundation.title).toBe('实际数据库中人工改名的港城');
  const replacement=new Pool({connectionString:databaseUrl,max:1});try{expect(await resolveOutlineSource(f.descriptor,{development:new PostgresDevelopmentStore(replacement)})).toEqual(source);}finally{await replacement.end();}
  expect((await propose(source)).output.episodes).toHaveLength(3);
});
it('refuses a stored Development source after its actual brief revision advances',async()=>{
  const f=await development();await f.store.putBrief({...f.put,expectedRevision:1,idea:'已变更的新故事。'});await expect(resolveOutlineSource(f.descriptor,{development:f.store})).rejects.toMatchObject({code:'CONFLICT'});
});
it('loads actual confirmed Bible evidence through a new pool and preserves it in outline generation/review',async()=>{
  const f=await bible();const source=await resolveOutlineSource(f.descriptor,{bible:f.store});
  expect(source.references.some(reference=>reference.path==='/claims/0')).toBe(true);expect(source.material).not.toHaveProperty('document');
  const replacement=new Pool({connectionString:databaseUrl,max:1});try{expect(await resolveOutlineSource(f.descriptor,{bible:new PostgresBibleStore(replacement)})).toEqual(source);}finally{await replacement.end();}
  await propose(source);
});
it('refuses stale Bible documents and does not mistake a damaged original review for an approval',async()=>{
  const f=await bible();await f.documents.append({...f.target,documentId:'book',batchId:'next',expectedRevision:1,text:'新增后文。'});
  await expect(resolveOutlineSource(f.descriptor,{bible:f.store})).rejects.toMatchObject({code:'CONFLICT'});
  const g=await bible();await pool.query("UPDATE camery_bible.reviews SET record=jsonb_set(record,'{actorId}','\"tampered\"'::jsonb) WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3",[g.key.tenantId,g.key.projectId,g.key.runId]);
  await expect(resolveOutlineSource(g.descriptor,{bible:g.store})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
