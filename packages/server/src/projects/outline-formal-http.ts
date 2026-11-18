import {Controller,Get,Inject,Module,Param,Query,Req} from '@nestjs/common';
import type {DynamicModule} from '@nestjs/common';
import type {z} from 'zod';
import {StableId} from '@camery/ir';
import {OutlineFormalCollectionSchema,OutlineFormalListQuerySchema,OutlineFormalObjectQuerySchema,OutlineFormalSectionQuerySchema,OutlineFormalListSchema,OutlineFormalObjectSchema,OutlineFormalSectionPageSchema,OutlineFormalRowsSchema} from '@camery/ir/outline-formal';
import {snapshotJson} from '@camery/methods/json';
import {RequireAccess} from '../policy.js';
import type {AuthRequest} from '../policy.js';
import {ProjectApplicationError} from './intent-contracts.js';
import {captureOutlineIntent} from './outline-intent-data.js';
import {OutlineFormalReadApplication} from './outline-formal-application.js';
import type {OutlineFormalReadOptions} from './outline-formal-options.js';
import {OUTLINE_FORMAL_RESPONSE_BYTES} from './outline-formal-projection.js';
const APPLICATION=Symbol('camery.outline.formal.read'),stable=StableId.refine(value=>value.length===26);
const parse=<S extends z.ZodType>(schema:S,input:unknown)=>captureOutlineIntent(schema,input,'formal HTTP selector',16384);
function query<S extends z.ZodType>(schema:S,input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ProjectApplicationError('INVALID_INPUT','formal HTTP query');
  const data:Record<string,unknown>=Object.create(null);for(const [key,field] of Object.entries(Object.getOwnPropertyDescriptors(input))){if(!field.enumerable||!('value' in field))throw new ProjectApplicationError('INVALID_INPUT','formal HTTP query');data[key]=field.value;}return parse(schema,data);
}
async function response<S extends z.ZodType>(schema:S,pending:Promise<unknown>,request:AuthRequest){const value=await pending;try{const envelope={data:schema.parse(snapshotJson(value,OUTLINE_FORMAL_RESPONSE_BYTES,131072)),requestId:request.id};snapshotJson(envelope,OUTLINE_FORMAL_RESPONSE_BYTES,131072);return envelope;}catch{throw new ProjectApplicationError('STORAGE_FAILED','formal HTTP response');}}
@Controller('api/v1/projects/:projectId/formal-outline')
class OutlineFormalReadController{
  constructor(@Inject(APPLICATION) private readonly application:OutlineFormalReadApplication){}
  @Get() @RequireAccess('project:read')
  list(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Query() input:unknown){return response(OutlineFormalListSchema,this.application.list({subject:request.principal,projectId,command:query(OutlineFormalListQuerySchema,input)}),request);}
  @Get('rows') @RequireAccess('project:read')
  rows(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Query() input:unknown){return response(OutlineFormalRowsSchema,this.application.rows({subject:request.principal,projectId,command:query(OutlineFormalListQuerySchema,input)}),request);}
  @Get(':collection/:objectId') @RequireAccess('project:read')
  object(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('collection') collection:string,@Param('objectId') objectId:string,@Query() input:unknown){return response(OutlineFormalObjectSchema,this.application.object({subject:request.principal,projectId,collection:parse(OutlineFormalCollectionSchema,collection),objectId:parse(stable,objectId),command:query(OutlineFormalObjectQuerySchema,input)}),request);}
  @Get(':collection/:objectId/sections') @RequireAccess('project:read')
  section(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('collection') collection:string,@Param('objectId') objectId:string,@Query() input:unknown){return response(OutlineFormalSectionPageSchema,this.application.section({subject:request.principal,projectId,collection:parse(OutlineFormalCollectionSchema,collection),objectId:parse(stable,objectId),command:query(OutlineFormalSectionQuerySchema,input)}),request);}
}
@Module({})
export class OutlineFormalReadModule{
  static register(options:OutlineFormalReadOptions):DynamicModule{return {module:OutlineFormalReadModule,controllers:[OutlineFormalReadController],providers:[{provide:APPLICATION,useValue:new OutlineFormalReadApplication(options)}]};}
}
