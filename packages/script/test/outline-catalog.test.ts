import { expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresOutlineCatalog } from '../src/outline/node/catalog.js';

const key={tenantId:'tenant',projectId:'project',runId:'run'};
const digest='a'.repeat(64);
const row=()=>({tenant_id:key.tenantId,project_id:key.projectId,run_id:key.runId,run_digest:digest,brief_id:'brief',brief_revision:'1',
  created_at:'2026-11-17T12:00:00.123456Z',candidate_digest:null as string|null,review_status:null as string|null});
function fixture(rows:unknown[]=[row()]){const query=vi.fn(async(_sql:string,_values:unknown[])=>({rows}));return {rows,query,catalog:new PostgresOutlineCatalog({query} as unknown as Pool)};}

it('projects only immutable run metadata without claiming source freshness or selecting bodies',async()=>{
  const f=fixture();const page=await f.catalog.list({tenantId:key.tenantId,projectId:key.projectId});
  expect(page).toEqual({items:[{runId:'run',runDigest:digest,briefId:'brief',briefRevision:1,createdAt:'2026-11-17T12:00:00.123Z',candidateDigest:null,reviewStatus:null}],nextCursor:null});
  const [sql,values]=f.query.mock.calls[0]!;expect(values).toEqual(['tenant','project']);expect(sql).toContain('r.tenant_id=$1');expect(sql).toContain('r.project_id=$2');
  expect(sql).toContain('camery_outline.runs');expect(sql).not.toMatch(/\.record\b|\.execution\b|SELECT\s+\*|latest|source_changed/);
  expect(Object.isFrozen(page.items)).toBe(true);expect(Object.isFrozen(page.items[0])).toBe(true);
});
it('uses the exact microsecond timestamp and C identifier keyset while binding every filter',async()=>{
  const f=fixture(Array.from({length:21},(_,index)=>({...row(),run_id:'run-'+String(21-index).padStart(2,'0')})));
  const first=await f.catalog.list({tenantId:'tenant',projectId:'project',briefId:'brief'});expect(first.items).toHaveLength(20);expect(first.nextCursor).toBeTruthy();
  const cursor=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString());expect(cursor.at).toBe('2026-11-17T12:00:00.123456Z');expect(cursor.runId).toBe('run-02');
  await f.catalog.list({tenantId:'tenant',projectId:'project',briefId:'brief',cursor:first.nextCursor!});const [sql,values]=f.query.mock.calls[1]!;
  expect(values).toEqual(['tenant','project','brief',cursor.at,cursor.runId]);expect(sql).toContain('r.brief_id=$3');expect(sql).toContain('r.created_at DESC,r.run_id COLLATE "C" DESC');
  expect(sql).toContain('(r.created_at,r.run_id COLLATE "C") < ($4::timestamptz,$5::text COLLATE "C")');expect(sql).toContain('LIMIT 21');expect(sql).not.toContain('OFFSET');
  for(const change of [{tenantId:'other'},{projectId:'other'},{briefId:'other'},{briefId:undefined}])await expect(f.catalog.list({tenantId:'tenant',projectId:'project',briefId:'brief',cursor:first.nextCursor!,...change})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
it('uses the extra row only as a pagination sentinel and handles the last or empty page',async()=>{
  const rows:unknown[]=Array.from({length:20},(_,index)=>({...row(),run_id:'run-'+index}));rows.push({unselected:'not metadata'});const f=fixture(rows);
  expect((await f.catalog.list({tenantId:'tenant',projectId:'project'})).items).toHaveLength(20);rows.splice(0,rows.length,row());
  expect((await f.catalog.list({tenantId:'tenant',projectId:'project'})).nextCursor).toBeNull();rows.splice(0);expect(await f.catalog.list({tenantId:'tenant',projectId:'project'})).toEqual({items:[],nextCursor:null});
});
it('rejects malformed and noncanonical cursors before contacting storage',async()=>{
  const f=fixture(Array.from({length:21},()=>row()));const page=await f.catalog.list({tenantId:'tenant',projectId:'project'});
  const cursor=JSON.parse(Buffer.from(page.nextCursor!,'base64url').toString());f.query.mockClear();
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  for(const value of ['bad','!',page.nextCursor!+'=',encode({}),encode({...cursor,version:2}),encode({...cursor,extra:true}),encode({...cursor,at:'2026-02-30T12:00:00.123456Z'}),encode({...cursor,at:'2026-11-17T12:00:00.123Z'}),encode({...cursor,runId:'bad\n'})]){
    await expect(f.catalog.list({tenantId:'tenant',projectId:'project',cursor:value})).rejects.toMatchObject({code:'INVALID_INPUT'});
  }
  expect(f.query).not.toHaveBeenCalled();
});
it('captures query and summary identities without executing accessors or allowing unsupported filters',async()=>{
  const f=fixture();let invoked=false;
  for(const input of [{tenantId:'bad\n',projectId:'project'},{tenantId:'tenant',projectId:'project',pendingOnly:true},{tenantId:'tenant',projectId:'project',briefId:''},{tenantId:'tenant',projectId:'project',cursor:'x'.repeat(513)}])await expect(f.catalog.list(input as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.catalog.summary(Object.defineProperty({...key},'runId',{enumerable:true,get(){invoked=true;throw new Error('private');}}))).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.catalog.list(Object.defineProperty({tenantId:'tenant',projectId:'project'},'cursor',{enumerable:true,get(){invoked=true;return 'private';}}))).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(invoked).toBe(false);expect(f.query).not.toHaveBeenCalled();
});
it.each([{tenant_id:'other'},{project_id:'other'},{run_id:'different'},{run_digest:'bad'},{brief_revision:'9007199254740992'},{brief_revision:0},
  {created_at:'bad'},{created_at:'2026-02-30T12:00:00.123456Z'},{candidate_digest:'bad'},{review_status:'confirmed'},{review_status:'reviewed'}])('rejects invalid scoped summary metadata %j',async change=>{
  await expect(fixture([{...row(),...change}]).catalog.summary(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('accepts reviewed or rejected historical metadata without converting it into approval',async()=>{
  for(const status of ['reviewed','rejected']){
    const f=fixture([{...row(),candidate_digest:digest,review_status:status,brief_revision:2}]);
    expect(await f.catalog.summary(key)).toMatchObject({runId:'run',runDigest:digest,briefRevision:2,candidateDigest:digest,reviewStatus:status});
    expect(f.query.mock.calls[0]![1]).toEqual(['tenant','project','run']);
  }
});
it('refuses a returned row that violates the requested brief filter',async()=>{
  await expect(fixture([{...row(),brief_id:'other'}]).catalog.list({tenantId:'tenant',projectId:'project',briefId:'brief'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it.each([null,undefined])('does not classify a present invalid metadata row %j as missing',async value=>{
  await expect(fixture([value]).catalog.summary(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('does not invoke accessors on malformed database metadata',async()=>{
  let invoked=false;const record=Object.defineProperty(row(),'run_digest',{enumerable:true,get(){invoked=true;return digest;}});
  await expect(fixture([record]).catalog.summary(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(invoked).toBe(false);
});
it('distinguishes absence and redacts synchronous, rejected, duplicate and overfull storage results',async()=>{
  await expect(fixture([]).catalog.summary(key)).rejects.toMatchObject({code:'NOT_FOUND'});await expect(fixture([row(),row()]).catalog.summary(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  await expect(fixture(Array.from({length:22},()=>row())).catalog.list({tenantId:'tenant',projectId:'project'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  for(const query of [()=>{throw new Error('postgres://private');},()=>Promise.reject(new Error('postgres://private'))]){
    const catalog=new PostgresOutlineCatalog({query} as unknown as Pool);
    for(const call of [()=>catalog.list({tenantId:'tenant',projectId:'project'}),()=>catalog.summary(key)])await expect(call()).rejects.toMatchObject({code:'STORAGE_FAILED',message:expect.not.stringContaining('postgres://private')});
  }
});
