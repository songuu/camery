import {expect,it} from 'vitest';
import type {Task} from '@camery/durable';
import {projectDevelopmentRun,projectDevelopmentStatus,projectDevelopmentBrief} from '../src/node/read-model.js';
import {DEVELOPMENT_STAGE_WORKFLOW,developmentStageTaskId} from '../src/node/contracts.js';
import {workflowFixture} from './workflow-support.js';
import {generateFoundation,generateEpisodes} from '../src/development.js';
import {reviewFoundation,reviewEpisodes,rejectDevelopment} from '../src/review.js';
function task(f:ReturnType<typeof workflowFixture>,status:Task['status']='queued'):Task{
  return {tenantId:f.key.tenantId,taskId:developmentStageTaskId(f.key,'foundation'),workflow:DEVELOPMENT_STAGE_WORKFLOW,version:1,input:{projectId:f.key.projectId,runId:f.key.runId,stage:'foundation',runDigest:f.run.digest,upstreamDigest:null},maxAttempts:3,availableAt:null,status,attempts:1,fence:1,owner:'private-worker',leaseUntil:null,output:null,error:'private provider details'};
}
it('projects only public stored brief and run data without model or task internals',()=>{
  const f=workflowFixture();const view=projectDevelopmentRun(f.progress,true,{foundation:task(f),episodes:null});
  expect(view.state).toBe('queued');expect(view.brief).not.toHaveProperty('tenantId');expect(view).not.toHaveProperty('execution');expect(view.task).toEqual({stage:'foundation',status:'queued',resultState:null,reason:null});
  expect(projectDevelopmentBrief({brief:f.brief,actorId:'author',createdAt:f.run.createdAt})).toMatchObject({actorId:'author',brief:{digest:f.brief.digest}});
});
it('preserves the physical original task state over a stale business snapshot and validates its binding',()=>{
  const f=workflowFixture();expect(projectDevelopmentStatus(f.progress,false,{foundation:task(f,'reconciling'),episodes:null})).toMatchObject({state:'reconciling',sourceChanged:true});
  expect(projectDevelopmentStatus(f.progress,false,{foundation:null,episodes:null}).state).toBe('stale');
  const other=task(f);other.tenantId='other';expect(()=>projectDevelopmentRun(f.progress,true,{foundation:other,episodes:null})).toThrow('STORAGE_FAILED');
  other.tenantId=f.key.tenantId;other.input={};expect(()=>projectDevelopmentRun(f.progress,true,{foundation:other,episodes:null})).toThrow('STORAGE_FAILED');
});
it('redacts failed and blocked task diagnostics and refuses invalid storage projections',()=>{
  const f=workflowFixture();const blocked=task(f,'succeeded');blocked.output={state:'blocked',reason:'private credential: secret'};
  expect(projectDevelopmentStatus(f.progress,true,{foundation:blocked,episodes:null})).toMatchObject({state:'blocked',task:{reason:null}});
  blocked.output={state:'blocked',reason:'BUDGET_EXCEEDED'};expect(projectDevelopmentRun(f.progress,true,{foundation:blocked,episodes:null}).task?.reason).toBe('BUDGET_EXCEEDED');
  expect(projectDevelopmentStatus(f.progress,true,{foundation:task(f,'failed'),episodes:null}).state).toBe('failed');
  expect(()=>projectDevelopmentBrief({brief:f.brief,actorId:'bad actor',createdAt:'bad'})).toThrow('STORAGE_FAILED');
});
it('shows the two original candidates separately from human edits and final review after a restart read',async()=>{
  const f=workflowFixture();const candidate=await generateFoundation({...f,method:f.foundationMethod,context:f.context('view-foundation')});Object.assign(f.progress.foundation,{candidate});
  const empty={foundation:null,episodes:null};expect(projectDevelopmentStatus(f.progress,true,empty).state).toBe('awaiting_review');
  const review=reviewFoundation(f.brief,candidate,{candidateDigest:candidate.digest,output:{...candidate.output,title:'人工设定'}},f.host);Object.assign(f.progress.foundation,{review});
  expect(projectDevelopmentStatus(f.progress,true,empty)).toMatchObject({stage:'episodes',state:'queued'});
  const episodes=await generateEpisodes({...f,foundation:review,method:f.episodeMethod,context:f.context('view-episodes')});Object.assign(f.progress.episodes,{candidate:episodes});
  const edited=structuredClone(episodes.output);edited.episodes[0]!.title='人工第一集';const final=reviewEpisodes(f.brief,review,episodes,{candidateDigest:episodes.digest,output:edited},f.host);Object.assign(f.progress.episodes,{review:final});
  const view=projectDevelopmentRun(JSON.parse(JSON.stringify(f.progress)),true,empty);expect(view.state).toBe('reviewed');expect(view.foundation.candidate!.output.title).toBe(candidate.output.title);
  expect(view.foundation.review).toMatchObject({status:'reviewed',output:{title:'人工设定'}});expect(view.episodes.review).toMatchObject({status:'reviewed',output:{episodes:[expect.objectContaining({title:'人工第一集'}),...edited.episodes.slice(1)]}});
  Object.assign(f.progress.episodes,{review:rejectDevelopment(f.brief,episodes,'重新梳理分集。',f.host,review)});expect(projectDevelopmentRun(f.progress,true,empty).episodes.review).toMatchObject({status:'rejected',reason:'重新梳理分集。'});
  Object.assign(f.progress.episodes,{candidate:null,review:null});Object.assign(f.progress.foundation,{review:rejectDevelopment(f.brief,candidate,'重做设定。',f.host)});expect(projectDevelopmentStatus(f.progress,true,empty).state).toBe('rejected');
});
it('rejects succeeded tasks missing their result and foreign workflow bindings instead of inventing a completed stage',()=>{
  const f=workflowFixture();const completed=task(f,'succeeded');expect(()=>projectDevelopmentStatus(f.progress,true,{foundation:completed,episodes:null})).toThrow('STORAGE_FAILED');
  for(const change of [{version:2},{workflow:'foreign'},{taskId:'foreign'}])expect(()=>projectDevelopmentStatus(f.progress,true,{foundation:{...task(f),...change},episodes:null})).toThrow('STORAGE_FAILED');
  expect(projectDevelopmentStatus(f.progress,true,{foundation:task(f,'cancelled'),episodes:null}).state).toBe('cancelled');
  expect(()=>projectDevelopmentStatus(f.progress,true,{foundation:null,episodes:task(f)})).toThrow('STORAGE_FAILED');
});
