import {Body,Controller,Get,Inject,Module,Param,Post,Query,Req} from '@nestjs/common';
import type {DynamicModule} from '@nestjs/common';
import type {z} from 'zod';
import {z as schemas} from 'zod';
import {StableId} from '@camery/ir';
import {OutlinePrepareCommandSchema,OutlineAdoptCommandSchema,OutlineRejectCommandSchema,OutlineCandidateSchema,OutlineCandidatePageSchema,OutlineCandidateListQuerySchema,OutlineReceiptSchema,OutlineReceiptQuerySchema,OutlineReceiptPageSchema} from '@camery/ir/outline-adoption';
import {snapshotJson} from '@camery/methods/json';
import {RequireAccess} from '../policy.js';
import type {AuthRequest} from '../policy.js';
import {ProjectIdentityScopeSchema} from './contracts.js';
import {ProjectApplicationError} from './intent-contracts.js';
import {captureOutlineIntent} from './outline-intent-data.js';
import {OutlineAdoptionApplication} from './outline-adoption-application.js';
import type {OutlineAdoptionOptions} from './outline-adoption-options.js';
import {OUTLINE_ADOPTION_RESPONSE_BYTES} from './outline-adoption-projection.js';
const APPLICATION=Symbol('camery.outline.adoption');
const id=ProjectIdentityScopeSchema.shape.projectId,stable=StableId.refine(value=>value.length===26);
const parse=<S extends z.ZodType>(schema:S,input:unknown)=>captureOutlineIntent(schema,input,'outline adoption HTTP',16384);
function query<S extends z.ZodType>(schema:S,input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ProjectApplicationError('INVALID_INPUT','outline HTTP query');
  const record:Record<string,unknown>=Object.create(null);for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))){if(!descriptor.enumerable||!('value' in descriptor))throw new ProjectApplicationError('INVALID_INPUT','outline HTTP query');record[key]=descriptor.value;}return parse(schema,record);
}
function idempotency(request:AuthRequest,applicationId?:string):string{
  const count=request.raw.rawHeaders.filter((name,index)=>index%2===0&&name.toLowerCase()==='idempotency-key').length,key=request.headers['idempotency-key'];
  if(count!==1||typeof key!=='string'||!id.safeParse(key).success||applicationId!==undefined&&key!==applicationId)throw new ProjectApplicationError('INVALID_INPUT','outline idempotency key');return key;
}
async function response<S extends z.ZodType>(schema:S,pending:Promise<unknown>,request:AuthRequest){const value=await pending;try{const result={data:schema.parse(snapshotJson(value,OUTLINE_ADOPTION_RESPONSE_BYTES,65536)),requestId:request.id};snapshotJson(result,OUTLINE_ADOPTION_RESPONSE_BYTES,65536);return result;}catch{throw new ProjectApplicationError('STORAGE_FAILED','outline HTTP response');}}
@Controller('api/v1/projects/:projectId')
class OutlineAdoptionController{
  constructor(@Inject(APPLICATION) private readonly application:OutlineAdoptionApplication){}
  @Post('outline/:runId/candidates') @RequireAccess('candidate:write')
  prepare(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string,@Body() body:unknown){const command=parse(OutlinePrepareCommandSchema,body);idempotency(request,command.applicationId);return response(OutlineCandidateSchema,this.application.prepareOutline({subject:request.principal,projectId,runId:parse(id,runId),command}),request);}
  @Get('outline-adoption/candidates') @RequireAccess('project:read')
  list(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Query() input:unknown){return response(OutlineCandidatePageSchema,this.application.listCandidates({subject:request.principal,projectId,command:query(OutlineCandidateListQuerySchema,input)}),request);}
  @Get('outline-adoption/candidates/:candidateId') @RequireAccess('project:read')
  candidate(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('candidateId') candidateId:string,@Query() input:unknown){query(schemas.strictObject({}),input);return response(OutlineCandidateSchema,this.application.candidate({subject:request.principal,projectId,candidateId:parse(stable,candidateId)}),request);}
  @Post('outline-adoption/candidates/:candidateId/adopt') @RequireAccess('candidate:review')
  adopt(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('candidateId') candidateId:string,@Body() body:unknown){return response(OutlineReceiptSchema,this.application.adoptCandidate({subject:request.principal,projectId,candidateId:parse(stable,candidateId),requestId:idempotency(request),command:parse(OutlineAdoptCommandSchema,body)}),request);}
  @Post('outline-adoption/candidates/:candidateId/reject') @RequireAccess('candidate:review')
  reject(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('candidateId') candidateId:string,@Body() body:unknown){return response(OutlineReceiptSchema,this.application.rejectCandidate({subject:request.principal,projectId,candidateId:parse(stable,candidateId),requestId:idempotency(request),command:parse(OutlineRejectCommandSchema,body)}),request);}
  @Get('outline-adoption/candidates/:candidateId/receipts') @RequireAccess('project:read')
  receipts(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('candidateId') candidateId:string,@Query() input:unknown){return response(OutlineReceiptPageSchema,this.application.receiptMessages({subject:request.principal,projectId,candidateId:parse(stable,candidateId),command:query(OutlineReceiptQuerySchema,input)}),request);}
}
@Module({})
export class OutlineAdoptionModule{
  static register(options:OutlineAdoptionOptions):DynamicModule{return {module:OutlineAdoptionModule,controllers:[OutlineAdoptionController],providers:[{provide:APPLICATION,useValue:new OutlineAdoptionApplication(options)}]};}
}
