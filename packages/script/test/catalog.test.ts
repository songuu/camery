import { expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresDevelopmentCatalog } from '../src/node/catalog.js';
const key={tenantId:'tenant',projectId:'project',runId:'run'};
const row=()=>({tenant_id:'tenant',project_id:'project',run_id:'run',brief_id:'idea',brief_revision:'1',created_at:'2026-11-16T12:00:00.123456Z',source_changed:false,
  foundation_candidate_digest:null,foundation_review_status:null,episodes_candidate_digest:null,episodes_review_status:null});
function db(rows:unknown[]=[row()]){const query=vi.fn(async(_sql:string,_values:unknown[])=>({rows}));return {query,catalog:new PostgresDevelopmentCatalog({query} as unknown as Pool)};}
it('projects compact metadata without selecting story bodies, model profiles or raw audit records',async()=>{
  const f=db();const page=await f.catalog.list({tenantId:'tenant',projectId:'project'});
  expect(page.items[0]).toEqual({runId:'run',briefId:'idea',briefRevision:1,createdAt:'2026-11-16T12:00:00.123Z',sourceChanged:false,foundationCandidateDigest:null,foundationReviewStatus:null,episodesCandidateDigest:null,episodesReviewStatus:null});
  expect(page.nextCursor).toBeNull();const sql=f.query.mock.calls[0]![0];expect(sql).not.toMatch(/\.record\b|\.execution\b|\.methods\b|SELECT\s+\*/);expect(Object.isFrozen(page.items)).toBe(true);
});
it('paginates by a scope/filter-bound six-digit timestamp and C identifier order',async()=>{
  const f=db(Array.from({length:21},(_,index)=>({...row(),run_id:'run-'+String(21-index).padStart(2,'0')})));
  const first=await f.catalog.list({tenantId:'tenant',projectId:'project',briefId:'idea',pendingOnly:true});expect(first.items).toHaveLength(20);expect(first.nextCursor).not.toBeNull();
  const cursor=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString());expect(cursor.at).toBe('2026-11-16T12:00:00.123456Z');
  await f.catalog.list({tenantId:'tenant',projectId:'project',briefId:'idea',pendingOnly:true,cursor:first.nextCursor!});const [sql,values]=f.query.mock.calls[1]!;
  expect(sql).toContain('COLLATE "C"');expect(sql).not.toContain('OFFSET');expect(sql).toContain("fv.status IS DISTINCT FROM 'rejected'");expect(values).toContain(cursor.at);
  for(const changed of [{projectId:'other'},{tenantId:'other'},{briefId:'other'},{pendingOnly:false}])await expect(f.catalog.list({tenantId:'tenant',projectId:'project',briefId:'idea',pendingOnly:true,cursor:first.nextCursor!,...changed})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
it('rejects malformed inputs, accessors and noncanonical cursor encodings before SQL',async()=>{
  const f=db(Array.from({length:21},()=>row()));const first=await f.catalog.list({tenantId:'tenant',projectId:'project'});const cursor=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString());f.query.mockClear();
  for(const value of ['bad','!',first.nextCursor!+'=',Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({...cursor,at:'2026-02-30T12:00:00.123456Z'})).toString('base64url'),Buffer.from(JSON.stringify({...cursor,at:'9999-99-99T12:00:00.123456Z'})).toString('base64url')])await expect(f.catalog.list({tenantId:'tenant',projectId:'project',cursor:value})).rejects.toMatchObject({code:'INVALID_INPUT'});
  for(const input of [{tenantId:'bad\n',projectId:'project'},{tenantId:'tenant',projectId:'project',extra:true},{tenantId:'tenant',projectId:'project',briefId:''}])await expect(f.catalog.list(input as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
  let invoked=false;await expect(f.catalog.summary(Object.defineProperty({...key},'runId',{enumerable:true,get(){invoked=true;throw new Error('private');}}))).rejects.toMatchObject({code:'INVALID_INPUT'});expect(invoked).toBe(false);expect(f.query).not.toHaveBeenCalled();
});
it('checks scope, revisions, timestamps and stage dependency integrity, while allowing historical stale metadata',async()=>{
  const h='a'.repeat(64);
  for(const change of [{tenant_id:'other'},{project_id:'other'},{run_id:'other'},{brief_revision:'9007199254740992'},{created_at:'bad'},{created_at:'2026-02-30T12:00:00.123456Z'},
    {foundation_review_status:'reviewed'},{foundation_review_status:'confirmed'},{foundation_candidate_digest:'bad'},
    {episodes_candidate_digest:h},{foundation_candidate_digest:h,foundation_review_status:'rejected',episodes_candidate_digest:h},
    {foundation_candidate_digest:h,foundation_review_status:'reviewed',episodes_review_status:'reviewed'}])await expect(db([{...row(),...change}]).catalog.summary(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const final=db([{...row(),brief_revision:1,foundation_candidate_digest:h,foundation_review_status:'reviewed',episodes_candidate_digest:h,episodes_review_status:'rejected',source_changed:true}]);expect(await final.catalog.summary(key)).toMatchObject({sourceChanged:true,episodesReviewStatus:'rejected'});
});
it('redacts driver failures and refuses absent, duplicated or overfull metadata rows',async()=>{
  await expect(db([]).catalog.summary(key)).rejects.toMatchObject({code:'NOT_FOUND'});await expect(db([row(),row()]).catalog.summary(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  await expect(db(Array.from({length:22},()=>row())).catalog.list({tenantId:'tenant',projectId:'project'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const f=new PostgresDevelopmentCatalog({query:async()=>{throw new Error('private-db-url');}} as unknown as Pool);
  await expect(f.list({tenantId:'tenant',projectId:'project'})).rejects.toThrow('catalog list');await expect(f.summary(key)).rejects.toThrow('catalog summary');
});
