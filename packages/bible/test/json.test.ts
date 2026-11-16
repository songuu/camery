import { expect, it } from 'vitest';
import { BibleError } from '../src/contracts.js';
import { guardJson } from '../src/json.js';
import { snapshotJson } from '../src/json.js';
import { canonical, copy, captureSource, ensureSource, parse } from '../src/data.js';
import { importNovel } from '@camery/ingest';
import { z } from 'zod';

it.each([null,true,false,0,-0,-12,1.25,1e30,'ASCII','你好','😀','\ud800','\udfff','"\\\b\t\n\f\r\u0001',[],{},[1,null,'你'],{a:'😀',b:['\u0000']}])('counts exact JSON byte boundaries %j',value=>{
  const bytes=Buffer.byteLength(JSON.stringify(value)); expect(()=>guardJson(value,bytes)).not.toThrow(); expect(()=>guardJson(value,bytes-1)).toThrow('INPUT_LIMIT');
  expect(JSON.parse(canonical(value))).toEqual(JSON.parse(JSON.stringify(value)));
});
it.each([undefined,()=>true,NaN,Infinity,new Date(),new Map(),Object.create({inherited:true}),Object.defineProperty({},'hidden',{value:1}),{[Symbol('hidden')]:1},
  Object.defineProperty({},'accessor',{enumerable:true,get(){throw new Error('sensitive');}}),JSON.parse('{"__proto__":1}'),JSON.parse('{"constructor":1}'),JSON.parse('{"prototype":1}')])('rejects non-data objects safely %#',value=>{
  expect(()=>guardJson(value)).toThrow('StoryBible');
});
it('bounds sparse, huge, custom-property and deeply nested arrays before serializing',()=>{
  expect(()=>guardJson(Array(100000))).toThrow('INPUT_LIMIT'); expect(()=>guardJson(Array(2))).toThrow();
  const extra=[1]; Object.assign(extra,{foo:2}); expect(()=>guardJson(extra)).toThrow();
  const swapped=Array(1); Object.assign(swapped,{foo:2}); expect(()=>guardJson(swapped)).toThrow();
  let nested:unknown=1; for(let i=0;i<50;i++)nested=[nested]; expect(()=>guardJson(nested)).toThrow();
  expect(()=>guardJson(Object.fromEntries(Array.from({length:257},(_,i)=>['k'+i,1])))).toThrow();
  const cycle:unknown[]=[]; cycle.push(cycle); expect(()=>guardJson(cycle)).toThrow();
});
it('counts repeated aliases logically and stops before visiting later oversized data',()=>{
  let visited=false; const later=new Proxy({},{ownKeys(){visited=true;throw new Error('must not reach');}});
  const shared={text:'x'.repeat(600)}; expect(()=>guardJson([shared,shared,later],1000)).toThrow('INPUT_LIMIT'); expect(visited).toBe(false);
  expect(()=>guardJson('x'.repeat(1001),1000)).toThrow();
});
it('does not leak arbitrary Proxy failures even if the exception mimics a domain error',()=>{
  for(const error of [undefined,null,new Error('private-value'),new BibleError('CONFLICT','private-value')]){
    const value=new Proxy({},{ownKeys(){throw error;}});
    try{guardJson(value);throw new Error('expected failure');}catch(caught){expect((caught as Error).message).not.toContain('private-value');}
  }
});
it('snapshots a changing data proxy exactly once rather than serialize a later oversized view',()=>{
  let reads=0; const value=new Proxy({text:'small'},{getOwnPropertyDescriptor(target,key){if(key==='text')return {value:++reads===1?'small':'x'.repeat(3_000_000),enumerable:true,configurable:true,writable:true};return Reflect.getOwnPropertyDescriptor(target,key);}});
  expect(copy(value)).toEqual({text:'small'}); expect(reads).toBe(1);
});
it('does not leak schema accessor exceptions, and rejects a forged external source header',()=>{
  const value=Object.defineProperty({},'text',{enumerable:true,get(){throw new Error('private');}});
  expect(()=>parse(z.strictObject({text:z.string()}),value,'safe operation')).toThrow('safe operation');
  const source=captureSource({tenantId:'t',projectId:'p',documentId:'d',kind:'novel',revision:1,document:importNovel('原文')});
  expect(()=>ensureSource({...structuredClone(source),source:{...source.source,originalDigest:'a'.repeat(64)}})).toThrow();
});
it('captures array length from one own data descriptor and rejects a changing sparse Proxy view',()=>{
  let reads=0;const raw=new Proxy([],{get(target,key,receiver){if(key==='length')return ++reads<3?1:1000001;return Reflect.get(target,key,receiver);},
    ownKeys:()=>['1000000','length'],getOwnPropertyDescriptor(target,key){if(key==='1000000')return {value:'x',enumerable:true,configurable:true,writable:true};return Reflect.getOwnPropertyDescriptor(target,key);}});
  expect(()=>snapshotJson(raw,100,10)).toThrow(); expect(reads).toBe(0);
});
