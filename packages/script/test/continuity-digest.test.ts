import {expect,it} from 'vitest';
import {canonicalContinuity,continuityDigest} from '../src/continuity/node/digest.js';
it('keeps object insertion order irrelevant while preserving all array values and Unicode',()=>{
  const first={b:[{z:'中文\n😀',a:-0},null,true],a:'quoted"'},second={a:'quoted"',b:[{a:0,z:'中文\n😀'},null,true]};expect(canonicalContinuity(first,1024)).toBe(canonicalContinuity(second,1024));expect(continuityDigest(first,1024)).toBe(continuityDigest(second,1024));expect(continuityDigest({a:[1,2]},1024)).not.toBe(continuityDigest({a:[2,1]},1024));
});
it('accepts a complete legal value larger than the old Method budget and enforces its actual own byte boundary',()=>{
  const value={text:'x'.repeat(2_100_000)},bytes=Buffer.byteLength(JSON.stringify(value));expect(canonicalContinuity(value,bytes)).toBe(JSON.stringify(value));expect(()=>canonicalContinuity(value,bytes-1)).toThrow('INPUT_LIMIT');
});
it('rejects unsafe objects and invalid budgets before invoking getters',()=>{
  let touched=false;const value=Object.defineProperty({},'secret',{enumerable:true,get:()=>{touched=true;return 'private';}});expect(()=>canonicalContinuity(value,1024)).toThrow('INVALID_INPUT');expect(touched).toBe(false);
  for(const budget of [0,Infinity,NaN,67_108_865])expect(()=>canonicalContinuity(null,budget)).toThrow('INVALID_INPUT');const cycle:unknown[]=[];cycle.push(cycle);expect(()=>canonicalContinuity(cycle,1024)).toThrow('INVALID_INPUT');
});
