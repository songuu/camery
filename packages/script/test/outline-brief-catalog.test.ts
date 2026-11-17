import { expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresOutlineBriefCatalog } from '../src/outline/node/brief-catalog.js';

const key={tenantId:'tenant',projectId:'project'};
const row=()=>({tenant_id:'tenant',project_id:'project',brief_id:'brief',revision:'2',notes_preview:'保留修钟学徒的反击。',actor_id:'human',created_at:'2026-11-17T12:00:00.123Z'});
function fixture(rows:unknown[]=[row()]){const query=vi.fn(async(_sql:string,_values:unknown[])=>({rows}));return {rows,query,catalog:new PostgresOutlineBriefCatalog({query} as unknown as Pool)};}

it('lists latest saved brief metadata even when there is no run, without selecting complete records',async()=>{
  const f=fixture();const page=await f.catalog.list(key);expect(page).toEqual({items:[{briefId:'brief',revision:2,notesPreview:'保留修钟学徒的反击。',actorId:'human',createdAt:row().created_at}],nextCursor:null});
  const [sql,values]=f.query.mock.calls[0]!;expect(values).toEqual(['tenant','project',null]);expect(sql).toContain('SELECT DISTINCT ON (brief_id COLLATE "C")');expect(sql).toContain("left(record->>'notes',120) AS notes_preview");
  expect(sql).toContain('tenant_id=$1 AND project_id=$2');expect(sql).toContain('ORDER BY brief_id COLLATE "C",revision DESC LIMIT 21');expect(sql).not.toMatch(/camery_outline\.runs|SELECT\s+(?:\*|record\b)/);
  expect(Object.isFrozen(page.items)).toBe(true);expect(Object.isFrozen(page.items[0])).toBe(true);
});
it('keeps pagination stable across revisions and binds cursor to the catalog kind and scope',async()=>{
  const rows=Array.from({length:21},(_,index)=>({...row(),brief_id:'brief-'+String(index).padStart(2,'0')}));const f=fixture(rows);
  const first=await f.catalog.list(key);expect(first.items).toHaveLength(20);expect(first.nextCursor).toBeTruthy();
  const cursor=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString());expect(cursor.briefId).toBe('brief-19');expect(cursor).not.toHaveProperty('at');
  rows.splice(0,20);const next=await f.catalog.list({...key,cursor:first.nextCursor!});expect(next.items).toHaveLength(1);expect(next.nextCursor).toBeNull();
  expect(f.query.mock.calls[1]![1]).toEqual(['tenant','project','brief-19']);expect(f.query.mock.calls[1]![0]).toContain('brief_id COLLATE "C">$3::text COLLATE "C"');
  for(const changed of [{tenantId:'other'},{projectId:'other'}])await expect(f.catalog.list({...key,...changed,cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
it('does not decode the extra sentinel or require any results',async()=>{
  const rows:unknown[]=Array.from({length:20},()=>row());rows.push({invalid:'sentinel'});const f=fixture(rows);expect((await f.catalog.list(key)).items).toHaveLength(20);
  rows.splice(0);expect(await f.catalog.list(key)).toEqual({items:[],nextCursor:null});
});
it('accepts whitespace-only or maximum UTF16 previews without treating them as complete notes',async()=>{
  for(const preview of [' '.repeat(120),'😀'.repeat(120)])expect((await fixture([{...row(),notes_preview:preview}]).catalog.list(key)).items[0]!.notesPreview).toBe(preview);
});
it('rejects malformed identities, cursors and accessors before storage',async()=>{
  const f=fixture();let invoked=false;
  for(const cursor of ['bad=','e30','!','x'.repeat(513),Buffer.from(JSON.stringify({version:1,scope:'a'.repeat(64),briefId:'brief'})).toString('base64url')])await expect(f.catalog.list({...key,cursor})).rejects.toMatchObject({code:'INVALID_INPUT'});
  for(const input of [{...key,extra:true},{...key,tenantId:'bad\n'},{...key,briefId:'unexpected'}])await expect(f.catalog.list(input as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.catalog.list(Object.defineProperty({...key},'cursor',{enumerable:true,get(){invoked=true;throw new Error('private');}}))).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(invoked).toBe(false);expect(f.query).not.toHaveBeenCalled();
});
it.each([{tenant_id:'other'},{project_id:'other'},{brief_id:'bad\n'},{revision:'9007199254740992'},{revision:0},{notes_preview:''},{notes_preview:'bad\0'},
  {notes_preview:'x'.repeat(241)},{actor_id:'bad\n'},{created_at:'2026-02-30T12:00:00.123Z'}])('rejects corrupt scoped brief metadata %j',async change=>{
  await expect(fixture([{...row(),...change}]).catalog.list(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('rejects database accessors, overfull rows and synchronous or rejected storage errors without leaking them',async()=>{
  let invoked=false;const bad=Object.defineProperty(row(),'notes_preview',{enumerable:true,get(){invoked=true;return 'private';}});
  await expect(fixture([bad]).catalog.list(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(invoked).toBe(false);
  await expect(fixture(Array.from({length:22},()=>row())).catalog.list(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  for(const query of [()=>{throw new Error('postgres://private');},()=>Promise.reject(new Error('postgres://private'))])await expect(new PostgresOutlineBriefCatalog({query} as unknown as Pool).list(key)).rejects.toMatchObject({code:'STORAGE_FAILED',message:expect.not.stringContaining('postgres://private')});
});
