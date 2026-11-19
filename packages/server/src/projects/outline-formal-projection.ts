import type {z} from 'zod';
import {freeze} from '@camery/methods';
import {snapshotJson,JsonBoundaryError} from '@camery/methods/json';
import {OUTLINE_COLLECTIONS} from '@camery/ir';
import {OUTLINE_FORMAL_SECTIONS,OutlineFormalListSchema,OutlineFormalObjectSchema,OutlineFormalSectionPageSchema,OutlineFormalOverviewSchema,OutlineFormalRowsSchema} from '@camery/ir/outline-formal';
import type {OutlineFormalCollection,OutlineFormalRef,OutlineFormalSection,OutlineFormalListQuery} from '@camery/ir/outline-formal';
import type {OutlineFormalSnapshot} from './outline-formal-store.js';
import {ProjectApplicationError} from './intent-contracts.js';
import {encodeReadCursor} from './read-cursor.js';

export const OUTLINE_FORMAL_RESPONSE_BYTES=983040;
const DATA_BYTES=OUTLINE_FORMAL_RESPONSE_BYTES-256;
export interface FormalRow{ref:OutlineFormalRef;plan:{id:string;version:number};value:Record<string,unknown>}
export const compareFormal=(a:FormalRow,b:FormalRow)=>a.ref.collection<b.ref.collection?-1:a.ref.collection>b.ref.collection?1:a.ref.id<b.ref.id?-1:a.ref.id>b.ref.id?1:0;
export function formalRows(data:OutlineFormalSnapshot):FormalRow[]{
  return OUTLINE_COLLECTIONS.flatMap(collection=>data.snapshot[collection].map(value=>({ref:{collection,id:value.id,version:value.version},plan:'adaptation_plan' in value?value.adaptation_plan:{id:value.id,version:value.version},value:value as unknown as Record<string,unknown>}))).sort(compareFormal);
}
export function formalBase(projectKey:string,data:OutlineFormalSnapshot){return {contractVersion:1 as const,projectKey,projectId:data.target.projectId,schemaVersion:data.snapshot.schema_version,snapshotRevision:data.revision,headRevision:data.headRevision,writeVersion:data.writeVersion};}
export function formalSections(row:FormalRow){return (Object.entries(OUTLINE_FORMAL_SECTIONS) as [OutlineFormalSection,(typeof OUTLINE_FORMAL_SECTIONS)[OutlineFormalSection]][]).filter(([,definition])=>definition.collection===row.ref.collection);}
export function formalArray(row:FormalRow,section:OutlineFormalSection):unknown[]{
  const definition=OUTLINE_FORMAL_SECTIONS[section];if(definition.collection!==row.ref.collection)throw new ProjectApplicationError('INVALID_INPUT','formal section collection');
  let value:unknown=row.value;for(const key of definition.path){if(!value||typeof value!=='object'||Array.isArray(value))throw new ProjectApplicationError('STORAGE_FAILED','formal section data');value=(value as Record<string,unknown>)[key];}
  if(!Array.isArray(value))throw new ProjectApplicationError('STORAGE_FAILED','formal section array');return value;
}
export function formalObjectBody(row:FormalRow){
  const value=structuredClone(row.value),sections=formalSections(row).map(([section,definition])=>{
    let parent=value;for(const key of definition.path.slice(0,-1)){const child=parent[key];if(!child||typeof child!=='object'||Array.isArray(child))throw new ProjectApplicationError('STORAGE_FAILED','formal overview data');parent=child as Record<string,unknown>;}
    delete parent[definition.path.at(-1)!];return {section,total:formalArray(row,section).length};
  });
  return {ref:row.ref,plan:row.plan,overview:OutlineFormalOverviewSchema.parse({collection:row.ref.collection,value}),sections};
}
function sized<S extends z.ZodType>(schema:S,value:unknown):z.infer<S>{return freeze(schema.parse(snapshotJson(value,DATA_BYTES,131072))) as z.infer<S>;}
function limited(error:unknown):boolean{return error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT';}
export function formalObject(projectKey:string,data:OutlineFormalSnapshot,row:FormalRow){try{return sized(OutlineFormalObjectSchema,{...formalBase(projectKey,data),...formalObjectBody(row)});}catch(error){if(limited(error))throw new ProjectApplicationError('INPUT_LIMIT','formal overview size');throw error;}}
function selection(data:OutlineFormalSnapshot,query:OutlineFormalListQuery){
  const rows=formalRows(data);if(query.planId&&!rows.some(row=>row.ref.collection==='adaptation_plans'&&row.ref.id===query.planId))throw new ProjectApplicationError('NOT_FOUND','formal plan');
  return rows.filter(row=>(!query.collection||row.ref.collection===query.collection)&&(!query.planId||row.plan.id===query.planId));
}
export function formalListPage(input:{projectKey:string;data:OutlineFormalSnapshot;query:OutlineFormalListQuery;binding:unknown;last?:OutlineFormalRef;bulk?:boolean}){
  const {projectKey,data,query,binding,last}=input,rows=selection(data,query);let start=0;
  if(last){const index=rows.findIndex(row=>row.ref.collection===last.collection&&row.ref.id===last.id&&row.ref.version===last.version);if(index<0)throw new ProjectApplicationError('INVALID_INPUT','formal list cursor');start=index+1;}
  const counts=OUTLINE_COLLECTIONS.map(collection=>({collection,count:rows.filter(row=>row.ref.collection===collection).length}));
  const selected=rows.slice(start,start+(query.limit??20));
  const records=selected.map(row=>({kind:'complete' as const,ref:row.ref,plan:row.plan,record:{collection:row.ref.collection,value:row.value}}));
  if(input.bulk&&selected.length>1){
    const first=selected[0]!,nextCursor=start+1<rows.length?encodeReadCursor(binding,{revision:data.revision,last:first.ref}):null,base={...formalBase(projectKey,data),counts,nextCursor};
    // An oversized first row cannot fit any batch. Fall back once rather than rescanning it for every removed trailing row.
    try{sized(OutlineFormalRowsSchema,{...base,rows:[records[0]!]});}
    catch(error){if(!limited(error))throw error;return sized(OutlineFormalRowsSchema,{...base,rows:[{kind:'sectioned',...formalObjectBody(first)}]});}
  }
  while(true){
    const tail=selected.at(-1),nextCursor=tail&&start+selected.length<rows.length?encodeReadCursor(binding,{revision:data.revision,last:tail.ref}):null,base={...formalBase(projectKey,data),counts,nextCursor};
    try{
      if(!input.bulk)return sized(OutlineFormalListSchema,{...base,items:selected.map(row=>({ref:row.ref,plan:row.plan}))});
      return sized(OutlineFormalRowsSchema,{...base,rows:records});
    }catch(error){
      if(!limited(error))throw error;
      if(selected.length>1){selected.pop();records.pop();continue;}
      if(input.bulk&&selected.length===1){return sized(OutlineFormalRowsSchema,{...base,rows:[{kind:'sectioned',...formalObjectBody(selected[0]!)}]});}
      throw new ProjectApplicationError('INPUT_LIMIT','formal list page size');
    }
  }
}
export function formalSectionPage(input:{projectKey:string;data:OutlineFormalSnapshot;row:FormalRow;section:OutlineFormalSection;binding:unknown;offset:number;limit?:number}){
  const {projectKey,data,row,section,binding,offset}=input,array=formalArray(row,section);
  if(offset>array.length||offset===array.length&&offset!==0)throw new ProjectApplicationError('INVALID_INPUT','formal section cursor');
  const items=array.slice(offset,offset+(input.limit??20));
  while(true){
    const next=offset+items.length,nextCursor=next<array.length?encodeReadCursor(binding,{revision:data.revision,version:row.ref.version,offset:next}):null;
    try{return sized(OutlineFormalSectionPageSchema,{...formalBase(projectKey,data),ref:row.ref,plan:row.plan,section,total:array.length,items,nextCursor});}
    catch(error){if(!limited(error))throw error;if(items.length<=1)throw new ProjectApplicationError('INPUT_LIMIT','formal section item size');items.pop();}
  }
}
export function requiredFormalRow(data:OutlineFormalSnapshot,collection:OutlineFormalCollection,id:string):FormalRow{const found=formalRows(data).find(row=>row.ref.collection===collection&&row.ref.id===id);if(!found)throw new ProjectApplicationError('NOT_FOUND','formal object');return found;}
