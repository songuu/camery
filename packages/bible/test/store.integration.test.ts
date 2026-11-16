import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { appendNovelBatch } from '@camery/ingest';
import { migrateIngest, PostgresDocumentStore } from '@camery/ingest/node';
import { reviewFixture } from './review-support.js';
import { hash } from '../src/data.js';
import { PostgresBibleStore } from '../src/node/store.js';
import { migrateBible } from '../src/node/migrate.js';
import type { BibleRun, StartBibleRun } from '../src/node/contracts.js';
const url=process.env['CAMERY_TEST_DATABASE_URL'];if(!url)throw new Error('CAMERY_TEST_DATABASE_URL is required for Bible storage tests');
const pool=new Pool({connectionString:url});const tenants:string[]=[];const template=reviewFixture();
beforeAll(async()=>{await migrateIngest(pool);await migrateBible(pool);});
afterAll(async()=>{
  for(const tenant of tenants){for(const table of ['reviews','candidates','chunks','runs'])await pool.query(`DELETE FROM camery_bible.${table} WHERE tenant_id=$1`,[tenant]);
    await pool.query('DELETE FROM camery_ingest.reading_checkpoints WHERE tenant_id=$1',[tenant]);await pool.query('DELETE FROM camery_ingest.documents WHERE tenant_id=$1',[tenant]);}
  await pool.end();
});
async function fixture(){
  const tenantId='bible-'+randomUUID();tenants.push(tenantId);const key={tenantId,projectId:'project',runId:'research'};const documents=new PostgresDocumentStore(pool);
  await documents.append({tenantId,projectId:'project',documentId:'book',batchId:'first',expectedRevision:0,text:template.source.document.text});
  const command:StartBibleRun={...key,documentId:'book',kind:'novel',expectedRevision:1,expectedSourceDigest:template.source.document.sourceDigest,method:template.candidate.method,chunkLimits:{maxCharacters:22,maxBytes:88},
    execution:{connectionId:'fixture',modeDigest:hash('fixture-mode'),modelIdentity:'fixture-model',evidence:'synthetic_replay',modelTier:'economy',currency:'CNY',reservation:{tokens:10,costMicros:0},limits:{steps:10,tokens:100,costMicros:0}}};
  const store=new PostgresBibleStore(pool);const host={...template.host,tenantId};return {key,documents,command,store,host};
}
function recordsFor(run:BibleRun){return template.candidate.records.map((entry,ordinal)=>{
  const model={...entry.model,tenantId:run.tenantId};const body={version:1 as const,planDigest:run.plan.digest,chunkId:run.plan.chunks[ordinal]!.id,method:run.method,output:entry.output,model};return {...body,digest:hash(body)};
});}
it('serializes initial run/chunk/candidate/review races and reconstructs them through a new database connection',async()=>{
  const x=await fixture();const [run,retry]=await Promise.all([x.store.start(x.command),x.store.start(x.command)]);expect(retry).toEqual(run);
  await expect(x.store.start({...x.command,execution:{...x.command.execution,modelIdentity:'different'}})).rejects.toMatchObject({code:'CONFLICT'});
  const records=recordsFor(run);expect(await Promise.all([x.store.saveChunk(x.key,records[0]!),x.store.saveChunk(x.key,records[0]!)])).toEqual([records[0],records[0]]);
  const altered=structuredClone(records[0]!);altered.model.providerRequestId='different';const {digest:_digest,...body}=altered;Object.assign(altered,{digest:hash(body)});
  await expect(x.store.saveChunk(x.key,altered)).rejects.toMatchObject({code:'CONFLICT'});
  for(const record of records.slice(1))await x.store.saveChunk(x.key,record);const [candidate,duplicate]=await Promise.all([x.store.materialize(x.key),x.store.materialize(x.key)]);expect(duplicate).toEqual(candidate);
  const decision={...template.decision,candidateDigest:candidate.digest};const [review,again]=await Promise.all([x.store.confirm(x.key,decision,x.host),x.store.confirm(x.key,decision,{...x.host,at:'2026-11-17T10:00:00.000Z'})]);expect(again).toEqual(review);
  const replacement=new Pool({connectionString:url});try{const restored=await new PostgresBibleStore(replacement).read(x.key);expect(restored.run).toEqual(run);expect(restored.records).toEqual(records);expect(restored.review).toEqual(review);}
  finally{await replacement.end();}
  const counts=await pool.query('SELECT (SELECT count(*)::int FROM camery_bible.runs WHERE tenant_id=$1) runs,(SELECT count(*)::int FROM camery_bible.chunks WHERE tenant_id=$1) chunks,(SELECT count(*)::int FROM camery_bible.candidates WHERE tenant_id=$1) candidates,(SELECT count(*)::int FROM camery_bible.reviews WHERE tenant_id=$1) reviews',[x.key.tenantId]);
  expect(counts.rows[0]).toEqual({runs:1,chunks:records.length,candidates:1,reviews:1});
  await expect(x.store.read({...x.key,tenantId:'other'})).rejects.toMatchObject({code:'NOT_FOUND'});await expect(x.store.read({...x.key,projectId:'other'})).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('rejects new stale confirmation under the source lock, keeps pinned evidence and permits stale rejection',async()=>{
  const x=await fixture();const run=await x.store.start(x.command);for(const record of recordsFor(run))await x.store.saveChunk(x.key,record);const candidate=await x.store.materialize(x.key);
  const sourceLock=await pool.connect();try{
    await sourceLock.query('BEGIN');await sourceLock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_ingest',x.key.tenantId,'project','book'])]);
    const current=await sourceLock.query('SELECT snapshot FROM camery_ingest.documents WHERE tenant_id=$1 AND project_id=$2 AND document_id=$3',[x.key.tenantId,'project','book']);
    const next=appendNovelBatch(current.rows[0].snapshot,{tenantId:x.key.tenantId,projectId:'project',documentId:'book',batchId:'next',expectedRevision:1,text:'新增的后文。'});
    await sourceLock.query('UPDATE camery_ingest.documents SET snapshot=$4::jsonb,revision=$5 WHERE tenant_id=$1 AND project_id=$2 AND document_id=$3',[x.key.tenantId,'project','book',JSON.stringify(next.snapshot),next.snapshot.revision]);await sourceLock.query('COMMIT');
  }finally{sourceLock.release();}
  expect(await x.store.isCurrent(x.key)).toBe(false);await expect(x.store.confirm(x.key,{...template.decision,candidateDigest:candidate.digest},x.host)).rejects.toMatchObject({code:'CONFLICT'});
  expect((await x.store.read(x.key)).run.source.document).toEqual(run.source.document);const rejected=await x.store.reject(x.key,'来源变更，需要重做。',x.host);expect(rejected.status).toBe('rejected');
  expect(await x.store.reject(x.key,'来源变更，需要重做。',{...x.host,at:'2026-11-17T10:00:00.000Z'})).toEqual(rejected);
});
it('rolls back a record write when acknowledgement fails and safely retries the same input',async()=>{
  const x=await fixture();const run=await x.store.start(x.command);const record=recordsFor(run)[0]!;let fail=true;
  const broken={connect:async()=>{const client=await pool.connect();return {query:async(sql:string,params:unknown[])=>{const result=await client.query(sql,params);if(fail&&sql.startsWith('INSERT INTO camery_bible.chunks')){fail=false;throw new Error('synthetic pre-commit failure');}return result;},release:()=>client.release()};}} as unknown as Pool;
  await expect(new PostgresBibleStore(broken).saveChunk(x.key,record)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect((await x.store.read(x.key)).records).toEqual([]);
  expect(await x.store.saveChunk(x.key,record)).toEqual(record);expect((await x.store.read(x.key)).records).toEqual([record]);
});
