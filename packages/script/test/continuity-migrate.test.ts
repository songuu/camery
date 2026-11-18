import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {migrateContinuity} from '../src/continuity/node/migrate.js';
import {continuityInstallDatabase} from './continuity-install-support.js';
const sql=readFileSync(new URL('../src/continuity/node/migrations/0001-continuity.sql',import.meta.url),'utf8'),checksum=createHash('sha256').update(sql,'utf8').digest('hex');
describe('explicit continuity migration',()=>{
  it('keeps migration bytes LF across checkouts',()=>{
    const workspace=resolve(fileURLToPath(new URL('../../../',import.meta.url))),attributes=execFileSync('git',['-c',`safe.directory=${workspace.replaceAll('\\','/')}`,'check-attr','eol','--','packages/script/src/continuity/node/migrations/0001-continuity.sql'],{cwd:workspace,encoding:'utf8'});
    expect(attributes.trim()).toMatch(/: eol: lf$/);expect(sql).not.toContain('\r');expect(checksum).toBe('b9ddff6a212c36ec699fddb7f6306f4da337fff4fb88e8b21d0736c1bfe23e35');
  });
  it('indexes the complete native source foreign key in its declared column order',()=>{
    const indexes=[...sql.matchAll(/^CREATE INDEX ([a-z_]+) ON ([a-z_]+)\.([a-z_]+)\(([^)]+)\);$/gm)].map(match=>({name:match[1],schema:match[2],table:match[3],keys:match[4]!.split(',').map(key=>key.trim())}));
    expect(indexes.filter(index=>index.name==='continuity_candidates_source_idx')).toEqual([{name:'continuity_candidates_source_idx',schema:'camery_continuity',table:'candidates',keys:['formal_tenant_id','formal_project_id','source_revision']}]);
    const foreignKey=/FOREIGN KEY \((formal_tenant_id,formal_project_id,source_revision)\) REFERENCES camery_versioning\.snapshots\(tenant_id,project_id,revision\)/.exec(sql);
    expect(foreignKey?.[1]?.split(',')).toEqual(indexes.find(index=>index.name==='continuity_candidates_source_idx')?.keys);
  });
  it('checks native prerequisites before creating its schema and installs exactly once',async()=>{
    const f=continuityInstallDatabase();await migrateContinuity(f.pool);const statements=f.query.mock.calls.map(call=>call[0]);expect(statements.findIndex(text=>text.includes('AS snapshots_ready'))).toBeLessThan(statements.indexOf('CREATE SCHEMA IF NOT EXISTS camery_continuity'));expect(statements).toContain(sql);expect(f.release).toHaveBeenCalledWith(false);
    f.state.ledger=[{version:1,checksum}];f.query.mockClear();await migrateContinuity(f.pool);expect(f.query.mock.calls.map(call=>call[0])).not.toContain(sql);expect(f.query.mock.calls.some(call=>call[0].startsWith('UPDATE'))).toBe(false);
  });
  it('refuses absent versioning without provisioning it',async()=>{
    const f=continuityInstallDatabase();f.state.prerequisites=false;await expect(migrateContinuity(f.pool)).rejects.toMatchObject({code:'INCOMPLETE'});expect(f.query.mock.calls.some(call=>call[0].startsWith('CREATE SCHEMA'))).toBe(false);expect(f.query).toHaveBeenCalledWith('ROLLBACK');
  });
  it.each([[{version:0,checksum}],[{version:2,checksum}],[{version:1,checksum:'0'.repeat(64)}],[{version:1,checksum},{version:1,checksum}]].map(ledger=>({ledger})))('refuses an altered migration ledger %#',async({ledger})=>{const f=continuityInstallDatabase();f.state.ledger=ledger;await expect(migrateContinuity(f.pool)).rejects.toMatchObject({code:'CONFLICT'});expect(f.query).toHaveBeenCalledWith('ROLLBACK');});
  it.each(['BEGIN','SELECT pg_advisory','SELECT to_regclass','CREATE SCHEMA','CREATE TABLE IF NOT EXISTS','SELECT version,checksum','CREATE TABLE camery_continuity.candidates','INSERT INTO camery_continuity.migrations','COMMIT'])('redacts %s failures and releases the connection',async prefix=>{const f=continuityInstallDatabase();f.state.fail=[prefix];await expect(migrateContinuity(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.release).toHaveBeenCalled();});
  it('destroys a client when rollback fails and normalizes connection/release exceptions',async()=>{
    const f=continuityInstallDatabase();f.state.fail=['COMMIT','ROLLBACK'];await expect(migrateContinuity(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.release).toHaveBeenCalledWith(true);
    const badRelease=continuityInstallDatabase();badRelease.release.mockImplementation(()=>{throw new Error('private release');});await expect(migrateContinuity(badRelease.pool)).rejects.toThrow('Continuity migration release failed (STORAGE_FAILED) at migration');
    const badConnect=continuityInstallDatabase();badConnect.connect.mockRejectedValue(new Error('private connection'));await expect(migrateContinuity(badConnect.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(badConnect.release).not.toHaveBeenCalled();
    const sync=continuityInstallDatabase();sync.connect.mockImplementation(()=>{throw new Error('private sync connection');});await expect(migrateContinuity(sync.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
  it('does not interrogate opaque dependency exceptions',async()=>{const f=continuityInstallDatabase(),opaque=new Proxy({},{getPrototypeOf(){throw new Error('private prototype');}});f.query.mockRejectedValue(opaque);await expect(migrateContinuity(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.release).toHaveBeenCalledWith(true);});
});
