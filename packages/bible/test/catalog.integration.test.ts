import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrateIngest, PostgresDocumentStore, PostgresScriptStore } from '@camery/ingest/node';
import { hash } from '../src/data.js';
import { PostgresBibleCatalog } from '../src/node/catalog.js';
import { migrateBible } from '../src/node/migrate.js';
import { PostgresBibleStore } from '../src/node/store.js';
import { reviewFixture } from './review-support.js';
import type { BibleRun, StartBibleRun } from '../src/node/contracts.js';

const url=process.env['CAMERY_TEST_DATABASE_URL'];if(!url)throw new Error('CAMERY_TEST_DATABASE_URL required for Bible catalog tests');
const pool=new Pool({connectionString:url});const tenantId='bible-catalog-'+randomUUID();const projectId='project';const store=new PostgresBibleStore(pool);const catalog=new PostgresBibleCatalog(pool);const documents=new PostgresDocumentStore(pool);const fx=reviewFixture();
beforeAll(async()=>{await migrateIngest(pool);await migrateBible(pool);await documents.append({tenantId,projectId,documentId:'book',batchId:'first',expectedRevision:0,text:fx.source.document.text});});
afterAll(async()=>{
  for(const table of ['reviews','candidates','chunks','runs'])await pool.query(`DELETE FROM camery_bible.${table} WHERE tenant_id=$1`,[tenantId]);
  await pool.query('DELETE FROM camery_ingest.documents WHERE tenant_id=$1',[tenantId]);await pool.query('DELETE FROM camery_ingest.scripts WHERE tenant_id=$1',[tenantId]);await pool.end();
});
function command(runId:string):StartBibleRun{return {tenantId,projectId,runId,documentId:'book',kind:'novel',expectedRevision:1,expectedSourceDigest:fx.source.document.sourceDigest,method:fx.candidate.method,chunkLimits:{maxCharacters:22,maxBytes:88},execution:{connectionId:'fixture',modeDigest:hash('fixture-mode'),modelIdentity:'fixture-model',evidence:'synthetic_replay',modelTier:'economy',currency:'CNY',reservation:{tokens:10,costMicros:0},limits:{steps:10,tokens:100,costMicros:0}}};}
function recordsFor(run:BibleRun){return fx.candidate.records.map((record,index)=>{const body={version:1 as const,planDigest:run.plan.digest,chunkId:run.plan.chunks[index]!.id,method:run.method,output:record.output,model:{...record.model,tenantId}};return {...body,digest:hash(body)};});}
it('keeps tied/submillisecond creation times across keyset pages and isolates project/tenant filters',async()=>{
  for(let index=0;index<25;index++)await store.start(command('page-'+String(index).padStart(2,'0')));
  // Rows deliberately share milliseconds: cursors must retain all six PostgreSQL digits.
  await pool.query("UPDATE camery_bible.runs SET created_at=CASE WHEN run_id>'page-03' THEN '2026-11-16T10:00:00.123456Z'::timestamptz ELSE '2026-11-16T10:00:00.123455Z'::timestamptz END WHERE tenant_id=$1",[tenantId]);
  const first=await catalog.list({tenantId,projectId,kind:'novel',documentId:'book'});expect(first.items).toHaveLength(20);expect(first.items[0]!.runId).toBe('page-24');expect(first.nextCursor).not.toBeNull();
  const second=await catalog.list({tenantId,projectId,kind:'novel',documentId:'book',cursor:first.nextCursor!});const ids=[...first.items,...second.items].map(row=>row.runId);
  expect(ids).toEqual(Array.from({length:25},(_,index)=>'page-'+String(24-index).padStart(2,'0')));expect(second.nextCursor).toBeNull();
  for(const scope of [{tenantId:'other',projectId},{tenantId,projectId:'other'},{tenantId,projectId,kind:'script' as const},{tenantId,projectId,documentId:'other'}])expect((await catalog.list(scope)).items).toEqual([]);
  const schema=await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname='camery_bible' AND indexname='bible_runs_catalog_idx'");expect(schema.rows[0].indexdef).toContain('COLLATE "C" DESC');
});
it('projects out-of-order chunks, excludes materialized runs from the worker scan and observes source metadata changes',async()=>{
  const key={tenantId,projectId,runId:'progress'};const run=await store.start(command(key.runId));const records=recordsFor(run);
  await store.saveChunk(key,records.at(-1)!);expect(await catalog.summary(key)).toMatchObject({nextChunkId:run.plan.chunks[0]!.id,summary:{completedChunks:1,sourceChanged:false}});
  for(const record of records)await store.saveChunk(key,record);await store.materialize(key);const summary=await catalog.summary(key);expect(summary.nextChunkId).toBeNull();expect(summary.summary.candidateDigest).not.toBeNull();
  expect((await catalog.list({tenantId,projectId,pendingOnly:true})).items.some(row=>row.runId===key.runId)).toBe(false);
  await documents.append({tenantId,projectId,documentId:'book',batchId:'next',expectedRevision:1,text:'新增章节。'});expect((await catalog.summary(key)).summary.sourceChanged).toBe(true);
  expect((await store.read(key)).run.source.document.text).toBe(fx.source.document.text);expect(await store.isCurrent(key)).toBe(false);
  await expect(catalog.summary({...key,tenantId:'other'})).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('compares immutable script metadata and reports a missing source without reading its body',async()=>{
  const imported=await new PostgresScriptStore(pool).import({tenantId,projectId,documentId:'script',title:'脚本',format:'fountain',bytes:Buffer.from('INT. STATION - DAY\n\nLIN\nHello.\n')});
  const key={tenantId,projectId,runId:'script-run'};const base=command(key.runId);await store.start({...base,documentId:'script',kind:'script',expectedSourceDigest:imported.document.sourceDigest});
  expect((await catalog.summary(key)).summary).toMatchObject({source:{kind:'script',format:'fountain'},sourceChanged:false});
  await pool.query('DELETE FROM camery_ingest.scripts WHERE tenant_id=$1 AND document_id=$2',[tenantId,'script']);expect((await catalog.summary(key)).summary.sourceChanged).toBe(true);
});
