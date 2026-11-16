import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { reviewFixture } from './review-support.js';
import { captureSource } from '../src/data.js';
import { PostgresBibleCatalog } from '../src/node/catalog.js';

const key={tenantId:'tenant',projectId:'project',runId:'research'};
const source=captureSource(reviewFixture().source).source;
const row=()=>({tenant_id:'tenant',project_id:'project',run_id:'research',document_id:'book',source_kind:'novel',created_at:'2026-11-16T10:00:00.123456Z',source,
  completed_chunks:0,total_chunks:3,candidate_digest:null,review_status:null,source_changed:false,next_chunk_id:'chunk-0'});
function db(rows:unknown[]=[row()]){const query=vi.fn(async(_sql:string,_values:unknown[])=>({rows}));return {catalog:new PostgresBibleCatalog({query} as unknown as Pool),query};}
it('projects metadata without selecting source snapshots, records or model configuration',async()=>{
  const x=db();const result=await x.catalog.list({tenantId:'tenant',projectId:'project'});expect(result.items[0]).toMatchObject({runId:'research',createdAt:'2026-11-16T10:00:00.123Z',completedChunks:0,totalChunks:3,sourceChanged:false});
  expect(result.items[0]!.source).not.toHaveProperty('tenantId');expect(result.nextCursor).toBeNull();
  const sql=x.query.mock.calls[0]![0];expect(sql).not.toMatch(/r\.source[,\s]|r\.execution|r\.method|\.record\b|\.candidate\b/);
});
it('uses a scope/filter-bound microsecond cursor and stable C-collation keyset, never OFFSET',async()=>{
  const rows=Array.from({length:21},(_,i)=>({...row(),run_id:'run-'+String(21-i).padStart(2,'0')}));const x=db(rows);
  const first=await x.catalog.list({tenantId:'tenant',projectId:'project',documentId:'book',kind:'novel',pendingOnly:true});expect(first.items).toHaveLength(20);expect(first.nextCursor).not.toBeNull();
  const cursor=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString('utf8'));expect(cursor.at).toBe('2026-11-16T10:00:00.123456Z');
  await x.catalog.list({tenantId:'tenant',projectId:'project',documentId:'book',kind:'novel',pendingOnly:true,cursor:first.nextCursor!});
  const [sql,values]=x.query.mock.calls[1]!;expect(sql).toContain('COLLATE "C"');expect(sql).not.toContain('OFFSET');expect(values).toContain(cursor.at);
  await expect(x.catalog.list({tenantId:'tenant',projectId:'other',cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
it('finds the actual first missing chunk rather than deriving an id from completed count',async()=>{
  const x=db([{...row(),completed_chunks:2,next_chunk_id:'chunk-middle'}]);expect(await x.catalog.summary(key)).toMatchObject({nextChunkId:'chunk-middle',summary:{completedChunks:2}});
  expect(x.query.mock.calls[0]![0]).toContain('WITH ORDINALITY');
});
it('checks input before querying, catches absent or corrupt metadata, and redacts driver failures',async()=>{
  const x=db();for(const input of [{tenantId:'tenant\n',projectId:'project'},{tenantId:'tenant',projectId:'project',cursor:'bad'}, {...key,extra:true}])await expect(x.catalog.list(input as never)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(x.query).not.toHaveBeenCalled();
  await expect(db([]).catalog.summary(key)).rejects.toMatchObject({code:'NOT_FOUND'});
  for(const bad of [{created_at:'bad'},{source:{...source,tenantId:'other'}},{completed_chunks:4},{review_status:'confirmed'},{next_chunk_id:null},{candidate_digest:'bad'},{document_id:'wrong'}])await expect(db([{...row(),...bad}]).catalog.summary(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const broken=new PostgresBibleCatalog({query:async()=>{throw new Error('PRIVATE_URL');}} as unknown as Pool);await expect(broken.summary(key)).rejects.toThrow('catalog');
});
it('rejects noncanonical, truncated, invalid-date and wrong-scope cursor envelopes before SQL',async()=>{
  const x=db(Array.from({length:21},()=>row()));const page=await x.catalog.list({tenantId:'tenant',projectId:'project'});const cursor=JSON.parse(Buffer.from(page.nextCursor!,'base64url').toString());
  for(const value of ['!',page.nextCursor!+'=',Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({...cursor,at:'2026-02-30T10:00:00.123456Z'})).toString('base64url'),Buffer.from(JSON.stringify({...cursor,at:'9999-99-99T10:00:00.123456Z'})).toString('base64url')])await expect(x.catalog.list({tenantId:'tenant',projectId:'project',cursor:value})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(x.query).toHaveBeenCalledOnce();
});
it('rejects overfull or mismatched rows and reports complete runs without a next chunk',async()=>{
  await expect(db(Array.from({length:22},()=>row())).catalog.list({tenantId:'tenant',projectId:'project'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  await expect(db([row(),row()]).catalog.summary(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  for(const patch of [{run_id:'other'},{created_at:'2026-02-30T10:00:00.123456Z'},{project_id:'other'},{source:{...source,projectId:'other'}},{source_kind:'script'}, {candidate_digest:'0'.repeat(64)}, {completed_chunks:3,next_chunk_id:'left'}])await expect(db([{...row(),...patch}]).catalog.summary(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const complete=db([{...row(),completed_chunks:3,candidate_digest:'0'.repeat(64),review_status:'confirmed',next_chunk_id:null,source_changed:true}]);expect(await complete.catalog.summary(key)).toMatchObject({nextChunkId:null,summary:{reviewStatus:'confirmed',sourceChanged:true}});
});
