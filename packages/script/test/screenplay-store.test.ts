import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {PostgresScreenplayStore} from '../src/screenplay/node/store.js';
import {screenplayFixture} from './screenplay-support.js';
function fixture(){const f=screenplayFixture(),client=Object.assign(new EventEmitter(),{query:vi.fn(async(_sql:string,_values?:unknown[])=>({rows:[]})),release:vi.fn()}),pool={connect:vi.fn(async()=>client)} as unknown as Pool,outline={readForAdoption:vi.fn(),readHistoricalForAdoption:vi.fn()};const host={actor:{kind:'human' as const,id:'editor'},scope:{tenantId:'tenant',projectId:'project'},at:'2026-11-19T05:00:00.000Z',authorize:vi.fn(()=>true)},key={...host.scope,candidateId:'script'};return {...f,client,pool,host,key,store:new PostgresScreenplayStore(pool,outline)};}
it('refuses unauthorized reads before touching a database connection',async()=>{const f=fixture();f.host.authorize.mockReturnValue(false);await expect(f.store.read(f.key,f.host)).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.pool.connect).not.toHaveBeenCalled();});
it('returns a safe missing record and always releases its owned transaction',async()=>{const f=fixture();await expect(f.store.read(f.key,f.host)).rejects.toMatchObject({code:'NOT_FOUND'});expect(f.client.query.mock.calls.map(row=>row[0])).toEqual(expect.arrayContaining(['BEGIN ISOLATION LEVEL READ COMMITTED','SET LOCAL search_path = pg_catalog','ROLLBACK']));expect(f.client.release).toHaveBeenCalledWith(false);expect(f.client.listenerCount('error')).toBe(0);});
it('normalizes a connection failure without driver diagnostics',async()=>{const f=fixture();vi.mocked(f.pool.connect).mockRejectedValue(new Error('secret://password'));await expect(f.store.read(f.key,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED',message:expect.not.stringContaining('password')});});
it('destroys a checked-out connection after an asynchronous physical disconnect',async()=>{const f=fixture();f.client.query.mockImplementation(async()=>{f.client.emit('error',new Error('private'));return {rows:[]};});await expect(f.store.read(f.key,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.client.release).toHaveBeenCalledWith(true);});
it.each(['readForAdoption','readHistorical'] as const)('sanitizes unknown errors on same-client %s without touching caller lifecycle',async method=>{
  const f=fixture();for(const error of [new Error('secret://driver'),new Proxy({},{getPrototypeOf(){throw new Error('secret://prototype');}})]){
    f.client.query.mockRejectedValue(error);await expect(f.store[method](f.client as never,f.key,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED',message:expect.not.stringContaining('secret')});
  }
  expect(f.pool.connect).not.toHaveBeenCalled();expect(f.client.release).not.toHaveBeenCalled();expect(f.client.query.mock.calls.every(row=>!['BEGIN','COMMIT','ROLLBACK'].includes(row[0]))).toBe(true);
});
it.each(['rollback','release','listener','on','opaque'] as const)('safely handles %s failure and attempts physical connection cleanup',async mode=>{
  const f=fixture();if(mode==='rollback')f.client.query.mockImplementation(async(sql:string)=>{if(sql==='ROLLBACK')throw new Error('private rollback');return {rows:[]};});
  if(mode==='release')f.client.release.mockImplementation(()=>{throw new Error('private release');});
  if(mode==='listener')vi.spyOn(f.client,'removeListener').mockImplementation(()=>{throw new Error('private cleanup');});
  if(mode==='on')vi.spyOn(f.client,'on').mockImplementation(()=>{throw new Error('private listener');});
  if(mode==='opaque')f.client.query.mockRejectedValue(new Proxy({},{getPrototypeOf(){throw new Error('private prototype');}}));
  await expect(f.store.read(f.key,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED',message:expect.not.stringContaining('private')});expect(f.client.release).toHaveBeenCalledTimes(1);
  if(['rollback','listener','on'].includes(mode))expect(f.client.release).toHaveBeenCalledWith(true);
});
