import {expect,it,vi} from 'vitest';
import {captureScreenplayHost,authorizeScreenplayHost} from '../src/screenplay/node/host.js';
import type {ScreenplayHost} from '../src/screenplay/node/contracts.js';

const scope={tenantId:'screenplay-tenant',projectId:'screenplay-project'};
const host=(authorize:ScreenplayHost['authorize']=()=>true):ScreenplayHost=>({actor:{kind:'human',id:'actual-human'},scope:{...scope},at:'2026-11-19T06:00:00.000Z',authorize});
const forbidden='Screenplay trusted human authority failed (FORBIDDEN) at host';

it('captures a detached strict human identity, exact timestamp and the original grant function',()=>{
  const input=host(),captured=captureScreenplayHost(input);Object.assign(input.actor,{id:'changed-human'});Object.assign(input.scope,{projectId:'changed-project'});
  expect(captured.actor).toEqual({kind:'human',id:'actual-human'});expect(captured.scope).toEqual(scope);expect(captured.at).toBe('2026-11-19T06:00:00.000Z');expect(captured.authorize).toBe(input.authorize);
  expect(Object.isFrozen(captured)).toBe(true);expect(Object.isFrozen(captured.actor)).toBe(true);expect(Object.isFrozen(captured.scope)).toBe(true);expect(Object.isFrozen(input.scope)).toBe(false);
});

it('accepts a strict null-prototype host and a real leap-day timestamp',()=>{
  const input=Object.assign(Object.create(null) as Record<string,unknown>,host(),{at:'2024-02-29T00:00:00.000Z'}),captured=captureScreenplayHost(input);expect(captured.at).toBe('2024-02-29T00:00:00.000Z');expect(authorizeScreenplayHost(captured,'screenplay:read',scope).actor.id).toBe('actual-human');
});

it.each([null,undefined,false,1,'host',[],new Date(),{...host(),extra:'private'},{...host(),authorize:true},Object.create(host()) as unknown])('rejects malformed or inherited host %#',input=>{expect(()=>captureScreenplayHost(input)).toThrow(forbidden);});

it.each(['actor','scope','at','authorize'] as const)('never executes a host %s getter or accepts a missing own data field',field=>{
  const getter=host();let touched=false;Object.defineProperty(getter,field,{enumerable:true,get(){touched=true;throw new Error('private host accessor');}});expect(()=>captureScreenplayHost(getter)).toThrow(forbidden);expect(touched).toBe(false);
  const hidden=Object.defineProperty(host(),field,{enumerable:false,value:host()[field]});expect(()=>captureScreenplayHost(hidden)).toThrow(forbidden);
  const missing:Record<string,unknown>={...host()};delete missing[field];missing['replacement']=true;expect(()=>captureScreenplayHost(missing)).toThrow(forbidden);
});

it('rejects nested identity accessors without reading them, symbols, and opaque proxy traps',()=>{
  let actorTouched=false,scopeTouched=false;const actor=Object.defineProperty({kind:'human'},'id',{enumerable:true,get(){actorTouched=true;throw new Error('private actor getter');}});
  const nestedScope=Object.defineProperty({projectId:scope.projectId},'tenantId',{enumerable:true,get(){scopeTouched=true;throw new Error('private scope getter');}});
  expect(()=>captureScreenplayHost({...host(),actor})).toThrow(forbidden);expect(()=>captureScreenplayHost({...host(),scope:nestedScope})).toThrow(forbidden);expect(actorTouched||scopeTouched).toBe(false);
  expect(()=>captureScreenplayHost({...host(),[Symbol('authority')]:'private'})).toThrow(forbidden);
  const opaque=new Proxy({}, {getPrototypeOf(){throw new Error('postgres://private-proxy');}});expect(()=>captureScreenplayHost(opaque)).toThrow(forbidden);
  const revoked=Proxy.revocable(host(),{});revoked.revoke();expect(()=>captureScreenplayHost(revoked.proxy)).toThrow(forbidden);
});

it('detaches a safely captured transparent proxy before using its authority',()=>{
  const input=host(),captured=captureScreenplayHost(new Proxy(input,{}));Object.assign(input.actor,{id:'later-proxy-human'});Object.assign(input.scope,{projectId:'later-proxy-project'});
  expect(authorizeScreenplayHost(captured,'screenplay:read',scope)).toMatchObject({actor:{kind:'human',id:'actual-human'},scope});
});

it.each([
  {...host(),actor:{kind:'agent_run',id:'agent'}},{...host(),actor:{kind:'system',id:'system'}},{...host(),actor:{kind:'human',id:'bad identity\n'}},
  {...host(),actor:{kind:'human',id:'actual-human',adopted:true}},{...host(),scope:{...scope,extra:true}},
  {...host(),at:'2026-11-19T06:00:00Z'},{...host(),at:'2026-11-19T06:00:00.000000Z'},{...host(),at:'2026-11-19T14:00:00.000+08:00'},
  {...host(),at:'2026-02-30T06:00:00.000Z'},{...host(),at:'2026-02-29T06:00:00.000Z'},
])('rejects non-human, extra or noncanonical identity content %#',input=>{expect(()=>captureScreenplayHost(input)).toThrow(forbidden);});

it.each(['screenplay:read','screenplay:prepare','screenplay:review','screenplay:finalize'] as const)('requires fresh exact synchronous authority for %s',action=>{
  const grant=vi.fn<ScreenplayHost['authorize']>(request=>{expect(Object.isFrozen(request)).toBe(true);expect(Object.isFrozen(request.scope)).toBe(true);return true;}),captured=authorizeScreenplayHost(host(grant),action,scope);
  expect(grant).toHaveBeenCalledExactlyOnceWith({action,scope});expect(captured.actor.id).toBe('actual-human');
  grant.mockReturnValue(false);expect(()=>authorizeScreenplayHost(captured,action,scope)).toThrow(forbidden);expect(grant).toHaveBeenCalledTimes(2);
});

it('rejects unknown actions and nonexact scopes before invoking grants',()=>{
  const grant=vi.fn(()=>true),input=host(grant);
  for(const invalid of ['screenplay:finalise','continuity:review',null,{},Symbol('private-action')])expect(()=>authorizeScreenplayHost(input,invalid as never,scope)).toThrow(forbidden);
  for(const invalid of [{...scope,tenantId:'different'},{...scope,projectId:'different'},{...scope,extra:true},{tenantId:scope.tenantId},null])expect(()=>authorizeScreenplayHost(input,'screenplay:read',invalid)).toThrow(forbidden);
  let touched=false;const getter=Object.defineProperty({},'tenantId',{enumerable:true,get(){touched=true;throw new Error('private authority scope');}});expect(()=>authorizeScreenplayHost(input,'screenplay:read',getter)).toThrow(forbidden);expect(touched).toBe(false);expect(grant).not.toHaveBeenCalled();
});

it.each([false,null,undefined,0,1,'true',{},Object(true)])('denies nonliteral grant result %# synchronously',allowed=>{
  const grant=vi.fn(()=>allowed);expect(()=>authorizeScreenplayHost(host(grant as unknown as ScreenplayHost['authorize']),'screenplay:read',scope)).toThrow(forbidden);expect(grant).toHaveBeenCalledOnce();
});

it('never assimilates a thenable or invokes its then getter when denying a grant',()=>{
  let touched=false,called=false;const getter=Object.defineProperty({},'then',{get(){touched=true;throw new Error('private then getter');}}),thenable={then(){called=true;throw new Error('private then invocation');}};
  for(const allowed of [getter,thenable])expect(()=>authorizeScreenplayHost(host((()=>allowed) as unknown as ScreenplayHost['authorize']),'screenplay:review',scope)).toThrow(forbidden);
  expect(touched).toBe(false);expect(called).toBe(false);
});

it('observes a real rejected Promise without reading its overridden then property or granting async authority',async()=>{
  let touched=false;const rejection=Promise.reject(new Error('private rejected permission'));
  void Object.defineProperty(rejection,'then',{get(){touched=true;throw new Error('private Promise then accessor');}});
  expect(()=>authorizeScreenplayHost(host((()=>rejection) as unknown as ScreenplayHost['authorize']),'screenplay:review',scope)).toThrow(forbidden);
  expect(()=>authorizeScreenplayHost(host((()=>Promise.resolve(true)) as unknown as ScreenplayHost['authorize']),'screenplay:review',scope)).toThrow(forbidden);
  await new Promise<void>(resolve=>setImmediate(resolve));expect(touched).toBe(false);
});

it('redacts throwing and opaque grant failures while retaining captured authority against callback mutation',()=>{
  for(const thrown of [new Error('postgres://private-grant'),new Proxy({}, {getPrototypeOf(){throw new Error('private prototype');}})])expect(()=>authorizeScreenplayHost(host(()=>{throw thrown;}),'screenplay:read',scope)).toThrow(forbidden);
  const suppliedScope={...scope},input=host(request=>{Object.assign(input.actor,{id:'late-human'});Object.assign(input.scope,{projectId:'late-project'});suppliedScope.tenantId='late-tenant';expect(request.scope).toEqual(scope);return true;});
  expect(authorizeScreenplayHost(input,'screenplay:finalize',suppliedScope)).toMatchObject({actor:{kind:'human',id:'actual-human'},scope});
});
