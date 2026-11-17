import {expect,it} from 'vitest';
import {FormalProjectPages,formalVisibleValue,formalHistoryTarget} from '../src/FormalProjectState.js';
import type {WorkbenchSnapshot} from '@camery/ir/workbench';
import {AdoptionLifetime as ReadLifetime} from '../src/DevelopmentAdoptionState.js';
const id='01ARZ3NDEKTSV4RRFFQ69G5FAV';
const page=(revision:number,cursor:string|null='cursor'):WorkbenchSnapshot=>({contractVersion:1,projectKey:'project',projectId:id,schemaVersion:'0.6.0-draft',snapshotRevision:revision,writeVersion:2,scope:{kind:'project',id},renditionId:null,nextCursor:cursor,counts:[],capabilities:{canWrite:false,canReview:false,canReadMedia:false},rows:[],relations:[],lineage:[],locks:[]});
it('pins pagination to the first adopted snapshot and rejects mixing a new head into saved pages',()=>{
  const pages=new FormalProjectPages();pages.replace(page(8));expect(pages.nextQuery()).toEqual({expectedRevision:8,cursor:'cursor',limit:50});expect(()=>pages.append(page(9))).toThrow();expect(pages.pages).toHaveLength(1);
  pages.clear();expect(pages.nextQuery()).toBeNull();expect(pages.pages).toEqual([]);pages.replace(page(9));expect(pages.nextQuery()?.expectedRevision).toBe(9);
});
it('accepts a canonical historical object reference without inventing a current object version',()=>{
  expect(formalHistoryTarget({collection:'shots',id:` ${id} `})).toEqual({collection:'shots',id});
  for(const target of [{collection:'shots',id:'../escape'},{collection:'unknown',id},{collection:'shots',id,version:1},{collection:'shots',id:id.toLowerCase()}])expect(formalHistoryTarget(target)).toBeNull();
});
it('hides local media paths without rounding timing or dropping other business fields',()=>{
  const visible=formalVisibleValue({id,file:{path:'C:\\private\\asset.png',sha256:'digest'},duration:{planned:1.123456789,measured:null},development:{desire:'回家'}});
  expect(JSON.stringify(visible)).not.toContain('private');expect(visible).toMatchObject({file:{sha256:'digest'},duration:{planned:1.123456789,measured:null},development:{desire:'回家'}});
});
it('does not replace the active account or project content with a late completion from the previous lifetime',()=>{
  const lifetime=new ReadLifetime();const pages=new FormalProjectPages();const old=lifetime.next();const active=lifetime.next();
  if(lifetime.current(active))pages.replace(page(9));if(lifetime.current(old))pages.replace(page(8));
  expect(old.signal.aborted).toBe(true);expect(pages.pages[0]?.snapshotRevision).toBe(9);lifetime.close();expect(active.signal.aborted).toBe(true);
});
