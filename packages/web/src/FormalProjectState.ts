import type {WorkbenchSnapshot,WorkbenchReadQuery} from '@camery/ir/workbench';
import {WorkbenchObjectRefSchema} from '@camery/ir/workbench';
import type {WorkbenchObjectRef} from '@camery/ir/workbench';

export type FormalHistoryTarget=Pick<WorkbenchObjectRef,'collection'|'id'>;
const historyTargetSchema=WorkbenchObjectRefSchema.pick({collection:true,id:true});
export function formalHistoryTarget(input:unknown):FormalHistoryTarget|null{
  if(!input||typeof input!=='object'||Array.isArray(input))return null;
  const value=input as Record<string,unknown>;const parsed=historyTargetSchema.safeParse({...value,...(typeof value['id']==='string'?{id:value['id'].trim()}:{})});return parsed.success?parsed.data:null;
}

export class FormalProjectPages {
  pages:WorkbenchSnapshot[]=[];
  private query:WorkbenchReadQuery={};
  replace(page:WorkbenchSnapshot,query:WorkbenchReadQuery={}){this.query=structuredClone(query);this.pages=[page];}
  append(page:WorkbenchSnapshot){
    const first=this.pages[0];if(!first||page.projectKey!==first.projectKey||page.snapshotRevision!==first.snapshotRevision||page.scope.kind!==first.scope.kind||page.scope.id!==first.scope.id||page.renditionId!==first.renditionId)throw new Error('Cannot combine different adopted snapshots');
    this.pages=[...this.pages,page];
  }
  nextQuery():WorkbenchReadQuery|null{const first=this.pages[0];const cursor=this.pages.at(-1)?.nextCursor;return first&&cursor?{...this.query,expectedRevision:first.snapshotRevision,cursor,limit:50}:null;}
  clear(){this.pages=[];this.query={};}
}
/** Formal content is readable; local storage locations are never a browser media route. */
export function formalVisibleValue(value:unknown):unknown{
  if(Array.isArray(value))return value.map(formalVisibleValue);
  if(value===null||typeof value!=='object')return value;
  const output=Object.create(null) as Record<string,unknown>;for(const [key,item] of Object.entries(value)){
    if(key==='file'&&item!==null&&typeof item==='object'&&!Array.isArray(item)){const {path:_path,...metadata}=item as Record<string,unknown>;output[key]=formalVisibleValue(metadata);}
    else output[key]=formalVisibleValue(item);
  }
  return output;
}
