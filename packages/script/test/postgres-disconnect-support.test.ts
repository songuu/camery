import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import {testDatabaseConnections} from './postgres-disconnect-support.js';

vi.mock('pg',async()=>{
  const {EventEmitter}=await import('node:events');
  // Model pg-pool's early end acknowledgement independently of socket close events.
  return {Pool:class extends EventEmitter{end(){return Promise.resolve();}}};
});

it('finishes when no target database connection was opened',async()=>{
  await expect(testDatabaseConnections().waitForDisconnects()).resolves.toBeUndefined();
});

it('remembers connections that closed before cleanup began',async()=>{
  const connections=testDatabaseConnections(),pool=connections.createPool({}),client=new EventEmitter();
  pool.emit('connect',client);client.emit('end');await pool.end();
  await expect(connections.waitForDisconnects()).resolves.toBeUndefined();
});

it('waits for the last physical connection across target pools after their end acknowledgements',async()=>{
  const connections=testDatabaseConnections(),firstPool=connections.createPool({}),secondPool=connections.createPool({});
  const first=new EventEmitter(),second=new EventEmitter();firstPool.emit('connect',first);secondPool.emit('connect',second);
  await firstPool.end();await secondPool.end();let finished=false;
  const cleanup=connections.waitForDisconnects().then(()=>{finished=true;});
  await new Promise<void>(resolve=>setImmediate(resolve));expect(finished).toBe(false);
  first.emit('end');await new Promise<void>(resolve=>setImmediate(resolve));expect(finished).toBe(false);
  second.emit('end');await cleanup;expect(finished).toBe(true);
});
