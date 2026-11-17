import {afterEach,expect,it,vi} from 'vitest';
import type {Role,SessionIdentity,SessionStore} from '@camery/access';
import type {Task} from '@camery/durable';
import {MethodRunner,createStructuredGenerationExecutor} from '@camery/methods';
import {generateFoundation} from '@camery/script';
import {DevelopmentError} from '@camery/script';
import {reviewFoundation} from '@camery/script';
import {developmentStageCallId,developmentStageTaskId,DEVELOPMENT_STAGE_WORKFLOW} from '@camery/script/node';
import type {DevelopmentPreset} from '../src/development-options.js';
import {workflowFixture} from '../../script/test/workflow-support.js';
import {createApplication} from '../src/app.js';
const headers={authorization:`Bearer cmry_${'b'.repeat(43)}`};const base='/api/v1/projects/project/development';
const apps:Awaited<ReturnType<typeof createApplication>>[]=[];
async function fixture(role:Role='admin',ready=false){
  const f=workflowFixture();if(ready){const model=await f.sessionFor();const runner=new MethodRunner(f.methods,[createStructuredGenerationExecutor(model)]);Object.assign(f.progress.foundation,{candidate:await generateFoundation({...f,runner,method:f.foundationMethod,context:f.context(developmentStageCallId(f.key,'foundation'))})});}
  const saved=new Map<string,Task>();const tasks={get:vi.fn(async key=>saved.get(key.taskId)??null),enqueue:vi.fn(async input=>{const task={...input,status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null} as Task;saved.set(input.taskId,task);return task;})};
  const catalog={list:vi.fn(async()=>({items:[],nextCursor:null})),summary:vi.fn()};const presetFor=vi.fn<()=>DevelopmentPreset|null>(()=>({methods:f.run.methods,execution:f.run.execution,label:'测试原创模型'}));
  const sessions={lookup:vi.fn(async()=>({tenantId:f.key.tenantId,userId:'http-human',sessionId:'s',grants:[{projectId:f.key.projectId,role}]} as SessionIdentity|null)),revoke:vi.fn(async()=>{})} satisfies SessionStore;
  const briefs={list:vi.fn(async()=>({items:[],nextCursor:null}))};const app=await createApplication({tenantId:f.key.tenantId,store:sessions,development:{store:f.store,catalog,briefs,tasks,presetFor,now:()=>f.host.at}});apps.push(app);return {app,...f,catalog,briefs,tasks,presetFor,sessions,saved};
}
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
it('authenticates before touching development records, rejects cross-project scope and observes revocation',async()=>{
  const f=await fixture();expect((await f.app.inject({url:base})).statusCode).toBe(401);expect(f.catalog.list).not.toHaveBeenCalled();
  expect((await f.app.inject({url:base.replace('/project/','/other/'),headers})).statusCode).toBe(403);
  expect((await f.app.inject({url:base+'?tenantId=other',headers})).statusCode).toBe(400);
  expect((await f.app.inject({url:base,headers})).statusCode).toBe(200);f.sessions.lookup.mockResolvedValue(null);expect((await f.app.inject({url:base,headers})).statusCode).toBe(401);
});
it('writes briefs from authenticated scope without a model and rejects client identity injection',async()=>{
  const f=await fixture('editor');f.presetFor.mockReturnValue(null);const {briefId,idea,episodeCount,targetSeconds}=f.brief;const body={briefId,idea,episodeCount,targetSeconds,expectedRevision:0};
  const response=await f.app.inject({method:'POST',url:base+'/briefs',headers,payload:body});expect(response.statusCode).toBe(201);expect(response.json().brief).not.toHaveProperty('tenantId');
  expect(f.store.putBrief).toHaveBeenCalledWith({...body,tenantId:f.key.tenantId,projectId:'project',actorId:'http-human'});expect(f.tasks.enqueue).not.toHaveBeenCalled();
  expect((await f.app.inject({method:'POST',url:base+'/briefs',headers,payload:{...body,actorId:'client'}})).statusCode).toBe(400);
  const read=await f.app.inject({url:base+'/briefs/'+briefId+'?revision=1',headers});expect(read.statusCode,read.body).toBe(200);expect(f.store.getBrief).toHaveBeenCalledWith({tenantId:f.key.tenantId,projectId:'project',briefId,revision:1});
});
it.each(['viewer','reviewer'] as const)('prevents %s writes and new paid runs before reading host presets',async role=>{
  const f=await fixture(role);expect((await f.app.inject({method:'POST',url:base+'/briefs',headers,payload:{}})).statusCode).toBe(403);
  expect((await f.app.inject({method:'POST',url:base,headers,payload:{}})).statusCode).toBe(403);expect(f.store.start).not.toHaveBeenCalled();expect(f.presetFor).not.toHaveBeenCalled();
});
it('starts the pinned two-stage plan and only queues references, rejecting model/method overrides',async()=>{
  const f=await fixture('editor');const body={runId:f.key.runId,briefId:f.brief.briefId,expectedRevision:1,expectedBriefDigest:f.brief.digest};
  const result=await f.app.inject({method:'POST',url:base,headers,payload:body});expect(result.statusCode).toBe(201);expect(result.json().state).toBe('queued');
  expect(f.store.start).toHaveBeenCalledWith({...f.key,...body,methods:f.run.methods,execution:f.run.execution});expect(f.tasks.enqueue.mock.calls[0]![0].input).not.toHaveProperty('idea');
  expect((await f.app.inject({method:'POST',url:base,headers,payload:{...body,execution:{}}})).statusCode).toBe(400);
});
it('keeps GET status/detail read-only and redacts model evidence and execution configuration',async()=>{
  const f=await fixture('viewer',true);const response=await f.app.inject({url:base+'/'+f.key.runId,headers});expect(response.statusCode).toBe(200);
  const data=response.json();expect(data.state).toBe('awaiting_review');expect(data.foundation.candidate.output.title).toBeTruthy();expect(data.foundation.candidate).not.toHaveProperty('model');expect(data).not.toHaveProperty('execution');
  expect((await f.app.inject({url:base+'/'+f.key.runId+'/status',headers})).headers['cache-control']).toBe('no-store');expect(f.tasks.enqueue).not.toHaveBeenCalled();expect(f.exchange).toHaveBeenCalledOnce();
});
it('captures the authenticated reviewer, preserves edits and dispatches episodes only after explicit approval',async()=>{
  const f=await fixture('reviewer',true);const candidate=f.progress.foundation.candidate!;const edited={...candidate.output,title:'人工编辑设定'};
  const response=await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/foundation/confirm',headers,payload:{candidateDigest:candidate.digest,output:edited}});expect(response.statusCode,response.body).toBe(201);
  expect(response.json().foundation.review).toMatchObject({status:'reviewed',actorId:'http-human',output:{title:'人工编辑设定'}});expect(candidate.output.title).not.toBe(edited.title);
  expect(f.tasks.enqueue.mock.calls[0]![0].input).toMatchObject({stage:'episodes',upstreamDigest:f.progress.foundation.review!.digest});expect(f.exchange).toHaveBeenCalledTimes(1);
});
it('denies an editor review, rejects invalid stages and refuses injected authorization',async()=>{
  const f=await fixture('editor',true);expect((await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/foundation/confirm',headers,payload:{}})).statusCode).toBe(403);expect(f.store.review).not.toHaveBeenCalled();
  const reviewer=await fixture('reviewer',true);expect((await reviewer.app.inject({method:'POST',url:base+'/'+f.key.runId+'/bad/confirm',headers,payload:{}})).statusCode).toBe(400);
  const c=reviewer.progress.foundation.candidate!;expect((await reviewer.app.inject({method:'POST',url:base+'/'+f.key.runId+'/foundation/confirm',headers,payload:{candidateDigest:c.digest,output:c.output,authorize:true}})).statusCode).toBe(400);
});
it('reads capabilities, list filters and optional brief revision without enabling unavailable text generation',async()=>{
  const f=await fixture('editor');expect((await f.app.inject({url:base+'/capabilities',headers})).json()).toMatchObject({canStart:true,defaultEpisodeCount:10,modelLabel:'测试原创模型'});
  f.presetFor.mockReturnValue(null);expect((await f.app.inject({url:base+'/capabilities',headers})).json()).toEqual({canStart:false,defaultEpisodeCount:10,modelLabel:null,budget:null});
  expect((await f.app.inject({url:base+'?cursor=abc&briefId=idea',headers})).statusCode).toBe(200);expect(f.catalog.list).toHaveBeenLastCalledWith({tenantId:'tenant',projectId:'project',cursor:'abc',briefId:'idea'});
  expect((await f.app.inject({url:base+'?cursor=a&cursor=b',headers})).statusCode).toBe(400);
  expect((await f.app.inject({url:base+'/briefs?cursor=abc',headers})).statusCode).toBe(200);expect(f.briefs.list).toHaveBeenCalledWith({tenantId:'tenant',projectId:'project',cursor:'abc'});
  expect((await f.app.inject({url:base+'/briefs/idea',headers})).statusCode).toBe(200);expect((await f.app.inject({url:base+'/briefs/idea?revision=0',headers})).statusCode).toBe(400);
  const body={runId:'new',briefId:f.brief.briefId,expectedRevision:1,expectedBriefDigest:f.brief.digest};expect((await f.app.inject({method:'POST',url:base,headers,payload:body})).statusCode).toBe(409);expect(f.store.start).not.toHaveBeenCalled();
});
it('saves explicit rejection without enqueueing and refuses empty reasons or oversized review bodies',async()=>{
  const f=await fixture('reviewer',true);const response=await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/foundation/reject',headers,payload:{reason:'需要重新开发人物动机。'}});
  expect(response.statusCode,response.body).toBe(201);expect(response.json().foundation.review).toMatchObject({status:'rejected',actorId:'http-human',reason:'需要重新开发人物动机。'});expect(f.tasks.enqueue).not.toHaveBeenCalled();
  expect((await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/episodes/reject',headers,payload:{reason:''}})).statusCode).toBe(400);
  expect((await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/foundation/confirm',headers,payload:{output:'x'.repeat(524289)}})).statusCode).toBe(413);
});
it.each([['NOT_FOUND',404],['CONFLICT',409],['INVALID_REFERENCE',422],['STORAGE_FAILED',503]] as const)('maps %s safely without exposing driver or provider details',async(code,status)=>{
  const f=await fixture();vi.mocked(f.store.read).mockRejectedValue(new DevelopmentError(code,'private database credential'));
  const response=await f.app.inject({url:base+'/'+f.key.runId,headers});expect(response.statusCode).toBe(status);expect(response.body).not.toContain('credential');expect(response.json().code).toBe(code);
});
it('reads the monotonic audit after task headers when confirmation and polling overlap',async()=>{
  const f=await fixture('viewer',true);const candidate=f.progress.foundation.candidate!;const review=reviewFoundation(f.brief,candidate,{candidateDigest:candidate.digest,output:candidate.output},f.host);
  vi.mocked(f.store.read).mockImplementation(async()=>structuredClone(f.progress));
  f.tasks.get.mockImplementation(async identity=>{await Promise.resolve();if(identity.taskId!==developmentStageTaskId(f.key,'episodes'))return null;
    Object.assign(f.progress.foundation,{review});return {tenantId:f.key.tenantId,taskId:identity.taskId,workflow:DEVELOPMENT_STAGE_WORKFLOW,version:1,maxAttempts:3,availableAt:null,status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null,input:{projectId:f.key.projectId,runId:f.key.runId,stage:'episodes',runDigest:f.run.digest,upstreamDigest:review.digest}};
  });
  const response=await f.app.inject({url:base+'/'+f.key.runId,headers});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({stage:'episodes',state:'queued',foundationReviewStatus:'reviewed'});
});
