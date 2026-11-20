import {EventEmitter} from 'node:events';
import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolConfig} from 'pg';
const mocks=vi.hoisted(()=>({pools:[] as (EventEmitter&{config:PoolConfig;end:ReturnType<typeof vi.fn>})[],reader:vi.fn(),adopter:vi.fn(),constructFailure:0}));
vi.mock('pg',async original=>({...await original<typeof import('pg')>(),Pool:vi.fn(function(config:PoolConfig){if(mocks.constructFailure===mocks.pools.length+1)throw new Error('private connection string');const pool=Object.assign(new EventEmitter(),{config,end:vi.fn(async()=>{})});mocks.pools.push(pool);return pool;})}));
vi.mock('../src/projects/screenplay-adoption-role.js',()=>({verifyScreenplayProjectIdentityReaderRole:mocks.reader,verifyScreenplayProjectAdoptionRole:mocks.adopter}));
import {createScreenplayAdoptionRuntime} from '../src/projects/screenplay-adoption-runtime.js';
const config={tenantId:'tenant',readerDatabaseUrl:'postgresql://reader:private@localhost/camery',adoptionDatabaseUrl:'postgresql://screenplay_adopter:private@localhost/camery'};
beforeEach(()=>{mocks.pools.length=0;mocks.constructFailure=0;mocks.reader.mockReset().mockResolvedValue(undefined);mocks.adopter.mockReset().mockResolvedValue(undefined);});
it('composes existing stores on independent verified LOGIN pools without provisioning or model execution',async()=>{
  const host=await createScreenplayAdoptionRuntime(config);expect(mocks.pools.map(pool=>pool.config)).toEqual([expect.objectContaining({connectionString:config.readerDatabaseUrl,max:4,query_timeout:15000,statement_timeout:15000}),expect.objectContaining({connectionString:config.adoptionDatabaseUrl,max:4,query_timeout:15000,statement_timeout:15000})]);
  expect(mocks.reader).toHaveBeenCalledWith(mocks.pools[0]);expect(mocks.adopter).toHaveBeenCalledWith(mocks.pools[1]);expect(host.adoptionOptions.tenantId).toBe('tenant');
  expect(host.adoptionOptions.identities).toMatchObject({pool:mocks.pools[0]});
  for(const store of [host.adoptionOptions.versions,host.adoptionOptions.intents,host.adoptionOptions.scripts])expect(store).toMatchObject({pool:mocks.pools[1]});
  expect(host.adoptionOptions.newId()).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);expect(Object.isFrozen(host.adoptionOptions)).toBe(true);
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});try{for(const pool of mocks.pools)pool.emit('error',new Error('private credential'));expect(log.mock.calls.flat().join(' ')).not.toContain('private');}finally{log.mockRestore();}
  await Promise.all([host.close(),host.close()]);expect(mocks.pools.map(pool=>pool.end.mock.calls.length)).toEqual([1,1]);
});
it.each(['reader','adopter'] as const)('closes all owned resources when %s verification refuses privileges',async role=>{
  mocks[role].mockRejectedValue(new Error('private credentials'));await expect(createScreenplayAdoptionRuntime(config)).rejects.toThrow('Screenplay adoption runtime startup failed');expect(mocks.pools.map(pool=>pool.end.mock.calls.length)).toEqual([1,1]);
});
it('closes the first pool when the second construction fails',async()=>{mocks.constructFailure=2;await expect(createScreenplayAdoptionRuntime(config)).rejects.toThrow('Screenplay adoption runtime startup failed');expect(mocks.pools[0]!.end).toHaveBeenCalledOnce();});
it('closes every pool once even when shutdown itself fails',async()=>{const host=await createScreenplayAdoptionRuntime(config);mocks.pools[0]!.end.mockRejectedValue(new Error('private credentials'));await expect(host.close()).rejects.toThrow('Screenplay adoption runtime shutdown failed');await expect(host.close()).rejects.toThrow('Screenplay adoption runtime shutdown failed');expect(mocks.pools.map(pool=>pool.end.mock.calls.length)).toEqual([1,1]);});
it('captures configuration before verification can yield and refuses accessors without evaluating them',async()=>{
  const changed={...config},pending=createScreenplayAdoptionRuntime(changed);changed.tenantId='changed';changed.adoptionDatabaseUrl='private';const host=await pending;expect(host.adoptionOptions.tenantId).toBe('tenant');expect(mocks.pools[1]!.config.connectionString).toBe(config.adoptionDatabaseUrl);await host.close();
  mocks.pools.length=0;const getter=vi.fn(()=>config.tenantId);await expect(createScreenplayAdoptionRuntime(Object.defineProperty({...config},'tenantId',{get:getter}))).rejects.toThrow('Screenplay adoption runtime startup failed');expect(getter).not.toHaveBeenCalled();expect(mocks.pools).toHaveLength(0);
});
it.each(['postgresql://reader:private@localhost/camery','postgresql://screenplay_adopter:private@elsewhere/camery','postgresql://screenplay_adopter:private@localhost/camery?host=elsewhere','postgresql://screenplay_adopter:private@localhost/camery?user=reader'])('validates runtime endpoint authority again before constructing resources: %s',async adoptionDatabaseUrl=>{
  await expect(createScreenplayAdoptionRuntime({...config,adoptionDatabaseUrl})).rejects.toThrow('Screenplay adoption runtime startup failed');expect(mocks.pools).toHaveLength(0);
});
