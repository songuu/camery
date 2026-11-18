import { Body,Controller,Get,Post,Param,Query,Req,Inject,Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { z } from 'zod';
import { authorize } from '@camery/access';
import { Id } from '@camery/script/contracts';
import { OutlineError } from '@camery/script/outline/contracts';
import type { OutlineReviewHost } from '@camery/script/outline/contracts';
import { OutlineBriefWriteSchema,OutlineBriefListQuerySchema,OutlineReadBriefQuerySchema,OutlineSourceListQuerySchema,OutlineStartSchema,OutlineListQuerySchema,OutlineConfirmSchema,OutlineRejectSchema,OutlineCapabilitiesSchema } from '@camery/script/outline/http';
import { OutlineKeySchema,outlineTaskId,enqueueOutlineTask,captureOutlineProgress,projectOutlineBrief,projectOutlineStatus,projectOutlineRun } from '@camery/script/outline/node';
import type { OutlineRunKey,OutlineExecution } from '@camery/script/outline/node';
import { RequireAccess } from './policy.js';
import type { AuthRequest } from './policy.js';
import type { OutlineApiOptions } from './outline-options.js';

const OPTIONS=Symbol('camery.outline');
function parse<T>(schema:z.ZodType<T>,input:unknown):T{
  const result=schema.safeParse(input);if(!result.success)throw new OutlineError('INVALID_INPUT','HTTP request','request');return result.data;
}
function query<T>(schema:z.ZodType<T>,input:unknown):T{
  // Normalize only Fastify's own data fields; nested input still passes the shared strict JSON snapshot.
  if(!input||typeof input!=='object'||Array.isArray(input))throw new OutlineError('INVALID_INPUT','HTTP query','query');
  const data:Record<string,unknown>=Object.create(null);
  for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))){
    if(!('value' in descriptor)||!descriptor.enumerable)throw new OutlineError('INVALID_INPUT','HTTP query','query');data[name]=descriptor.value;
  }
  return parse(schema,data);
}
function key(request:AuthRequest,projectId:string,runId:string):OutlineRunKey{return parse(OutlineKeySchema,{tenantId:request.principal.tenantId,projectId,runId});}

@Controller('api/v1/projects/:projectId/outlines')
class OutlineController {
  constructor(@Inject(OPTIONS) private readonly options:OutlineApiOptions){}
  @Get('capabilities') @RequireAccess('project:read')
  capabilities(@Param('projectId') projectId:string){
    const preset=this.options.presetFor(projectId);return OutlineCapabilitiesSchema.parse({canStart:!!preset,modelLabel:preset?.label??null,defaultEpisodeCount:10,formalAdoption:this.options.formalAdoption===true,
      budget:preset?{currency:preset.execution.currency,tokens:preset.execution.reservation.tokens,costMicros:preset.execution.reservation.costMicros}:null});
  }
  @Get() @RequireAccess('project:read')
  list(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Query() input:unknown){return this.options.catalog.list({tenantId:request.principal.tenantId,projectId,...query(OutlineListQuerySchema,input)});}
  @Post('briefs') @RequireAccess('task:run')
  async putBrief(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Body() input:unknown){
    return projectOutlineBrief(await this.options.store.putBrief({...parse(OutlineBriefWriteSchema,input),tenantId:request.principal.tenantId,projectId,actorId:request.principal.userId}));
  }
  @Get('briefs') @RequireAccess('project:read')
  listBriefs(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Query() input:unknown){return this.options.briefs.list({tenantId:request.principal.tenantId,projectId,...query(OutlineBriefListQuerySchema,input)});}
  @Get('briefs/:briefId') @RequireAccess('project:read')
  async getBrief(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('briefId') briefId:string,@Query() input:unknown){
    return projectOutlineBrief(await this.options.store.getBrief({tenantId:request.principal.tenantId,projectId,briefId:parse(Id,briefId),...query(OutlineReadBriefQuerySchema,input)}));
  }
  @Get('sources') @RequireAccess('project:read')
  sources(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Query() input:unknown){return this.options.sources.list({tenantId:request.principal.tenantId,projectId,...query(OutlineSourceListQuerySchema,input)});}
  @Post() @RequireAccess('task:run')
  async start(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Body() input:unknown){
    const command=parse(OutlineStartSchema,input),runKey=key(request,projectId,command.runId);let execution:OutlineExecution|undefined;
    try{execution=captureOutlineProgress(runKey,await this.options.store.read(runKey)).run.execution;}
    catch(error){if(!(error instanceof OutlineError&&error.code==='NOT_FOUND'))throw error;}
    if(!execution){const preset=this.options.presetFor(projectId);if(!preset)throw new OutlineError('INCOMPLETE','text model unavailable','preset');execution=preset.execution;}
    // A retry proves the original request against the immutable store. Current model configuration cannot replace a paid journal's identity.
    await this.options.store.start({...command,...runKey,source:{...command.source,tenantId:runKey.tenantId,projectId},execution});
    await enqueueOutlineTask(this.options.store,this.options.tasks,runKey);return this.read(runKey,false);
  }
  private async read(runKey:OutlineRunKey,detail:boolean){
    // Task finish and the append-only audit are separate commits: observe the physical header before the business snapshot.
    const task=await this.options.tasks.get({tenantId:runKey.tenantId,taskId:outlineTaskId(runKey)});
    const [progress,current]=await Promise.all([this.options.store.read(runKey),this.options.store.isCurrent(runKey)]);
    return detail?projectOutlineRun(progress,current,task):projectOutlineStatus(progress,current,task);
  }
  @Get(':runId/status') @RequireAccess('project:read')
  status(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string){return this.read(key(request,projectId,runId),false);}
  @Get(':runId') @RequireAccess('project:read')
  detail(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string){return this.read(key(request,projectId,runId),true);}
  private host(request:AuthRequest,projectId:string):OutlineReviewHost{
    const principal=request.principal;return {tenantId:principal.tenantId,projectId,actor:{kind:'human',id:principal.userId},at:this.options.now?.()??new Date().toISOString(),
      authorize:input=>{if(input.actorId!==principal.userId||input.brief.tenantId!==principal.tenantId||input.brief.projectId!==projectId)return false;authorize(principal,principal.tenantId,projectId,'candidate:review');return true;}};
  }
  @Post(':runId/confirm') @RequireAccess('candidate:review')
  async confirm(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string,@Body() input:unknown){
    const runKey=key(request,projectId,runId);await this.options.store.review(runKey,parse(OutlineConfirmSchema,input),this.host(request,projectId));return this.read(runKey,true);
  }
  @Post(':runId/reject') @RequireAccess('candidate:review')
  async reject(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string,@Body() input:unknown){
    const runKey=key(request,projectId,runId);await this.options.store.reject(runKey,parse(OutlineRejectSchema,input).reason,this.host(request,projectId));return this.read(runKey,true);
  }
}
@Module({})
export class OutlineModule {
  static register(options:OutlineApiOptions):DynamicModule{return {module:OutlineModule,controllers:[OutlineController],providers:[{provide:OPTIONS,useValue:options}]};}
}
