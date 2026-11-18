import {OutlineFormalObjectSchema,OutlineFormalRowsSchema,OutlineFormalSectionPageSchema,OutlineFormalRefSchema} from '@camery/ir/outline-formal';
import type {OutlineFormalCollection,OutlineFormalObject,OutlineFormalRef,OutlineFormalRows,OutlineFormalRow,OutlineFormalSection,OutlineFormalSectionPage,OutlineFormalListQuery,OutlineFormalObjectQuery,OutlineFormalSectionQuery} from '@camery/ir/outline-formal';
import {WorkbenchObjectHistorySchema} from '@camery/ir/workbench';
import type {WorkbenchHistoryQuery,WorkbenchObjectHistory} from '@camery/ir/workbench';
import {AdoptionLifetime} from './DevelopmentAdoptionState.js';
import {ApiError} from './api.js';
import {ZodError} from 'zod';

export interface FormalOutlineClient{
  formalOutlineRows(projectId:string,query?:OutlineFormalListQuery,signal?:AbortSignal):Promise<OutlineFormalRows>;
  formalOutlineObject(projectId:string,collection:OutlineFormalCollection,objectId:string,query?:OutlineFormalObjectQuery,signal?:AbortSignal):Promise<OutlineFormalObject>;
  formalOutlineSection(projectId:string,collection:OutlineFormalCollection,objectId:string,query:OutlineFormalSectionQuery,signal?:AbortSignal):Promise<OutlineFormalSectionPage>;
  readWorkbenchObjectHistory(projectId:string,collection:'characters'|'episodes',objectId:string,query?:WorkbenchHistoryQuery,signal?:AbortSignal):Promise<WorkbenchObjectHistory>;
}
export interface FormalReferenceTarget{collection:'characters'|'episodes';id:string;version?:number}
type HistoryItem=WorkbenchObjectHistory['items'][number];
type SectionItem=OutlineFormalSectionPage['items'][number];
export interface FormalSectionState{readonly items:readonly SectionItem[];readonly total:number;readonly nextCursor:string|null;readonly visitedCursors?:readonly string[]}
export interface FormalOutlineState{
  readonly meta:Omit<OutlineFormalRows,'rows'|'counts'|'nextCursor'>|null;
  readonly rows:readonly OutlineFormalRow[];readonly counts:OutlineFormalRows['counts'];readonly nextCursor:string|null;readonly collection:OutlineFormalCollection|'';
  readonly detail:OutlineFormalObject|null;readonly sections:Readonly<Partial<Record<OutlineFormalSection,FormalSectionState>>>;
  readonly reference:{target:FormalReferenceTarget;item:HistoryItem|null}|null;readonly busy:boolean;readonly error:string|null;
  readonly visitedCursors?:readonly string[];
}
const initial=():FormalOutlineState=>({meta:null,rows:[],counts:[],nextCursor:null,collection:'',detail:null,sections:{},reference:null,busy:false,error:null});
const key=(ref:OutlineFormalRef)=>ref.collection+':'+ref.id;
function meta(page:OutlineFormalRows|OutlineFormalObject|OutlineFormalSectionPage){return {contractVersion:page.contractVersion,projectKey:page.projectKey,projectId:page.projectId,schemaVersion:page.schemaVersion,snapshotRevision:page.snapshotRevision,headRevision:page.headRevision,writeVersion:page.writeVersion};}
function failResponse():never{throw new ApiError('BAD_RESPONSE');}
function countsMatch(left:OutlineFormalRows['counts'],right:OutlineFormalRows['counts']){return left.length===right.length&&left.every(item=>right.some(other=>other.collection===item.collection&&other.count===item.count));}
function completeRows(page:OutlineFormalRows,rows:readonly OutlineFormalRow[]){const total=page.counts.reduce((sum,item)=>sum+item.count,0);if(page.counts.length!==6||rows.some(row=>!page.counts.some(item=>item.collection===row.ref.collection))||page.counts.some(item=>rows.filter(row=>row.ref.collection===item.collection).length>item.count)||page.nextCursor===null&&rows.length!==total||page.nextCursor!==null&&(rows.length===0||rows.length>=total))failResponse();}
function binding(page:{projectKey:string;projectId:string;snapshotRevision:number},projectId:string,selected:FormalOutlineState['meta'],revision?:number){if(page.projectKey!==projectId||revision!==undefined&&page.snapshotRevision!==revision||selected&&(page.projectId!==selected.projectId||page.snapshotRevision!==selected.snapshotRevision))failResponse();}
function errorMessage(problem:unknown){const code=problem instanceof ApiError?problem.code:problem instanceof ZodError?'BAD_RESPONSE':'';return ({SCHEMA_UPGRADE_REQUIRED:'此项目尚未升级为正式大纲格式，请先准备并采用项目升级。',NOT_FOUND:'正式项目或这份记录不存在，请核对项目关联。',SNAPSHOT_STALE:'项目已有新修订，请先“核对此修订”，再查看关联资料。',BAD_RESPONSE:'服务返回的正式内容不一致，请重新核对所选修订。',PINNED_VERSION_UNAVAILABLE:'所选修订中的对象已更新，不能用新版本替换这条固定引用。',STORAGE_FAILED:'正式内容暂时无法读取，请稍后重试。',FORBIDDEN:'当前账号没有读取此项目的权限。',UNAUTHENTICATED:'当前会话已失效，请重新连接。'} as Record<string,string>)[code]??'暂时无法完成读取，所选内容会保留。';}

/** Historical rows are descending versions with a validated parent chain; later facts never stand in for a pinned old reference. */
export function selectFormalReference(items:readonly HistoryItem[],target:FormalReferenceTarget,snapshotRevision:number):HistoryItem|null{return items.find(item=>item.ref.collection===target.collection&&item.ref.id===target.id&&item.snapshotRevision<=snapshotRevision&&(target.version===undefined||item.ref.version===target.version))??null;}
export function formalReferenceTarget(collection:OutlineFormalCollection,field:string,value:unknown):FormalReferenceTarget|null{
  if(collection==='outline_episode_plans'&&field==='episode_id'&&typeof value==='string'&&OutlineFormalRefSchema.shape.id.safeParse(value).success)return {collection:'episodes',id:value};
  if(!['character','characters'].includes(field)||!value||typeof value!=='object'||Array.isArray(value))return null;
  const ref=value as Record<string,unknown>;if(Object.keys(ref).length!==2||!OutlineFormalRefSchema.shape.id.safeParse(ref['id']).success||!OutlineFormalRefSchema.shape.version.safeParse(ref['version']).success)return null;
  return {collection:'characters',id:ref['id'] as string,version:ref['version'] as number};
}

/** Each operation owns a cancellable lifetime; all displayed pages belong to one explicit immutable snapshot. */
export class FormalOutlineController{
  private value:FormalOutlineState=initial();private closed=false;private readonly lifetime=new AdoptionLifetime();private readonly listeners=new Set<()=>void>();
  constructor(private readonly client:FormalOutlineClient,private readonly projectId:string,private readonly onFailure:(error:unknown)=>void){}
  snapshot=():FormalOutlineState=>this.value;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  activate(){this.closed=false;}
  close(){this.closed=true;this.lifetime.close();this.value={...this.value,busy:false};}
  private patch(change:Partial<FormalOutlineState>){this.value={...this.value,...change};for(const listener of this.listeners)listener();}
  private async run(action:(signal:AbortSignal)=>Promise<Partial<FormalOutlineState>>){
    if(this.closed||this.value.busy)return;const ticket=this.lifetime.next();this.patch({busy:true,error:null});
    try{const change=await action(ticket.signal);if(!this.closed&&this.lifetime.current(ticket))this.patch(change);}
    catch(problem){if(!this.closed&&this.lifetime.current(ticket)){if(problem instanceof ApiError&&['UNAUTHENTICATED','FORBIDDEN'].includes(problem.code))this.onFailure(problem);this.patch({error:errorMessage(problem)});}}
    finally{if(!this.closed&&this.lifetime.current(ticket))this.patch({busy:false});}
  }
  async load(revision?:number,collection:OutlineFormalCollection|''=this.value.collection){
    return this.run(async signal=>{const page=OutlineFormalRowsSchema.parse(await this.client.formalOutlineRows(this.projectId,{...(revision===undefined?{}:{revision}),...(collection?{collection}:{}),limit:20},signal));binding(page,this.projectId,null,revision);if(this.value.meta&&page.projectId!==this.value.meta.projectId||collection&&page.rows.some(row=>row.ref.collection!==collection))failResponse();completeRows(page,page.rows);return {meta:meta(page),rows:page.rows,counts:page.counts,nextCursor:page.nextCursor,visitedCursors:page.nextCursor?[page.nextCursor]:[],collection,detail:null,sections:{},reference:null};});
  }
  filter(collection:OutlineFormalCollection|''){return this.load(this.value.meta?.snapshotRevision,collection);}
  async more(){
    const selected=this.value.meta,cursor=this.value.nextCursor,collection=this.value.collection,old=this.value.rows;if(!selected||!cursor)return;
    return this.run(async signal=>{const page=OutlineFormalRowsSchema.parse(await this.client.formalOutlineRows(this.projectId,{revision:selected.snapshotRevision,...(collection?{collection}:{}),limit:20,cursor},signal));binding(page,this.projectId,selected);const keys=new Set(old.map(row=>key(row.ref)));if(!countsMatch(page.counts,this.value.counts)||page.nextCursor!==null&&this.value.visitedCursors?.includes(page.nextCursor)||page.rows.length===0||page.rows.some(row=>keys.has(key(row.ref))||collection&&row.ref.collection!==collection))failResponse();const rows=[...old,...page.rows];completeRows(page,rows);return {meta:meta(page),rows,counts:page.counts,nextCursor:page.nextCursor,visitedCursors:[...(this.value.visitedCursors??[]),...(page.nextCursor?[page.nextCursor]:[])]};});
  }
  async open(ref:OutlineFormalRef){const selected=this.value.meta,target={...ref};if(!selected)return;return this.run(async signal=>{const page=OutlineFormalObjectSchema.parse(await this.client.formalOutlineObject(this.projectId,target.collection,target.id,{revision:selected.snapshotRevision},signal));binding(page,this.projectId,selected);if(page.ref.collection!==target.collection||page.ref.id!==target.id)failResponse();if(page.ref.version!==target.version)throw new ApiError('PINNED_VERSION_UNAVAILABLE');return {meta:meta(page),detail:page,sections:{},reference:null};});}
  async section(section:OutlineFormalSection){
    const detail=this.value.detail,selected=this.value.meta;if(!detail||!selected)return;const descriptor=detail.sections.find(item=>item.section===section);if(!descriptor)return;
    const old=this.value.sections[section];if(old&&!old.nextCursor)return;
    return this.run(async signal=>{const page=OutlineFormalSectionPageSchema.parse(await this.client.formalOutlineSection(this.projectId,detail.ref.collection,detail.ref.id,{revision:selected.snapshotRevision,section,limit:20,...(old?.nextCursor?{cursor:old.nextCursor}:{})},signal));binding(page,this.projectId,selected);if(page.section!==section||page.ref.id!==detail.ref.id||page.ref.collection!==detail.ref.collection||page.ref.version!==detail.ref.version||page.total!==descriptor.total||page.nextCursor!==null&&old?.visitedCursors?.includes(page.nextCursor))failResponse();const items=[...(old?.items??[]),...page.items];if(items.length>page.total||page.nextCursor===null&&items.length!==page.total||page.nextCursor!==null&&page.items.length===0)failResponse();return {meta:meta(page),sections:{...this.value.sections,[section]:{items,total:page.total,nextCursor:page.nextCursor,visitedCursors:[...(old?.visitedCursors??[]),...(page.nextCursor?[page.nextCursor]:[])]}}};});
  }
  async reference(input:FormalReferenceTarget){
    const selected=this.value.meta,target={...input};if(!selected)return;
    return this.run(async signal=>{let cursor:string|undefined;const seen=new Set<string>();let previousVersion:number|undefined,previousSnapshot=selected.headRevision;
      do{if(signal.aborted)throw new ApiError('CANCELLED');const page=WorkbenchObjectHistorySchema.parse(await this.client.readWorkbenchObjectHistory(this.projectId,target.collection,target.id,{expectedRevision:selected.headRevision,limit:50,...(cursor?{cursor}:{})},signal));if(signal.aborted)throw new ApiError('CANCELLED');if(page.projectKey!==this.projectId||page.projectId!==selected.projectId||page.objectId!==target.id||page.collection!==target.collection||page.snapshotRevision!==selected.headRevision)failResponse();
        for(const item of page.items){if(item.ref.collection!==target.collection||item.ref.id!==target.id||previousVersion!==undefined&&item.ref.version>=previousVersion||item.snapshotRevision>previousSnapshot)failResponse();previousVersion=item.ref.version;previousSnapshot=item.snapshotRevision;}
        const item=selectFormalReference(page.items,target,selected.snapshotRevision);if(item)return {reference:{target,item}};
        if(page.nextCursor===null||target.version!==undefined&&previousVersion!==undefined&&previousVersion<target.version)return {reference:{target,item:null}};if(seen.has(page.nextCursor)||page.items.length===0)failResponse();seen.add(page.nextCursor);cursor=page.nextCursor;
      }while(cursor);return {reference:{target,item:null}};
    });
  }
}
