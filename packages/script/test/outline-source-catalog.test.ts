import { expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresOutlineSourceCatalog } from '../src/outline/node/source-catalog.js';

const scope={tenantId:'tenant',projectId:'project'};
const digest=(letter:string)=>letter.repeat(64);
const stamp='2026-11-17T12:00:00.123456Z';
function row(kind:'development'|'bible'='development',runId='source'){
  const base={kind,tenant_id:'tenant',project_id:'project',run_id:runId,run_digest:digest('a'),created_at:stamp};
  return kind==='development'?{...base,brief_digest:digest('b'),foundation_candidate_digest:digest('c'),foundation_review_status:'reviewed',foundation_review_digest:digest('d'),
    episodes_candidate_digest:digest('e'),episodes_review_status:'reviewed',episodes_review_digest:digest('f')}:
    {...base,document_id:'book',source_tenant_id:'tenant',source_project_id:'project',source_document_id:'book',source_kind:'novel',plan_source_kind:'novel',revision:'2',source_digest:digest('b'),candidate_digest:digest('c'),review_status:'confirmed',review_digest:digest('d')};
}
function fixture(rows:unknown[]=[row()]){
  const query=vi.fn(async(_sql:string,_values:unknown[])=>({rows}));const pool={query};
  return {rows,query,pool,catalog:new PostgresOutlineSourceCatalog(pool as unknown as Pool)};
}
it.each(['development','bible'] as const)('projects compact %s selections and preserves scope only inside SQL',async kind=>{
  const f=fixture([row(kind)]);const page=await f.catalog.list({...scope,kind});
  expect(page.items).toHaveLength(1);expect(page.items[0]).toEqual({createdAt:'2026-11-17T12:00:00.123Z',source:kind==='development'?
    {kind,runId:'source',runDigest:digest('a'),briefDigest:digest('b'),foundationReviewDigest:digest('d'),episodesReviewDigest:digest('f')}:
    {kind,runId:'source',runDigest:digest('a'),documentId:'book',revision:2,sourceDigest:digest('b'),reviewDigest:digest('d')}});
  expect(page.nextCursor).toBeNull();expect(Object.isFrozen(page.items[0]!.source)).toBe(true);
  const [sql,values]=f.query.mock.calls[0]!;expect(values).toEqual(['tenant','project']);expect(sql).toContain('r.tenant_id=$1 AND r.project_id=$2');
  expect(sql).toContain('LIMIT 21');expect(sql).not.toMatch(/\.record\b|\.execution\b|\.method\b|SELECT\s+\*|r\.plan\s+AS/);
  expect(JSON.stringify(page)).not.toMatch(/tenantId|projectId|candidate_digest|review_status|sourceChanged/);
});
it('requires the actual inherited foundation owner and both reviewed Development stages with candidates',async()=>{
  const f=fixture();await f.catalog.list({...scope,kind:'development'});const sql=f.query.mock.calls[0]![0];
  expect(sql).toContain('LEFT JOIN camery_script.run_origins origin');
  expect(sql).toContain('fc.run_id=COALESCE(origin.foundation_run_id,r.run_id)');expect(sql).toContain('fv.run_id=COALESCE(origin.foundation_run_id,r.run_id)');
  for(const alias of ['origin','fc','fv','ec','ev']){expect(sql).toContain(`${alias}.tenant_id=r.tenant_id`);expect(sql).toContain(`${alias}.project_id=r.project_id`);}
  expect(sql).toContain("fc.stage='foundation'");expect(sql).toContain("fv.status='reviewed'");expect(sql).toContain("ec.stage='episodes'");expect(sql).toContain("ev.status='reviewed'");
  expect(sql).toContain('JOIN camery_script.candidates fc');expect(sql).toContain('JOIN camery_script.candidates ec');
});
it('requires a confirmed Bible with candidate and selects only bounded source identity scalars',async()=>{
  const f=fixture([row('bible')]);await f.catalog.list({...scope,kind:'bible'});const sql=f.query.mock.calls[0]![0];
  expect(sql).toContain('JOIN camery_bible.candidates c');expect(sql).toContain("v.status='confirmed'");
  for(const alias of ['c','v']){expect(sql).toContain(`${alias}.tenant_id=r.tenant_id`);expect(sql).toContain(`${alias}.project_id=r.project_id`);}
  expect(sql).toContain("r.plan->'source'->>'sourceDigest'");expect(sql).not.toContain("r.plan->'source' AS");
});
it.each(['development','bible'] as const)('paginates %s with exact microseconds and a scope/kind bound keyset',async kind=>{
  const f=fixture(Array.from({length:21},(_,index)=>row(kind,'source-'+String(21-index).padStart(2,'0'))));
  const page=await f.catalog.list({...scope,kind});expect(page.items).toHaveLength(20);expect(page.nextCursor).toBeTruthy();
  const cursor=JSON.parse(Buffer.from(page.nextCursor!,'base64url').toString());expect(cursor.at).toBe(stamp);expect(cursor.runId).toBe('source-02');
  f.rows.splice(0,20);const next=await f.catalog.list({...scope,kind,cursor:page.nextCursor!});expect(next.items[0]!.source.runId).toBe('source-01');expect(next.nextCursor).toBeNull();
  const [sql,values]=f.query.mock.calls[1]!;expect(sql).toContain('(r.created_at,r.run_id COLLATE "C") < ($3::timestamptz,$4::text COLLATE "C")');
  expect(sql).toContain('ORDER BY r.created_at DESC,r.run_id COLLATE "C" DESC');expect(sql).not.toContain('OFFSET');expect(values).toEqual(['tenant','project',stamp,'source-02']);
  for(const changed of [{tenantId:'other'},{projectId:'other'},{kind:kind==='bible'?'development' as const:'bible' as const}])await expect(f.catalog.list({...scope,kind,cursor:page.nextCursor!,...changed})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
it('rejects noncanonical, invalid-date and wrong-shape cursors before SQL',async()=>{
  const f=fixture(Array.from({length:21},(_,index)=>row('development','source-'+String(21-index).padStart(2,'0'))));
  const page=await f.catalog.list({...scope,kind:'development'});const valid=JSON.parse(Buffer.from(page.nextCursor!,'base64url').toString());f.query.mockClear();
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  for(const cursor of ['!',page.nextCursor!+'=','x'.repeat(513),encode({}),encode({...valid,version:2}),encode({...valid,extra:true}),
    encode({...valid,at:'2026-02-30T12:00:00.123456Z'}),encode({...valid,at:'2026-11-17T12:00:00.123Z'}),encode({...valid,at:'2026-11-17T24:00:00.123456Z'}),encode({...valid,runId:'bad\n'})])
    await expect(f.catalog.list({...scope,kind:'development',cursor})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(f.query).not.toHaveBeenCalled();
});
it('rejects wrong query fields, malformed JSON and getters without evaluating or querying',async()=>{
  const f=fixture();let invoked=0;
  for(const input of [{...scope},{...scope,kind:'other'},{...scope,kind:'development',extra:true},{...scope,kind:'development',tenantId:'bad\n'},
    Object.defineProperty({...scope},'kind',{enumerable:true,get(){invoked++;throw new Error('private');}}),Object.assign(Object.create({inherited:true}),{...scope,kind:'development'})])
    await expect(f.catalog.list(input as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(invoked).toBe(0);expect(f.query).not.toHaveBeenCalled();
});
it.each([
  ['development',{tenant_id:'other'}],['development',{project_id:'other'}],['development',{kind:'bible'}],['development',{run_digest:'bad'}],
  ['development',{foundation_review_status:'rejected'}],['development',{foundation_candidate_digest:null}],['development',{episodes_review_status:'confirmed'}],['development',{episodes_review_digest:'bad'}],
  ['bible',{review_status:'rejected'}],['bible',{candidate_digest:null}],['bible',{source_tenant_id:'other'}],['bible',{source_project_id:'other'}],
  ['bible',{source_document_id:'other'}],['bible',{plan_source_kind:'script'}],['bible',{revision:'9007199254740992'}],['bible',{revision:0}],
] as const)('redacts corrupt %s source metadata %j',async(kind,change)=>{
  const f=fixture([{...row(kind),...change}]);await expect(f.catalog.list({...scope,kind})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('supports script Bible sources and canonical numeric revisions without claiming freshness',async()=>{
  const f=fixture([{...row('bible'),source_kind:'script',plan_source_kind:'script',revision:3}]);
  expect((await f.catalog.list({...scope,kind:'bible'})).items[0]!.source).toMatchObject({kind:'bible',revision:3});
});
it('refuses invalid timestamps, duplicate bindings, wrong ordering and overfull pages',async()=>{
  for(const rows of [[{...row(),created_at:'2026-02-30T12:00:00.123456Z'}],[{...row(),created_at:'2026-11-17T12:00:00.123Z'}],
    [row(),row()],[row('development','a'),row('development','b')],Array.from({length:22},(_,index)=>row('development','source-'+index))])
    await expect(fixture(rows).catalog.list({...scope,kind:'development'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('rejects accessor, extra and oversized metadata without exposing stored values',async()=>{
  let invoked=0;
  for(const value of [Object.defineProperty(row(),'run_id',{enumerable:true,get(){invoked++;throw new Error('private-database-password');}}),{...row(),secret:'private-database-password'},
    {...row(),secret:'x'.repeat(65536)}]){
    const f=fixture([value]);const pending=f.catalog.list({...scope,kind:'development'});await expect(pending).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(pending).rejects.not.toThrow('private-database-password');
  }
  expect(invoked).toBe(0);
});
it('redacts synchronous and rejected database failures and captures input before an await',async()=>{
  for(const query of [()=>{throw new Error('private-database-password');},async()=>{throw new Error('private-database-password');}]){
    const catalog=new PostgresOutlineSourceCatalog({query} as unknown as Pool);await expect(catalog.list({...scope,kind:'development'})).rejects.toThrow('source catalog list');
    await expect(catalog.list({...scope,kind:'development'})).rejects.not.toThrow('private-database-password');
  }
  const f=fixture();let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});f.query.mockImplementation(async()=>{await gate;return {rows:f.rows};});
  const input={...scope,kind:'development' as const};const result=f.catalog.list(input);input.projectId='other';release();expect((await result).items).toHaveLength(1);expect(f.query.mock.calls[0]![1]).toEqual(['tenant','project']);
});
it('redacts query binding failures and rejects result rows accessors without evaluating them',async()=>{
  const pool=Object.defineProperty({},'query',{get(){throw new Error('private-connection');}});
  await expect(new PostgresOutlineSourceCatalog(pool as Pool).list({...scope,kind:'development'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  let invoked=0;const result=Object.defineProperty({},'rows',{get(){invoked++;throw new Error('private-connection');}});
  await expect(new PostgresOutlineSourceCatalog({query:async()=>result} as unknown as Pool).list({...scope,kind:'development'})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(invoked).toBe(0);
});
