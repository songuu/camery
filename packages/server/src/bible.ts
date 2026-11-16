import { Body, Controller, Get, Post, Param, Query, Req, Inject, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@camery/access';
import { BibleError, type ReviewHost } from '@camery/bible';
import { BibleStartSchema, BibleListQuerySchema, BibleConfirmSchema, BibleRejectSchema, boundedBibleSchema } from '@camery/bible/http';
import { bibleChunkTaskId, enqueueNextBibleTask, projectBibleStatus, projectBibleRun, createBibleSourcePage } from '@camery/bible/node';
import { z } from 'zod';
import type { BibleApiOptions } from './bible-options.js';
import { RequireAccess, type AuthRequest } from './policy.js';

const OPTIONS=Symbol('camery.bible');
function parse<T>(schema:z.ZodType<T>,input:unknown):T {
  const result=boundedBibleSchema(schema).safeParse(input);
  if(!result.success)throw new BibleError('INVALID_INPUT','HTTP request');
  return result.data;
}
function key(request:AuthRequest,projectId:string,runId:string){return {tenantId:request.principal.tenantId,projectId,runId};}

@Controller('api/v1/projects/:projectId/bibles')
class BibleController {
  constructor(@Inject(OPTIONS) private readonly options:BibleApiOptions){}
  @Get('capabilities') @RequireAccess('project:read')
  capabilities(@Param('projectId') projectId:string){
    const preset=this.options.presetFor(projectId);
    return {canStart:!!preset,modelLabel:preset?.label??null,budget:preset?{currency:preset.execution.currency,tokens:preset.execution.limits.tokens,costMicros:preset.execution.limits.costMicros}:null};
  }
  @Get() @RequireAccess('project:read')
  list(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Query() query:unknown){
    const command=parse(BibleListQuerySchema,query);
    return this.options.catalog.list({tenantId:request.principal.tenantId,projectId,...(command.cursor!==undefined?{cursor:command.cursor}:{}),...(command.documentId!==undefined?{documentId:command.documentId}:{}),...(command.kind!==undefined?{kind:command.kind}:{})});
  }
  @Post() @RequireAccess('task:run')
  async start(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Body() body:unknown){
    const command=parse(BibleStartSchema,body);
    const preset=this.options.presetFor(projectId);
    if(!preset)throw new BibleError('MODEL_FAILED','text model unavailable');
    const scope={tenantId:request.principal.tenantId,projectId};
    await this.options.store.start({...scope,...command,method:preset.method,execution:preset.execution});
    const runKey={...scope,runId:command.runId};
    await enqueueNextBibleTask(this.options.store,this.options.tasks,runKey);
    return this.readStatus(runKey);
  }
  private async readStatus(runKey:ReturnType<typeof key>){
    const metadata=await this.options.catalog.summary(runKey);
    const task=metadata.nextChunkId?await this.options.tasks.get({tenantId:runKey.tenantId,taskId:bibleChunkTaskId(runKey,metadata.nextChunkId)}):null;
    return projectBibleStatus(metadata.summary,task);
  }
  @Get(':runId/status') @RequireAccess('project:read')
  status(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string){return this.readStatus(key(request,projectId,runId));}
  @Get(':runId') @RequireAccess('project:read')
  async detail(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string){
    const runKey=key(request,projectId,runId);
    const progress=await this.options.store.read(runKey);
    const current=await this.options.store.isCurrent(runKey);
    const missing=progress.run.plan.chunks.find(chunk=>!progress.records.some(record=>record.chunkId===chunk.id));
    const task=missing?await this.options.tasks.get({tenantId:runKey.tenantId,taskId:bibleChunkTaskId(runKey,missing.id)}):null;
    return projectBibleRun(progress,current,task);
  }
  @Get(':runId/source') @RequireAccess('project:read')
  async source(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string,@Query() query:unknown){
    return createBibleSourcePage(await this.options.store.read(key(request,projectId,runId)),query);
  }
  private host(request:AuthRequest,projectId:string):ReviewHost {
    const principal=request.principal;
    return {actor:{kind:'human',id:principal.userId},tenantId:principal.tenantId,projectId,at:this.options.now?.()??new Date().toISOString(),
      authorize:input=>{
        if(input.actorId!==principal.userId||input.source.tenantId!==principal.tenantId||input.source.projectId!==projectId)return false;
        authorize(principal,principal.tenantId,projectId,'candidate:review');return true;
      }};
  }
  @Post(':runId/confirm') @RequireAccess('candidate:review')
  async confirm(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string,@Body() body:unknown){
    await this.options.store.confirm(key(request,projectId,runId),parse(BibleConfirmSchema,body),this.host(request,projectId));
    return this.detail(request,projectId,runId);
  }
  @Post(':runId/reject') @RequireAccess('candidate:review')
  async reject(@Req() request:AuthRequest,@Param('projectId') projectId:string,@Param('runId') runId:string,@Body() body:unknown){
    await this.options.store.reject(key(request,projectId,runId),parse(BibleRejectSchema,body).reason,this.host(request,projectId));
    return this.detail(request,projectId,runId);
  }
}
@Module({})
export class BibleModule {
  static register(options:BibleApiOptions):DynamicModule{return {module:BibleModule,controllers:[BibleController],providers:[{provide:OPTIONS,useValue:options}]};}
}
