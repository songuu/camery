import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { describe,expect,it,vi } from 'vitest';
import { migrateOutline } from '../src/outline/node/migrate.js';
import { grantOutlineRuntimeRole,verifyOutlineRuntimeRole } from '../src/outline/node/runtime-role.js';

const sql=readFileSync(new URL('../src/outline/node/migrations/0001-outline.sql',import.meta.url),'utf8');const checksum=createHash('sha256').update(sql,'utf8').digest('hex');
function database(){
  const state={rows:[] as {version:number;checksum:string}[],fail:[] as string[],allowed:true,resultRows:1};
  const query=vi.fn(async(text:string)=>{if(state.fail.some(prefix=>text.startsWith(prefix)))throw new Error('private query');return {rows:text.startsWith('SELECT version')?state.rows:text.includes('WITH permitted')?Array.from({length:state.resultRows},()=>({allowed:state.allowed})):[]};});
  const release=vi.fn();const connect=vi.fn(async()=>({query,release}));const pool={connect,query} as unknown as Pool;return {pool,state,query,release,connect};
}
describe('explicit outline installation',()=>{
  it('pins identical LF migration bytes for Windows and Linux',()=>{
    const workspace=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
    // Coverage workers may use a sandbox account; trust only this read command's exact workspace, never global Git configuration.
    const attributes=execFileSync('git',['-c',`safe.directory=${workspace.replaceAll('\\','/')}`,'check-attr','eol','--','packages/script/src/outline/node/migrations/0001-outline.sql'],{cwd:workspace,encoding:'utf8'});
    expect(attributes.trim()).toMatch(/: eol: lf$/);expect(sql).not.toContain('\r');
  });
  it('installs once, checks the stored checksum, and never rewrites an applied migration',async()=>{
    const f=database();await migrateOutline(f.pool);expect(f.query.mock.calls.map(call=>call[0])).toContain(sql);expect(f.release).toHaveBeenCalledWith(false);
    f.state.rows=[{version:1,checksum}];f.query.mockClear();await migrateOutline(f.pool);expect(f.query.mock.calls.map(call=>call[0])).not.toContain(sql);
  });
  it.each([[{version:0,checksum}],[{version:2,checksum}],[{version:1,checksum:'a'.repeat(64)}],[{version:1,checksum},{version:1,checksum}]].map(rows=>({rows})))('refuses altered or unknown ledger rows %#',async({rows})=>{
    const f=database();f.state.rows=rows;await expect(migrateOutline(f.pool)).rejects.toMatchObject({code:'CONFLICT'});expect(f.query).toHaveBeenCalledWith('ROLLBACK');
  });
  it.each(['BEGIN','SELECT pg_advisory','CREATE SCHEMA','CREATE TABLE','SELECT version','CREATE TABLE camery_outline.briefs','INSERT INTO','COMMIT'])('redacts migration %s failure',async prefix=>{
    const f=database();f.state.fail=[prefix];await expect(migrateOutline(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.release).toHaveBeenCalled();
  });
  it('destroys a failed rollback client and redacts synchronous/rejected connections or release',async()=>{
    const f=database();f.state.fail=['COMMIT','ROLLBACK'];await expect(migrateOutline(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.release).toHaveBeenCalledWith(true);
    const g=database();g.release.mockImplementation(()=>{throw new Error('private release');});await expect(migrateOutline(g.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    const h=database();h.connect.mockRejectedValue(new Error('private connection'));await expect(migrateOutline(h.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    const sync=database();sync.connect.mockImplementation(()=>{throw new Error('private synchronous connection');});await expect(migrateOutline(sync.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
});
describe('dedicated append-only outline identity',()=>{
  it.each(['','UPPER','x; DROP ROLE x','x\n','a'.repeat(64),null])('rejects invalid role %# before acquiring a connection',async role=>{
    const f=database();await expect(grantOutlineRuntimeRole(f.pool,role as string)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(f.connect).not.toHaveBeenCalled();
  });
  it('grants only fixed outline writes and source reads, then validates the actual role result',async()=>{
    const f=database();await grantOutlineRuntimeRole(f.pool,'outline_fixture');expect(f.query.mock.calls.filter(call=>call[0].startsWith('GRANT')).map(call=>call[0])).toHaveLength(3);
    await verifyOutlineRuntimeRole(f.pool);f.state.allowed=false;await expect(verifyOutlineRuntimeRole(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    f.state.allowed=true;f.state.resultRows=0;await expect(verifyOutlineRuntimeRole(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});f.state.resultRows=2;await expect(verifyOutlineRuntimeRole(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    f.query.mockImplementation(()=>{throw new Error('private query');});await expect(verifyOutlineRuntimeRole(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
  it.each(['BEGIN','GRANT USAGE','GRANT SELECT,INSERT','GRANT SELECT ON','COMMIT'])('redacts grant %s errors',async prefix=>{
    const f=database();f.state.fail=[prefix];await expect(grantOutlineRuntimeRole(f.pool,'outline_fixture')).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
  it('destroys a broken installer transaction and redacts all connection/release failures',async()=>{
    const f=database();f.state.fail=['COMMIT','ROLLBACK'];await expect(grantOutlineRuntimeRole(f.pool,'outline_fixture')).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.release).toHaveBeenCalledWith(true);
    const g=database();g.release.mockImplementation(()=>{throw new Error('private release');});await expect(grantOutlineRuntimeRole(g.pool,'outline_fixture')).rejects.toMatchObject({code:'STORAGE_FAILED'});
    const h=database();h.connect.mockRejectedValue(new Error('private connection'));await expect(grantOutlineRuntimeRole(h.pool,'outline_fixture')).rejects.toMatchObject({code:'STORAGE_FAILED'});
    const sync=database();sync.connect.mockImplementation(()=>{throw new Error('private synchronous connection');});await expect(grantOutlineRuntimeRole(sync.pool,'outline_fixture')).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
});
