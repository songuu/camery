import {z} from 'zod';
import {AccessError,authorize,parseIdentity} from '@camery/access';
import {StableId} from '@camery/ir';
import {OutlineFormalCollectionSchema,OutlineFormalRefSchema,OutlineFormalListQuerySchema,OutlineFormalObjectQuerySchema,OutlineFormalSectionQuerySchema,OUTLINE_FORMAL_SECTIONS} from '@camery/ir/outline-formal';
import type {OutlineFormalList,OutlineFormalRows} from '@camery/ir/outline-formal';
import {ProjectIdentityScopeSchema,ProjectIdentityError} from './contracts.js';
import {ProjectApplicationError} from './intent-contracts.js';
import {captureOutlineIntent} from './outline-intent-data.js';
import type {OutlineFormalReadOptions} from './outline-formal-options.js';
import type {OutlineFormalSnapshot} from './outline-formal-store.js';
import type {VersionProjectKey} from '@camery/versioning/node';
import {decodeReadCursor} from './read-cursor.js';
import {formalListPage,formalObject,formalSectionPage,requiredFormalRow} from './outline-formal-projection.js';

interface Context{subject:unknown;projectId:string}
const stable=StableId.refine(value=>value.length===26),positive=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),id=ProjectIdentityScopeSchema.shape.projectId;
const ListPosition=z.strictObject({revision:positive,last:OutlineFormalRefSchema}),SectionPosition=z.strictObject({revision:positive,version:positive,offset:positive.max(131072)});
const capture=<S extends z.ZodType>(schema:S,input:unknown)=>captureOutlineIntent(schema,input,'formal read input',16384);
function safe<A extends unknown[],R>(operation:string,action:(...args:A)=>Promise<R>):(...args:A)=>Promise<R>{return async(...args)=>{try{return await action(...args);}catch(error){let known=false;try{known=error instanceof AccessError||error instanceof ProjectIdentityError||error instanceof ProjectApplicationError;}catch{/* Host dependencies cannot expose proxy diagnostics. */}if(known)throw error;throw new ProjectApplicationError('STORAGE_FAILED',operation);}};}
/** Every page authorizes the current session; positions select immutable facts and never grant access. */
export class OutlineFormalReadApplication{
  private readonly options:OutlineFormalReadOptions;
  constructor(options:OutlineFormalReadOptions){this.options=Object.freeze({...options});this.list=safe('formal list',this.list.bind(this));this.rows=safe('formal rows',this.rows.bind(this));this.object=safe('formal object',this.object.bind(this));this.section=safe('formal section',this.section.bind(this));}
  private context(input:Context){const subject=parseIdentity(input.subject),projectId=capture(id,input.projectId);authorize(subject,this.options.tenantId,projectId,'project:read');return {subject,projectId};}
  private async authority(context:ReturnType<OutlineFormalReadApplication['context']>){
    const scope={tenantId:context.subject.tenantId,projectId:context.projectId},binding=await this.options.identities.resolveProject(scope);
    if(binding.tenantId!==scope.tenantId||binding.projectId!==scope.projectId||!stable.safeParse(binding.versionKey.tenantId).success||!stable.safeParse(binding.versionKey.projectId).success)throw new ProjectApplicationError('STORAGE_FAILED','formal project binding');return {scope,target:binding.versionKey,subjectId:context.subject.userId};
  }
  private async load(target:VersionProjectKey,revision?:number):Promise<OutlineFormalSnapshot>{
    const data=await this.options.store.snapshot({target,...(revision===undefined?{}:{revision})});if(!data)throw new ProjectApplicationError('NOT_FOUND','formal project');
    if(data.target.tenantId!==target.tenantId||data.target.projectId!==target.projectId||data.snapshot.project.id!==target.projectId||data.packageId!==data.snapshot.package_id||data.revision!==data.snapshot.revision.number||data.snapshot.revision.status!=='adopted'||!positive.safeParse(data.revision).success||!positive.safeParse(data.headRevision).success||!positive.safeParse(data.writeVersion).success||data.revision>data.headRevision||revision!==undefined&&revision!==data.revision)throw new ProjectApplicationError('STORAGE_FAILED','formal snapshot binding');
    if(data.snapshot.schema_version!=='0.7.0-draft'&&data.snapshot.schema_version!=='0.8.0-draft')throw new ProjectApplicationError('SCHEMA_UPGRADE_REQUIRED','formal outline schema');return data;
  }
  async list(input:Context&{command:unknown}){return this.readList(input,false);}
  async rows(input:Context&{command:unknown}){return this.readList(input,true);}
  private readList(input:Context&{command:unknown},bulk:false):Promise<OutlineFormalList>;
  private readList(input:Context&{command:unknown},bulk:true):Promise<OutlineFormalRows>;
  private async readList(input:Context&{command:unknown},bulk:boolean){
    const query=capture(OutlineFormalListQuerySchema,input.command),context=this.context(input),authority=await this.authority(context),binding={kind:bulk?'outline-formal-rows':'outline-formal-list',...authority,collection:query.collection??null,planId:query.planId??null};
    const cursor=query.cursor?decodeReadCursor(binding,query.cursor,ListPosition):undefined;
    if(cursor&&query.revision!==undefined&&query.revision!==cursor.revision)throw new ProjectApplicationError('INVALID_INPUT','formal cursor revision');
    const data=await this.load(authority.target,cursor?.revision??query.revision);return formalListPage({projectKey:context.projectId,data,query,binding,...(cursor?{last:cursor.last}:{}),bulk});
  }
  async object(input:Context&{collection:string;objectId:string;command:unknown}){
    const query=capture(OutlineFormalObjectQuerySchema,input.command),collection=capture(OutlineFormalCollectionSchema,input.collection),objectId=capture(stable,input.objectId),context=this.context(input),authority=await this.authority(context),data=await this.load(authority.target,query.revision);
    return formalObject(context.projectId,data,requiredFormalRow(data,collection,objectId));
  }
  async section(input:Context&{collection:string;objectId:string;command:unknown}){
    const query=capture(OutlineFormalSectionQuerySchema,input.command),collection=capture(OutlineFormalCollectionSchema,input.collection),objectId=capture(stable,input.objectId),context=this.context(input);
    if(OUTLINE_FORMAL_SECTIONS[query.section].collection!==collection)throw new ProjectApplicationError('INVALID_INPUT','formal section selector');
    const authority=await this.authority(context),binding={kind:'outline-formal-section',...authority,collection,objectId,section:query.section},cursor=query.cursor?decodeReadCursor(binding,query.cursor,SectionPosition):undefined;
    if(cursor&&query.revision!==undefined&&query.revision!==cursor.revision)throw new ProjectApplicationError('INVALID_INPUT','formal cursor revision');
    const data=await this.load(authority.target,cursor?.revision??query.revision),row=requiredFormalRow(data,collection,objectId);
    if(cursor&&cursor.version!==row.ref.version)throw new ProjectApplicationError('INVALID_INPUT','formal object cursor version');
    return formalSectionPage({projectKey:context.projectId,data,row,section:query.section,binding,offset:cursor?.offset??0,...(query.limit===undefined?{}:{limit:query.limit})});
  }
}
