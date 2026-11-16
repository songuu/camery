import { expect, it } from 'vitest';
import { confirmBible, rejectBibleCandidate } from '../src/confirmation.js';
import { captureSource } from '../src/data.js';
import { reviewFixture } from './review-support.js';
import { createBibleSourcePage, projectBibleRun, projectBibleStatus } from '../src/node/read-model.js';
import type { BibleProgress } from '../src/node/contracts.js';
const fx=reviewFixture();
const progress:BibleProgress={run:{tenantId:'tenant',projectId:'project',runId:'research',source:captureSource(fx.source),plan:fx.plan,method:fx.candidate.method,digest:'0'.repeat(64),createdAt:'2026-11-16T10:00:00.000Z',
  execution:{connectionId:'private-connection',modeDigest:'0'.repeat(64),modelIdentity:'private-model',evidence:'synthetic_replay',modelTier:'economy',currency:'CNY',reservation:{tokens:10,costMicros:0},limits:{steps:10,tokens:100,costMicros:0}}},records:fx.candidate.records,candidate:fx.candidate,review:null};
it('projects only whitelisted candidate and audit fields under the complete response budget',()=>{
  const view=projectBibleRun(progress,true,null);expect(view.state).toBe('ready');expect(view.candidate!.entities).toEqual(fx.candidate.entities);expect(view.candidate).not.toHaveProperty('records');
  expect(JSON.stringify(view)).not.toContain('private-');expect(view.source).not.toHaveProperty('tenantId');expect(view.budget).toEqual({currency:'CNY',tokens:100,costMicros:0});
  const confirmed=projectBibleRun({...progress,review:confirmBible(fx.source,fx.candidate,fx.decision,fx.host)},false,null);expect(confirmed).toMatchObject({state:'confirmed',current:false,sourceChanged:true,review:{decision:fx.decision,reason:null}});
  const rejected=projectBibleRun({...progress,review:rejectBibleCandidate(fx.source,fx.candidate,'重新研究',fx.host)},false,null);expect(rejected).toMatchObject({state:'rejected',review:{decision:null,reason:'重新研究'}});
});
it('keeps unknown external results visible and treats succeeded/blocked as a business stop',()=>{
  const summary=projectBibleRun({...progress,candidate:null,records:[]},false,null);
  const task=(status:string,output:unknown=null)=>({status,output}) as never;
  expect(projectBibleStatus(summary,task('reconciling')).state).toBe('reconciling');expect(projectBibleStatus(summary,task('succeeded',{state:'blocked',reason:'BUDGET_EXHAUSTED',secret:'private'}))).toMatchObject({state:'stale',task:{resultState:'blocked',reason:'BUDGET_EXHAUSTED'}});
  const current={...summary,sourceChanged:false};expect(projectBibleStatus(current,task('succeeded',{state:'blocked',reason:'BUDGET_EXHAUSTED'})).state).toBe('blocked');
  expect(projectBibleStatus(current,null).state).toBe('queued');for(const status of ['queued','running','waiting','failed','cancelled'])expect(projectBibleStatus(current,task(status)).state).toBe(status);
  expect(projectBibleStatus(current,task('succeeded',{state:'candidate'})).state).toBe('queued');
});
it('reads exact pinned source with bounded pages, even when the run is stale',()=>{
  const page=createBibleSourcePage(progress,{offset:3,limit:10});expect(page.title).toBe('提取时原文');expect(page.excerpt.text).toBe(fx.source.document.text.slice(3,13));expect(page.checkpoint).toBeNull();
  expect(()=>createBibleSourcePage(progress,{offset:0,before:10})).toThrow();expect(createBibleSourcePage(progress).excerpt.text).toBe(fx.source.document.text);
});
it('redacts malformed status and candidate projections, and refuses an oversized combined envelope',()=>{
  const summary=projectBibleRun(progress,true,null);expect(()=>projectBibleStatus(summary,{status:'invalid',output:null} as never)).toThrow('status projection');
  expect(()=>projectBibleRun({...progress,candidate:{...fx.candidate,entities:[{...fx.candidate.entities[0]!,id:'invalid\n'}]}},true,null)).toThrow('run projection');
  const oversized={...fx.candidate,entities:Array.from({length:3000},()=>({...fx.candidate.entities[0]!,description:'甲'.repeat(1000)}))};
  expect(()=>projectBibleRun({...progress,candidate:oversized},true,null)).toThrow('INPUT_LIMIT');
  expect(projectBibleStatus({...summary,candidateDigest:null},{status:'running',output:['private']} as never).task).toEqual({status:'running',resultState:null,reason:null});
  expect(projectBibleStatus({...summary,candidateDigest:null},{status:'succeeded',output:{state:'blocked',reason:'private-url'}} as never).task).toEqual({status:'succeeded',resultState:'blocked',reason:null});
});
