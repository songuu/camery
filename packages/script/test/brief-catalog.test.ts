import {expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {PostgresDevelopmentBriefCatalog} from '../src/node/brief-catalog.js';
function fixture(){const rows=Array.from({length:21},(_,i)=>({tenant_id:'tenant',project_id:'project',brief_id:'brief-'+String(i).padStart(2,'0'),revision:'2',idea_preview:'修钟学徒的来信。',actor_id:'human',created_at:'2026-11-17T00:00:00.000Z'}));const query=vi.fn(async(_sql:string,_values?:unknown[])=>({rows}));return {rows,query,catalog:new PostgresDevelopmentBriefCatalog({query} as unknown as Pool)};}
it('lists latest brief metadata in bounded stable ID pages and binds its cursor to tenant/project',async()=>{
  const f=fixture();const page=await f.catalog.list({tenantId:'tenant',projectId:'project'});expect(page.items).toHaveLength(20);expect(page.items[0]!.revision).toBe(2);expect(page.nextCursor).toBeTruthy();
  expect(f.query.mock.calls[0]![0]).toContain('DISTINCT ON');expect(f.query.mock.calls[0]![0]).not.toContain('SELECT record');f.rows.splice(0,20);
  expect((await f.catalog.list({tenantId:'tenant',projectId:'project',cursor:page.nextCursor!})).items).toHaveLength(1);
  await expect(f.catalog.list({tenantId:'tenant',projectId:'other',cursor:page.nextCursor!})).rejects.toMatchObject({code:'INVALID_INPUT'});
  for(const cursor of ['bad=','e30','x'.repeat(513)])await expect(f.catalog.list({tenantId:'tenant',projectId:'project',cursor})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
it('redacts invalid metadata and SQL failures instead of returning unrelated or unbounded records',async()=>{
  const f=fixture();f.rows[0]!.tenant_id='other';await expect(f.catalog.list({tenantId:'tenant',projectId:'project'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  f.query.mockRejectedValue(new Error('private credentials'));await expect(f.catalog.list({tenantId:'tenant',projectId:'project'})).rejects.toThrow('brief catalog');
});
it('does not reject a valid idea whose bounded preview contains only leading whitespace',async()=>{
  const f=fixture();f.rows[0]!.idea_preview=' '.repeat(120);expect((await f.catalog.list({tenantId:'tenant',projectId:'project'})).items[0]!.ideaPreview).toBe(' '.repeat(120));
});
