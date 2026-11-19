import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import type {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {migrateContinuityNative} from '../src/continuity/node/native-migrate.js';

function installation(){
  const state={ready:true,ledger:[] as {version:number;checksum:string}[],fail:'',emitError:false};
  const query=vi.fn(async(text:string)=>{
    if(state.emitError&&text==='COMMIT')queueMicrotask(()=>{client.emit('error',new Error('private asynchronous driver error'));});
    if(state.fail&&text.startsWith(state.fail))throw new Error('private native database credential');
    if(text.includes('AS native_ready'))return {rows:[{native_ready:state.ready}]};
    if(text.startsWith('SELECT version,checksum'))return {rows:state.ledger};
    return {rows:[]};
  });
  const release=vi.fn(),client=Object.assign(new EventEmitter(),{query,release}),connect=vi.fn(async()=>client);return {state,query,release,connect,client,pool:{connect} as unknown as Pool};
}
it('requires existing native history and human reviews before explicitly installing new append-only proof tables',async()=>{
  const f=installation();await migrateContinuityNative(f.pool);
  const sql=readFileSync(new URL('../src/continuity/node/native-migrations/0001-native-proof.sql',import.meta.url),'utf8');
  const checksum=createHash('sha256').update(sql).digest('hex');expect(checksum).toBe('4a60386f036990b5753e7dedaca1581140d0cf0144e5ce4343c369216a1f500a');
  expect(sql).not.toContain('\r');expect(f.query.mock.calls.map(call=>call[0])).toContain(sql);
  f.state.ledger=[{version:1,checksum}];f.query.mockClear();
  await migrateContinuityNative(f.pool);expect(f.query.mock.calls.map(call=>call[0])).not.toContain(sql);expect(f.release).toHaveBeenCalledWith(false);
});
it('refuses absent prerequisites without creating proof tables',async()=>{
  const f=installation();f.state.ready=false;await expect(migrateContinuityNative(f.pool)).rejects.toMatchObject({code:'INCOMPLETE'});
  expect(f.query.mock.calls.some(call=>call[0].startsWith('CREATE'))).toBe(false);expect(f.query).toHaveBeenCalledWith('ROLLBACK');
});
it.each([{ledger:[{version:1,checksum:'f'.repeat(64)}]},{ledger:[{version:2,checksum:'f'.repeat(64)}]},{ledger:[{version:1,checksum:'f'.repeat(64)},{version:2,checksum:'f'.repeat(64)}]}])('refuses mismatched or unrecognized migration history',async({ledger})=>{
  const f=installation();f.state.ledger=ledger;await expect(migrateContinuityNative(f.pool)).rejects.toMatchObject({code:'CONFLICT'});
});
it.each(['BEGIN','SELECT pg_advisory','SELECT to_regclass','CREATE TABLE IF NOT EXISTS','SELECT version,checksum','CREATE TABLE camery_continuity.native_bindings','INSERT INTO camery_continuity.native_migrations','COMMIT'])('redacts %s failures and releases its installer connection',async prefix=>{
  const f=installation();f.state.fail=prefix;await expect(migrateContinuityNative(f.pool)).rejects.toThrow(/Continuity .*STORAGE_FAILED/);expect(f.release).toHaveBeenCalled();
});
it('normalizes connect/release and failed rollback without exposing driver errors',async()=>{
  const f=installation();f.connect.mockRejectedValue(new Error('private connection'));await expect(migrateContinuityNative(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const release=installation();release.release.mockImplementation(()=>{throw new Error('private release');});await expect(migrateContinuityNative(release.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const rollback=installation();rollback.query.mockRejectedValue(new Error('private rollback'));await expect(migrateContinuityNative(rollback.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(rollback.release).toHaveBeenCalledWith(true);
});
it('observes asynchronous checked-out client errors, fails closed and destroys the connection',async()=>{
  const f=installation();f.state.emitError=true;await expect(migrateContinuityNative(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  expect(f.release).toHaveBeenCalledWith(true);expect(f.client.listenerCount('error')).toBe(0);
});
