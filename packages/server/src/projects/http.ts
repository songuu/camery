import {Body,Controller,Get,Inject,Module,Param,Post,Query,Req} from '@nestjs/common';
import type {DynamicModule} from '@nestjs/common';
import {z} from 'zod';
import {accessId} from '@camery/access';
import {StableId} from '@camery/ir';
import {DevelopmentCandidatePrepareSchema,WorkbenchAdoptSchema,WorkbenchCandidateDetailSchema,WorkbenchCandidateListQuerySchema,WorkbenchCandidatePageSchema,WorkbenchPreviewSchema,WorkbenchPreviewResultSchema,WorkbenchRejectSchema,WorkbenchStateSchema,WorkbenchSubmitSchema,WorkbenchUpgradeSchema,WorkbenchActionReceiptSchema} from '@camery/ir/workbench';
import {snapshotJson,JsonBoundaryError} from '@camery/methods/json';
import {RequireAccess} from '../policy.js';
import type {AuthRequest} from '../policy.js';
import {ProjectApplication} from './application.js';
import type {ProjectApplicationOptions} from './options.js';
import {ProjectApplicationError} from './intent-contracts.js';
const APPLICATION=Symbol('camery.project.application');
const requestBytes=532480;
function parse<S extends z.ZodType>(schema:S,input:unknown):z.infer<S>{
  try{const result=schema.safeParse(snapshotJson(input,requestBytes));if(result.success)return result.data;}
  catch(error){if(error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT')throw new ProjectApplicationError('INPUT_LIMIT','HTTP request');}
  throw new ProjectApplicationError('INVALID_INPUT','HTTP request');
}
function query<S extends z.ZodType>(schema:S,input:unknown):z.infer<S>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ProjectApplicationError('INVALID_INPUT','HTTP query');
  const data:Record<string,unknown>=Object.create(null);
  for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))){if(!descriptor.enumerable||!('value' in descriptor))throw new ProjectApplicationError('INVALID_INPUT','HTTP query');data[name]=descriptor.value;}
  return parse(schema,data);
}
function idempotency(request:AuthRequest,applicationId?:string):string{
  const count=request.raw.rawHeaders.filter((name,index)=>index%2===0&&name.toLowerCase()==='idempotency-key').length;
  const key=request.headers['idempotency-key'];
  if(count!==1||typeof key!=='string'||!accessId.safeParse(key).success||applicationId!==undefined&&key!==applicationId)throw new ProjectApplicationError('INVALID_INPUT','idempotency key');
  return key;
}
async function envelope<S extends z.ZodType>(schema:S,result:Promise<unknown>,request:AuthRequest):Promise<{data:z.infer<S>;requestId:string}>{
  const data=await result;
  try{return {data:schema.parse(snapshotJson(data,1048576)),requestId:request.id};}
  catch{throw new ProjectApplicationError('STORAGE_FAILED','HTTP response projection');}
}
const candidateIdSchema=StableId.refine(value=>value.length===26);
@Controller('api/v1/projects/:projectId')
class ProjectController{
  constructor(@Inject(APPLICATION) private readonly application:ProjectApplication){}
  @Get('workbench/state') @RequireAccess('project:read')
  state(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Query() input:unknown){
    query(z.strictObject({}),input);return envelope(WorkbenchStateSchema,this.application.state({subject:request.principal,projectId}),request);
  }
  @Get('workbench/candidates') @RequireAccess('project:read')
  list(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Query() input:unknown){
    const values=query(WorkbenchCandidateListQuerySchema,input);
    return envelope(WorkbenchCandidatePageSchema,this.application.listCandidates({subject:request.principal,projectId,...(values.runId===undefined?{}:{runId:values.runId}),...(values.cursor===undefined?{}:{cursor:values.cursor}),...(values.limit===undefined?{}:{limit:values.limit})}),request);
  }
  @Get('workbench/candidates/:candidateId') @RequireAccess('project:read')
  candidate(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('candidateId') candidateId:string,@Query() input:unknown){
    query(z.strictObject({}),input);return envelope(WorkbenchCandidateDetailSchema,this.application.candidate({subject:request.principal,projectId,candidateId:parse(candidateIdSchema,candidateId)}),request);
  }
  @Post('workbench/changes/preview') @RequireAccess('candidate:write')
  preview(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Body() body:unknown){
    const command=parse(WorkbenchPreviewSchema,body);return envelope(WorkbenchPreviewResultSchema,this.application.previewChange({subject:request.principal,projectId,command}),request);
  }
  @Post('workbench/candidates') @RequireAccess('candidate:write')
  submit(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Body() body:unknown){
    const command=parse(WorkbenchSubmitSchema,body);idempotency(request,command.applicationId);return envelope(WorkbenchCandidateDetailSchema,this.application.submitCandidate({subject:request.principal,projectId,command}),request);
  }
  @Post('workbench/schema-upgrade') @RequireAccess('candidate:write')
  upgrade(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Body() body:unknown){
    const command=parse(WorkbenchUpgradeSchema,body);idempotency(request,command.applicationId);return envelope(WorkbenchCandidateDetailSchema,this.application.prepareUpgrade({subject:request.principal,projectId,command}),request);
  }
  @Post('development/:runId/candidates') @RequireAccess('candidate:write')
  development(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string,@Body() body:unknown){
    const command=parse(DevelopmentCandidatePrepareSchema,body);idempotency(request,command.applicationId);return envelope(WorkbenchCandidateDetailSchema,this.application.prepareDevelopment({subject:request.principal,projectId,runId:parse(accessId,runId),command}),request);
  }
  @Post('workbench/candidates/:candidateId/adopt') @RequireAccess('candidate:review')
  adopt(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('candidateId') candidateId:string,@Body() body:unknown){
    const command=parse(WorkbenchAdoptSchema,body);const requestId=idempotency(request);return envelope(WorkbenchActionReceiptSchema,this.application.adoptCandidate({subject:request.principal,projectId,candidateId:parse(candidateIdSchema,candidateId),requestId,command}),request);
  }
  @Post('workbench/candidates/:candidateId/reject') @RequireAccess('candidate:review')
  reject(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('candidateId') candidateId:string,@Body() body:unknown){
    const command=parse(WorkbenchRejectSchema,body);const requestId=idempotency(request);return envelope(WorkbenchActionReceiptSchema,this.application.rejectCandidate({subject:request.principal,projectId,candidateId:parse(candidateIdSchema,candidateId),requestId,command}),request);
  }
}
@Module({})
export class ProjectModule{
  static register(options:ProjectApplicationOptions):DynamicModule{return {module:ProjectModule,controllers:[ProjectController],providers:[{provide:APPLICATION,useValue:new ProjectApplication(options)}]};}
}
