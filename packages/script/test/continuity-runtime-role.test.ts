import {describe,expect,it} from 'vitest';
import {grantContinuityRuntimeRole,verifyContinuityRuntimeRole} from '../src/continuity/node/runtime-role.js';
import {continuityInstallDatabase} from './continuity-install-support.js';
describe('dedicated continuity LOGIN',()=>{
  it.each(['','UPPER','x; DROP ROLE x','x\n','a'.repeat(64),null])('rejects invalid installer identifiers %# before connecting',async role=>{const f=continuityInstallDatabase();await expect(grantContinuityRuntimeRole(f.pool,role as string)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(f.connect).not.toHaveBeenCalled();});
  it('grants only append records, source reads and the one row-lock column',async()=>{
    const f=continuityInstallDatabase();await grantContinuityRuntimeRole(f.pool,'continuity_fixture');const grants=f.query.mock.calls.map(call=>call[0]).filter(text=>text.startsWith('GRANT'));
    expect(grants).toEqual([
      'GRANT USAGE ON SCHEMA camery_continuity,camery_versioning TO "continuity_fixture"',
      'GRANT SELECT,INSERT ON camery_continuity.candidates,camery_continuity.reviews TO "continuity_fixture"',
      'GRANT SELECT ON camery_versioning.projects,camery_versioning.snapshots,camery_versioning.changes,camery_versioning.object_revisions,camery_versioning.adoptions TO "continuity_fixture"',
      'GRANT UPDATE(write_version) ON camery_versioning.projects TO "continuity_fixture"',
    ]);expect(f.query.mock.calls.map(call=>call[0])).not.toContain('CREATE ROLE');expect(f.release).toHaveBeenCalledWith(false);
  });
  it.each(['BEGIN','GRANT USAGE','GRANT SELECT,INSERT','GRANT SELECT ON','GRANT UPDATE(write_version)','COMMIT'])('redacts %s failure',async prefix=>{const f=continuityInstallDatabase();f.state.fail=[prefix];await expect(grantContinuityRuntimeRole(f.pool,'continuity_fixture')).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.release).toHaveBeenCalled();});
  it('destroys broken rollback clients and normalizes rejected/synchronous connections or release',async()=>{
    const f=continuityInstallDatabase();f.state.fail=['COMMIT','ROLLBACK'];await expect(grantContinuityRuntimeRole(f.pool,'continuity_fixture')).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.release).toHaveBeenCalledWith(true);
    const badRelease=continuityInstallDatabase();badRelease.release.mockImplementation(()=>{throw new Error('private release');});await expect(grantContinuityRuntimeRole(badRelease.pool,'continuity_fixture')).rejects.toMatchObject({code:'STORAGE_FAILED'});
    const badConnect=continuityInstallDatabase();badConnect.connect.mockRejectedValue(new Error('private connection'));await expect(grantContinuityRuntimeRole(badConnect.pool,'continuity_fixture')).rejects.toMatchObject({code:'STORAGE_FAILED'});
    const sync=continuityInstallDatabase();sync.connect.mockImplementation(()=>{throw new Error('private sync connection');});await expect(grantContinuityRuntimeRole(sync.pool,'continuity_fixture')).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
  it('requires exactly one literal true verification result',async()=>{const f=continuityInstallDatabase();await verifyContinuityRuntimeRole(f.pool);f.state.allowed=false;await expect(verifyContinuityRuntimeRole(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});f.state.allowed=true;for(const count of [0,2]){f.state.resultRows=count;await expect(verifyContinuityRuntimeRole(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});}});
  it('normalizes opaque or direct query failures without reflecting dependencies',async()=>{const f=continuityInstallDatabase();f.query.mockRejectedValue(new Proxy({},{getPrototypeOf(){throw new Error('private prototype');}}));await expect(verifyContinuityRuntimeRole(f.pool)).rejects.toThrow('Continuity restricted runtime role failed (STORAGE_FAILED) at role');f.query.mockImplementation(()=>{throw new Error('private sync query');});await expect(verifyContinuityRuntimeRole(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});});
});
