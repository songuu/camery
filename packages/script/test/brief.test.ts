import { expect,it } from 'vitest';
import { z } from 'zod';
import { captureBrief,validateBrief } from '../src/brief.js';
import { canonical,copy,hash,parse } from '../src/data.js';
import { DevelopmentError } from '../src/contracts.js';
const input=()=>({tenantId:'tenant',projectId:'project',briefId:'idea',revision:1,idea:'修钟学徒发现每次校时都会提前收到一封写给明天的信。',episodeCount:10,targetSeconds:120});
it('pins the exact idea, scope and user constraints independently of insertion order or later mutation',()=>{
  const raw=input();const brief=captureBrief(raw);const second=captureBrief(Object.fromEntries(Object.entries(raw).reverse()));
  expect(brief).toEqual(second);expect(brief.idea).toBe(raw.idea);expect(Object.isFrozen(brief)).toBe(true);
  raw.idea='changed';expect(brief.idea).not.toBe(raw.idea);expect(validateBrief(JSON.parse(JSON.stringify(brief)))).toEqual(brief);
  for(const change of [{tenantId:'other'},{projectId:'other'},{briefId:'other'},{revision:2},{idea:'另一个故事'},{episodeCount:11},{targetSeconds:121}])expect(captureBrief({...input(),...change}).digest).not.toBe(brief.digest);
});
it.each([{},null,{...input(),approved:true},{...input(),revision:0},{...input(),episodeCount:0},{...input(),episodeCount:101},{...input(),targetSeconds:3601},{...input(),idea:' '},{...input(),idea:'\ud800'},{...input(),idea:'\0'},{...input(),idea:'a'.repeat(2001)}])('rejects invalid brief %#',value=>{expect(()=>captureBrief(value)).toThrow(DevelopmentError);});
it('rejects stale identities, byte amplification, accessors and arbitrary schema exceptions safely',()=>{
  const brief=captureBrief(input());expect(()=>validateBrief({...brief,digest:'a'.repeat(64)})).toThrow('CONFLICT');
  expect(()=>captureBrief({...input(),extra:'x'.repeat(9000)})).toThrow('INPUT_LIMIT');
  let called=false;const value=Object.defineProperty(input(),'idea',{enumerable:true,get(){called=true;throw new Error('private');}});
  expect(()=>captureBrief(value)).toThrow('INVALID_INPUT');expect(called).toBe(false);
  expect(()=>copy(new Proxy({},{ownKeys(){throw new Error('private');}}))).toThrow('data snapshot');
  const schema=z.unknown().transform(()=>{throw new Error('private');});expect(()=>parse(schema,{},'safe validation')).toThrow('safe validation');
  expect(canonical({b:2,a:1})).toBe('{"a":1,"b":2}');expect(hash({b:2,a:1})).toBe(hash({a:1,b:2}));
});
it('reserves the complete brief budget for version and digest so every captured value can be restored',()=>{
  const raw={...input(),idea:'\u0001'.repeat(1300)};
  raw.idea+='x'.repeat(8192-Buffer.byteLength(JSON.stringify(raw)));
  expect(raw.idea.length).toBeLessThanOrEqual(2000);expect(Buffer.byteLength(JSON.stringify(raw))).toBe(8192);
  expect(()=>captureBrief(raw)).toThrow('INPUT_LIMIT');
});
