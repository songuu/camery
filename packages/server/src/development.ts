import {Body,Controller,Get,Post,Param,Query,Req,Inject,Module} from '@nestjs/common';
import type {DynamicModule} from '@nestjs/common';
import {z} from 'zod';
import {authorize} from '@camery/access';
import {DevelopmentError} from '@camery/script';
import type {DevelopmentReviewHost} from '@camery/script';
import {Id,Stage} from '@camery/script/contracts';
import {boundedDevelopmentSchema,DevelopmentBriefWriteSchema,DevelopmentBriefListQuerySchema,DevelopmentStartSchema,DevelopmentListQuerySchema,DevelopmentReadBriefQuerySchema,DevelopmentFoundationConfirmSchema,DevelopmentEpisodesConfirmSchema,DevelopmentRejectSchema,DevelopmentRedoSchema} from '@camery/script/http';
import {developmentStageTaskId,enqueueNextDevelopmentTask,projectDevelopmentBrief,projectDevelopmentRun,projectDevelopmentStatus,RunKeySchema,inspectDevelopmentRedo,startDevelopmentRedo} from '@camery/script/node';
import type {DevelopmentRunKey} from '@camery/script/node';
import {RequireAccess} from './policy.js';
import type {AuthRequest} from './policy.js';
import type {DevelopmentApiOptions} from './development-options.js';
const OPTIONS=Symbol('camery.development');
function parse<T>(schema:z.ZodType<T>,input:unknown):T{
  const result=boundedDevelopmentSchema(schema).safeParse(input);if(!result.success)throw new DevelopmentError('INVALID_INPUT','HTTP request');return result.data;
}
function query<T>(schema:z.ZodType<T>,input:unknown):T{
  // Fastify's query parser uses a non-plain empty prototype. Capture only its own data properties, never relax the shared JSON boundary.
  if(!input||typeof input!=='object'||Array.isArray(input))throw new DevelopmentError('INVALID_INPUT','HTTP query');
  const descriptors=Object.getOwnPropertyDescriptors(input);const data:Record<string,unknown>=Object.create(null);
  for(const [name,descriptor] of Object.entries(descriptors)){
    if(!('value' in descriptor)||!descriptor.enumerable)throw new DevelopmentError('INVALID_INPUT','HTTP query');
    data[name]=descriptor.value;
  }
  return parse(schema,data);
}
function key(request:AuthRequest,projectId:string,runId:string){return parse(RunKeySchema,{tenantId:request.principal.tenantId,projectId,runId});}
@Controller('api/v1/projects/:projectId/development')
class DevelopmentController{
  constructor(@Inject(OPTIONS) private readonly options:DevelopmentApiOptions){}
  @Get('capabilities') @RequireAccess('project:read')
  capabilities(@Param('projectId') projectId:string){
    const preset=this.options.presetFor(projectId);return {canStart:!!preset,modelLabel:preset?.label??null,defaultEpisodeCount:10,formalAdoption:!!this.options.formalAdoption,
      budget:preset?{currency:preset.execution.currency,tokens:preset.execution.limits.tokens,costMicros:preset.execution.limits.costMicros}:null};
  }
  @Get() @RequireAccess('project:read')
  list(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Query() input:unknown){
    return this.options.catalog.list({tenantId:request.principal.tenantId,projectId,...query(DevelopmentListQuerySchema,input)});
  }
  @Post('briefs') @RequireAccess('task:run')
  async putBrief(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Body() body:unknown){
    const command=parse(DevelopmentBriefWriteSchema,body);
    return projectDevelopmentBrief(await this.options.store.putBrief({...command,tenantId:request.principal.tenantId,projectId,actorId:request.principal.userId}));
  }
  @Get('briefs') @RequireAccess('project:read')
  listBriefs(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Query() input:unknown){
    return this.options.briefs.list({tenantId:request.principal.tenantId,projectId,...query(DevelopmentBriefListQuerySchema,input)});
  }
  @Get('briefs/:briefId') @RequireAccess('project:read')
  async getBrief(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('briefId') briefId:string,@Query() input:unknown){
    return projectDevelopmentBrief(await this.options.store.getBrief({tenantId:request.principal.tenantId,projectId,briefId:parse(Id,briefId),...query(DevelopmentReadBriefQuerySchema,input)}));
  }
  @Post() @RequireAccess('task:run')
  async start(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Body() body:unknown){
    const command=parse(DevelopmentStartSchema,body);const preset=this.options.presetFor(projectId);
    if(!preset)throw new DevelopmentError('INCOMPLETE','text model unavailable');
    const runKey=key(request,projectId,command.runId);
    await this.options.store.start({...runKey,...command,methods:preset.methods,execution:preset.execution});
    await enqueueNextDevelopmentTask(this.options.store,this.options.tasks,runKey);return this.read(runKey,false);
  }
  private async read(runKey:DevelopmentRunKey,detail:boolean){
    // A new task depends on an already committed append-only review. Read task headers first so a concurrent confirmation cannot pair it with an older audit snapshot.
    const [foundation,episodes]=await Promise.all([
      this.options.tasks.get({tenantId:runKey.tenantId,taskId:developmentStageTaskId(runKey,'foundation')}),
      this.options.tasks.get({tenantId:runKey.tenantId,taskId:developmentStageTaskId(runKey,'episodes')})]);
    const [progress,current]=await Promise.all([this.options.store.read(runKey),this.options.store.isCurrent(runKey)]);
    return detail?projectDevelopmentRun(progress,current,{foundation,episodes}):projectDevelopmentStatus(progress,current,{foundation,episodes});
  }
  @Get(':runId/status') @RequireAccess('project:read')
  status(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string){return this.read(key(request,projectId,runId),false);}
  @Get(':runId/redo') @RequireAccess('project:read')
  redoOptions(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string){return inspectDevelopmentRedo(this.options,key(request,projectId,runId),this.options.presetFor(projectId));}
  @Post(':runId/redo/:stage') @RequireAccess('task:run')
  async redo(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string,@Param('stage') value:string,@Body() body:unknown){
    const stage=parse(Stage,value);const command=parse(DevelopmentRedoSchema,body);const preset=this.options.presetFor(projectId);
    if(!preset)throw new DevelopmentError('INCOMPLETE','text model unavailable');
    const run=await startDevelopmentRedo(this.options,{source:key(request,projectId,runId),stage,command,actorId:request.principal.userId,preset});
    return this.read(key(request,projectId,run.runId),true);
  }
  @Get(':runId') @RequireAccess('project:read')
  detail(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string){return this.read(key(request,projectId,runId),true);}
  private host(request:AuthRequest,projectId:string):DevelopmentReviewHost{
    const principal=request.principal;return {tenantId:principal.tenantId,projectId,actor:{kind:'human',id:principal.userId},at:this.options.now?.()??new Date().toISOString(),
      authorize:input=>{if(input.actorId!==principal.userId||input.brief.tenantId!==principal.tenantId||input.brief.projectId!==projectId)return false;authorize(principal,principal.tenantId,projectId,'candidate:review');return true;}};
  }
  @Post(':runId/:stage/confirm') @RequireAccess('candidate:review')
  async confirm(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string,@Param('stage') value:string,@Body() body:unknown){
    const stage=parse(Stage,value);const runKey=key(request,projectId,runId);
    const decision=stage==='foundation'?parse(DevelopmentFoundationConfirmSchema,body):parse(DevelopmentEpisodesConfirmSchema,body);
    await this.options.store.review(runKey,stage,decision,this.host(request,projectId));
    // The authorized run pinned and budgeted both stages; human foundation approval opens its second stage.
    if(stage==='foundation')await enqueueNextDevelopmentTask(this.options.store,this.options.tasks,runKey);
    return this.read(runKey,true);
  }
  @Post(':runId/:stage/reject') @RequireAccess('candidate:review')
  async reject(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string,@Param('stage') value:string,@Body() body:unknown){
    const runKey=key(request,projectId,runId);await this.options.store.reject(runKey,parse(Stage,value),parse(DevelopmentRejectSchema,body).reason,this.host(request,projectId));return this.read(runKey,true);
  }
}
@Module({})
export class DevelopmentModule{
  static register(options:DevelopmentApiOptions):DynamicModule{return {module:DevelopmentModule,controllers:[DevelopmentController],providers:[{provide:OPTIONS,useValue:options}]};}
}
