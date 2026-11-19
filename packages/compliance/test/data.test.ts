import {expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {canonical,equal,hash} from '../src/node/data.js';
it('canonicalizes nested object keys while preserving array order, scalar types, whitespace and UTF-8 content',()=>{
  const left={z:[{b:'甲😀\n',a:null},true,2],a:{y:' unchanged ',x:false}},right={a:{x:false,y:' unchanged '},z:[{a:null,b:'甲😀\n'},true,2]};
  const expected='{"a":{"x":false,"y":" unchanged "},"z":[{"a":null,"b":"甲😀\\n"},true,2]}';expect(canonical(left)).toBe(expected);expect(equal(left,right)).toBe(true);expect(hash(left)).toBe(createHash('sha256').update(expected).digest('hex'));expect(equal([1,2],[2,1])).toBe(false);expect(equal('1',1)).toBe(false);
});
it.each([0,-1,1.5,NaN,Infinity,67108865])('rejects invalid byte quota %s explicitly',limit=>{expect(()=>canonical(null,limit)).toThrow(expect.objectContaining({code:'INVALID_INPUT'}));});
it('spends logical JSON bytes including UTF-8, escaping and repeated shared references',()=>{
  const value={text:'甲😀\n'},bytes=Buffer.byteLength(JSON.stringify(value));expect(canonical(value,bytes)).toBe(JSON.stringify(value));expect(()=>canonical(value,bytes-1)).toThrow(expect.objectContaining({code:'INPUT_LIMIT'}));const shared={text:'x'.repeat(32)};expect(()=>canonical([shared,shared],64)).toThrow(expect.objectContaining({code:'INPUT_LIMIT'}));
});
it('rejects oversized arrays and preserves the legal array edge without truncation',()=>{
  expect(canonical(Array(65536).fill(null)).length).toBe(327681);expect(()=>canonical(Array(65537).fill(null))).toThrow(expect.objectContaining({code:'INPUT_LIMIT'}));
});
it.each([undefined,1n,Symbol('private'),()=>undefined,new Date(),NaN,Infinity,new Proxy({},{getPrototypeOf(){throw new Error('secret://prototype');}})])('sanitizes unsupported JSON values instead of serializing or leaking them',value=>{expect(()=>canonical(value)).toThrow(expect.objectContaining({code:'INVALID_INPUT',message:expect.not.stringContaining('secret')}));});
it('does not execute accessors or toJSON hooks, and rejects cyclic data',()=>{
  const getter=vi.fn(()=>{throw new Error('secret://getter');}),hook=vi.fn(()=>({substitute:true})),input=Object.defineProperty({},'text',{get:getter,enumerable:true}),cyclic:{self?:unknown}={};cyclic.self=cyclic;
  for(const value of [input,{toJSON:hook},cyclic])expect(()=>hash(value)).toThrow(expect.objectContaining({code:'INVALID_INPUT',message:expect.not.stringContaining('secret')}));expect(getter).not.toHaveBeenCalled();expect(hook).not.toHaveBeenCalled();
});
