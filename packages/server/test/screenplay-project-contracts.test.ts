import {expect,it,vi} from 'vitest';
import {fixtureId as id} from '../../ir/test/fixtures';
import {ScreenplayProjectIntentBodySchema,ScreenplayProjectDecisionBodySchema} from '../src/projects/screenplay-intent-contracts.js';
import {captureProjectCommand,projectCommandDigest,projectCommandJson} from '../src/projects/project-command-data.js';
import {screenplayIntentBody} from './fixtures/screenplay-project-intent.js';

it('stores only frozen source references and ordered identities, including a real >1MiB identity journal',()=>{
  const body=screenplayIntentBody();body.ids=Array.from({length:40000},(_,index)=>id('screenplay-slot-'+index));
  expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(1048576);
  const captured=captureProjectCommand(ScreenplayProjectIntentBodySchema,body,'screenplay identity journal',2097152);expect(captured.ids).toHaveLength(40000);expect(Object.isFrozen(captured.ids)).toBe(true);expect(captured.ids[39999]).toBe(body.ids[39999]);
});
it.each(['scope','target','actor','identity','duplicates','changeId','empty','source-text'] as const)('rejects malformed or injected %s before a journal can authorize native work',kind=>{
  const body:Record<string,unknown>=screenplayIntentBody();
  if(kind==='scope')body['sourceKey']={tenantId:'other',projectId:'project',candidateId:'source-candidate'};
  if(kind==='target')body['target']={tenantId:id('formal-tenant'),projectId:'invalid'};
  if(kind==='actor')body['actor']={kind:'agent_run',key:'editor',id:id('editor')};
  if(kind==='identity')body['ids']=['invalid'];if(kind==='duplicates')body['ids']=[id('same'),id('same')];
  if(kind==='changeId')body['ids']=[body['changeId']];if(kind==='empty')body['ids']=[];if(kind==='source-text')body['draft']={text:'must remain in the source store'};
  expect(()=>captureProjectCommand(ScreenplayProjectIntentBodySchema,body,'screenplay journal',2097152)).toThrow(expect.objectContaining({code:'INVALID_INPUT'}));
});
it('keeps command capture detached and rejects accessors, cycles and byte overflow before consulting them',()=>{
  const body=screenplayIntentBody(),captured=captureProjectCommand(ScreenplayProjectIntentBodySchema,body,'screenplay journal',2097152);body.ids[0]=id('later');expect(captured.ids[0]).toBe(id('scene'));
  const getter=vi.fn(),accessor=Object.defineProperty({},'scope',{enumerable:true,get:getter});expect(()=>projectCommandJson(accessor,2097152)).toThrow(expect.objectContaining({code:'INVALID_INPUT'}));expect(getter).not.toHaveBeenCalled();
  const cycle:Record<string,unknown>={};cycle['self']=cycle;expect(()=>projectCommandDigest(cycle,2097152)).toThrow(expect.objectContaining({code:'INVALID_INPUT'}));
  expect(()=>projectCommandJson({text:'x'.repeat(2097152)},2097152)).toThrow(expect.objectContaining({code:'INPUT_LIMIT'}));
  expect(projectCommandDigest({b:[2,1],a:1},2097152)).toBe(projectCommandDigest({a:1,b:[2,1]},2097152));expect(projectCommandDigest({a:[1,2]},2097152)).not.toBe(projectCommandDigest({a:[2,1]},2097152));
});
it('binds immutable decisions to a human and the complete episode with an explicit rejection reason',()=>{
  const base=screenplayIntentBody(),body={version:1,scope:base.scope,requestId:'decision',actor:base.actor,target:base.target,changeId:base.changeId,action:'adopt',adoptionScope:{kind:'episode',id:base.episodeId},expectation:base.expectation,reason:null,at:'2026-11-20T09:00:00.000Z'};
  expect(ScreenplayProjectDecisionBodySchema.safeParse(body).success).toBe(true);
  for(const value of [{...body,adoptionScope:{kind:'project',id:base.target.projectId}},{...body,actor:{...base.actor,kind:'agent_run'}},{...body,action:'reject',reason:null},{...body,action:'adopt',reason:'not a rejection'}])expect(ScreenplayProjectDecisionBodySchema.safeParse(value).success).toBe(false);
  expect(ScreenplayProjectDecisionBodySchema.safeParse({...body,action:'reject',reason:'来源已变更，明确拒绝'}).success).toBe(true);
});
