import {EventEmitter} from 'node:events';
import type {Pool,PoolClient} from 'pg';
import {expect,it,vi} from 'vitest';
import {ScreenplayError} from '@camery/script/screenplay';
import {ProjectApplicationError} from '../src/projects/intent-contracts.js';
import {projectCommandTransaction} from '../src/projects/project-command-transaction.js';

function fixture(){
  const state={queryFailure:'',disconnect:'',releaseFailure:false,offFailure:false,onFailure:false},events=new EventEmitter(),secret=new Error('private postgresql://password@host');
  const query=vi.fn(async(sql:string)=>{if(state.queryFailure===sql)throw secret;if(state.disconnect===sql)events.emit('error',secret);return {rows:[]};});
  const release=vi.fn((_destroy?:boolean)=>{if(state.releaseFailure)throw secret;});
  const client=Object.assign(events,{query,release}),on=client.on.bind(client),off=client.off.bind(client);
  client.on=((...args:Parameters<typeof on>)=>{if(state.onFailure)throw secret;return on(...args);}) as typeof on;
  client.off=((...args:Parameters<typeof off>)=>{if(state.offFailure)throw secret;return off(...args);}) as typeof off;
  const connect=vi.fn(async()=>client as unknown as PoolClient),pool={connect} as unknown as Pool;
  return {state,events,secret,query,release,connect,pool};
}
async function refused(action:Promise<unknown>,code='STORAGE_FAILED'){
  const error:unknown=await action.catch(value=>value as unknown);expect(error).toBeInstanceOf(ProjectApplicationError);expect(error).toMatchObject({code});expect(String(error)).not.toContain('private');return error;
}
it('pins one RC transaction and releases the client only after the actual command commits',async()=>{
  const f=fixture(),value={source:'original'};expect(await projectCommandTransaction(f.pool,'test source',async client=>{expect(client).toBe(f.events);return value;})).toBe(value);expect(f.query.mock.calls.map(([sql])=>sql)).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED','SET LOCAL search_path = pg_catalog','COMMIT']);expect(f.release).toHaveBeenCalledExactlyOnceWith(false);expect(f.events.listenerCount('error')).toBe(0);
});
it('redacts connection failures before acquiring a client or executing any protected command',async()=>{
  const f=fixture(),action=vi.fn();f.connect.mockRejectedValue(f.secret);await refused(projectCommandTransaction(f.pool,'source read',action));expect(action).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
});
it.each(['BEGIN ISOLATION LEVEL READ COMMITTED','SET LOCAL search_path = pg_catalog','COMMIT'])('rolls back and never reports success when %s fails',async sql=>{
  const f=fixture(),action=vi.fn(async()=>1);f.state.queryFailure=sql;await refused(projectCommandTransaction(f.pool,'source command',action));expect(f.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);expect(f.release).toHaveBeenCalledExactlyOnceWith(false);expect(f.events.listenerCount('error')).toBe(0);if(sql!=='COMMIT')expect(action).not.toHaveBeenCalled();
});
it.each(['BEGIN ISOLATION LEVEL READ COMMITTED','COMMIT'])('destroys a disconnected client at %s and keeps safe failure semantics',async sql=>{
  const f=fixture();f.state.disconnect=sql;await refused(projectCommandTransaction(f.pool,'source command',async()=>1));expect(f.release).toHaveBeenCalledExactlyOnceWith(true);expect(f.events.listenerCount('error')).toBe(0);
});
it('does not COMMIT after an asynchronous client error during the source command',async()=>{
  const f=fixture();await refused(projectCommandTransaction(f.pool,'source command',async()=>{f.events.emit('error',f.secret);return 'uncommitted';}));expect(f.query.mock.calls.map(([sql])=>sql)).not.toContain('COMMIT');expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
});
it.each(['23503','23505','unexpected'])('maps SQL %s without exposing driver metadata',async code=>{
  const f=fixture();await refused(projectCommandTransaction(f.pool,'append intent',async()=>{throw Object.assign(f.secret,{code});}),code==='unexpected'?'STORAGE_FAILED':'CONFLICT');expect(f.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
});
it('never invokes an exception code getter or trusts opaque proxy metadata',async()=>{
  const f=fixture(),getter=vi.fn(()=>{throw f.secret;}),accessor=Object.defineProperty({},'code',{get:getter}),proxy=new Proxy({}, {getPrototypeOf(){throw f.secret;},getOwnPropertyDescriptor(){throw f.secret;}});
  for(const error of [accessor,proxy,null,'private failure'])await refused(projectCommandTransaction(f.pool,'source read',async()=>{throw error;}));expect(getter).not.toHaveBeenCalled();
});
it('preserves typed source and host errors only after rollback succeeds',async()=>{
  const f=fixture();for(const error of [new ScreenplayError('CONFLICT','source changed','current source'),new ProjectApplicationError('CONFLICT','command key')])await expect(projectCommandTransaction(f.pool,'source command',async()=>{throw error;})).rejects.toBe(error);expect(f.query.mock.calls.filter(([sql])=>sql==='ROLLBACK')).toHaveLength(2);
});
it('destroys the connection and reports rollback context when rollback itself fails',async()=>{
  const f=fixture();f.state.queryFailure='ROLLBACK';const error=await refused(projectCommandTransaction(f.pool,'source read',async()=>{throw new ProjectApplicationError('CONFLICT','source');}));expect(String(error)).toContain('rollback');expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
});
it.each(['onFailure','offFailure','releaseFailure'] as const)('safely releases acquired clients when %s prevents lifecycle cleanup',async fault=>{
  const f=fixture();f.state[fault]=true;await refused(projectCommandTransaction(f.pool,'source read',async()=>1));expect(f.release).toHaveBeenCalledOnce();if(fault!=='releaseFailure')expect(f.release).toHaveBeenCalledWith(true);
});
