import { expect,it } from 'vitest';
import { snapshotJson,guardJson,JsonBoundaryError } from '../src/json.js';
it.each([
  'x'.repeat(131072),
  Array.from({length:95},(_,index)=>String.fromCharCode(index+32)).join('').repeat(512),
  'plain'.repeat(1000)+'"\\\n'+'😀中文\ud800\udfff',
  String.fromCharCode(...Array.from({length:65536},(_,index)=>index)),
])('keeps exact large plain or escaped string budgets %#',text=>{
  for(const value of [text,{[text.slice(0,1500)]:text},[text,text]]){
    const bytes=Buffer.byteLength(JSON.stringify(value));expect(snapshotJson(value,bytes)).toEqual(value);
    expect(()=>snapshotJson(value,bytes-1)).toThrow('INPUT_LIMIT');
  }
});
it('spends each large plain string before visiting later hostile data',()=>{
  let visited=false;const later=new Proxy({},{ownKeys(){visited=true;throw new Error('private');}}),text='x'.repeat(131072);
  expect(()=>snapshotJson([text,text,later],200000)).toThrow('INPUT_LIMIT');expect(visited).toBe(false);
});
it.each([null,true,false,0,-0,-12,1.25,1e30,'ASCII','你好','😀','\ud800','\udfff','"\\\b\t\n\f\r\u0001',[],{},[1,null,'你'],{a:'😀',b:['\u0000']}])('snapshots exact logical JSON bytes %j',value=>{
  const bytes=Buffer.byteLength(JSON.stringify(value));expect(snapshotJson(value,bytes)).toEqual(value);
  expect(()=>guardJson(value,bytes-1)).toThrow('INPUT_LIMIT');
});
it.each([undefined,()=>true,NaN,Infinity,new Date(),new Map(),Object.create({inherited:true}),Object.defineProperty({},'hidden',{value:1}),{[Symbol('hidden')]:1},
  Object.defineProperty({},'accessor',{enumerable:true,get(){throw new Error('secret');}}),JSON.parse('{"__proto__":1}'),JSON.parse('{"constructor":1}'),JSON.parse('{"prototype":1}')])('refuses non-data without leaking arbitrary errors %#',value=>{
  expect(()=>snapshotJson(value)).toThrow(JsonBoundaryError);
});
it('bounds sparse arrays, custom keys, cycles, depth and repeated aliases',()=>{
  const custom=[1];Object.assign(custom,{foo:2});const swapped=Array(1);Object.assign(swapped,{foo:2});
  const cycle:unknown[]=[];cycle.push(cycle);let nested:unknown=1;for(let i=0;i<50;i++)nested=[nested];
  for(const value of [Array(2),custom,swapped,cycle,nested,Object.fromEntries(Array.from({length:257},(_,i)=>['k'+i,1]))])expect(()=>snapshotJson(value)).toThrow(JsonBoundaryError);
  expect(()=>snapshotJson(Array(8193))).toThrow('INPUT_LIMIT');
  let visited=false;const later=new Proxy({},{ownKeys(){visited=true;throw new Error('private');}});const shared={text:'x'.repeat(600)};
  expect(()=>snapshotJson([shared,shared,later],1000)).toThrow('INPUT_LIMIT');expect(visited).toBe(false);
});
it('captures mutable proxy data only once, never reads an accessor length and redacts fake errors',()=>{
  let reads=0;const data=new Proxy({text:'small'},{getOwnPropertyDescriptor(target,key){if(key==='text')return {value:++reads===1?'small':'x'.repeat(3000000),enumerable:true,configurable:true,writable:true};return Reflect.getOwnPropertyDescriptor(target,key);}});
  expect(snapshotJson(data)).toEqual({text:'small'});expect(reads).toBe(1);
  let lengths=0;const sparse=new Proxy([],{get(target,key,receiver){if(key==='length'){lengths++;return 1000001;}return Reflect.get(target,key,receiver);},ownKeys:()=>['1000000','length'],getOwnPropertyDescriptor(target,key){if(key==='1000000')return {value:'x',enumerable:true,configurable:true,writable:true};return Reflect.getOwnPropertyDescriptor(target,key);}});
  expect(()=>snapshotJson(sparse,100,10)).toThrow(JsonBoundaryError);expect(lengths).toBe(0);
  for(const error of [undefined,null,new Error('private'),new JsonBoundaryError('INPUT_LIMIT','private')]){
    const value=new Proxy({},{ownKeys(){throw error;}});expect(()=>snapshotJson(value)).toThrow('data properties');
  }
});
