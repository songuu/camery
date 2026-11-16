import { expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresDevelopmentStore } from '../src/node/store.js';
import { executionForDevelopment,developmentMethodPins,developmentRunDigest,validateDevelopmentRun,developmentStageTaskId } from '../src/node/contracts.js';
import { episodeFixture } from './episode-fixture.js';
import { memoryDatabase } from './store-memory.js';
import { workflowFixture } from './workflow-support.js';
import { generateFoundation,generateEpisodes,createFoundationCandidate } from '../src/development.js';
import { reviewFoundation } from '../src/review.js';
import { developmentStageCallId } from '../src/node/contracts.js';
import { hash } from '../src/data.js';
import type { ReviewedDevelopment } from '../src/contracts.js';
const key={tenantId:'tenant',projectId:'project',runId:'run'};
const execution={connectionId:'fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture/original',evidence:'synthetic_replay',modelTier:'balanced',currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:2,tokens:200,costMicros:0}};
it('checks both stage shares and requires a conservative live cost reservation without inventing provider usage',()=>{
  expect(executionForDevelopment(execution)).toEqual(execution);
  for(const input of [{...execution,limits:{...execution.limits,tokens:199}},{...execution,reservation:{tokens:100,costMicros:1}},{...execution,limits:{...execution.limits,steps:1}},{...execution,modelTier:'economy'},{...execution,evidence:'live_model'}])expect(()=>executionForDevelopment(input)).toThrow();
  expect(()=>executionForDevelopment({...execution,evidence:'live_model',pricing:{inputMicrosPerMillionTokens:0,outputMicrosPerMillionTokens:0}})).not.toThrow();
});
it('validates exact run scope, fixed method pins, canonical time and brief/execution digest',()=>{
  const {brief}=episodeFixture();const fields={...key,brief,methods:developmentMethodPins(),execution:executionForDevelopment(execution)};const run={...fields,digest:developmentRunDigest(fields),createdAt:'2026-11-16T12:00:00.000Z'};
  expect(validateDevelopmentRun(key,run)).toEqual(run);
  for(const change of [{tenantId:'other'},{projectId:'other'},{runId:'other'},{digest:'b'.repeat(64)},{createdAt:'invalid'},{createdAt:'2026-11-16T12:00:00Z'},{methods:{...run.methods,foundation:{...run.methods.foundation,digest:'b'.repeat(64)}}}])expect(()=>validateDevelopmentRun(key,{...run,...change})).toThrow();
});
it('captures public task/call/run digest helper inputs before reading any data property',()=>{
  let invoked=false;const trapped=Object.defineProperty({...key},'tenantId',{enumerable:true,get(){invoked=true;throw new Error('private helper');}});
  for(const operation of [()=>developmentStageTaskId(trapped,'foundation'),()=>developmentStageCallId(trapped,'foundation'),()=>developmentRunDigest(trapped as never),()=>developmentStageCallId(null as never,'foundation'),()=>developmentRunDigest(null as never)])expect(operation).toThrow('INVALID_INPUT');
  expect(invoked).toBe(false);
});
it('rejects invalid store requests before acquiring a connection and redacts connection failures',async()=>{
  const connect=vi.fn(async()=>{throw new Error('private database password');});const query=vi.fn();const store=new PostgresDevelopmentStore({connect,query} as unknown as Pool);
  await expect(store.putBrief({})).rejects.toMatchObject({code:'INVALID_INPUT'});await expect(store.getBrief({tenantId:'bad\n',projectId:'project',briefId:'brief'})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(store.start({})).rejects.toMatchObject({code:'INVALID_INPUT'});await expect(store.read({...key,runId:'bad\n'})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(connect).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
  await expect(store.read(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  try{await store.read(key);}catch(error){expect(String(error)).not.toContain('private');}
});
async function setup(){
  const f=workflowFixture();const db=memoryDatabase();const {version:_version,digest:_digest,revision:_revision,...fields}=f.brief;
  const put={...fields,expectedRevision:0,actorId:'writer'};const saved=await db.store.putBrief(put);const command={...f.key,briefId:f.brief.briefId,expectedRevision:1,expectedBriefDigest:saved.brief.digest,methods:f.run.methods,execution:f.run.execution};
  const run=await db.store.start(command);const context=(stage:'foundation'|'episodes')=>({...f.context('unused'),idempotencyKey:developmentStageCallId(f.key,stage)});
  const candidate=await generateFoundation({brief:run.brief,runner:f.runner,method:run.methods.foundation,context:context('foundation')});
  const decision={candidateDigest:candidate.digest,output:candidate.output};return {...f,...db,run,put,command,context,candidate,decision};
}
it('stores both stages, replays exact writes/reviews and rebuilds independent snapshots',async()=>{
  const f=await setup();expect(await f.store.putBrief(f.put)).toMatchObject({brief:f.run.brief,actorId:'writer'});expect(await f.store.start(f.command)).toEqual(f.run);
  expect((await f.store.getBrief({tenantId:'tenant',projectId:'project',briefId:f.brief.briefId,revision:1})).brief).toEqual(f.run.brief);
  expect(await f.store.saveCandidate(f.key,f.candidate)).toEqual(f.candidate);expect(await f.store.saveCandidate(f.key,f.candidate)).toEqual(f.candidate);
  const reviewed=await f.store.review(f.key,'foundation',f.decision,f.host) as ReviewedDevelopment<'foundation'>;
  expect(await f.store.review(f.key,'foundation',f.decision,{...f.host,at:'2026-11-17T12:00:00.000Z'})).toEqual(reviewed);
  const episodes=await generateEpisodes({brief:f.run.brief,foundation:reviewed,runner:f.runner,method:f.run.methods.episodes,context:f.context('episodes')});
  const output=episodes;expect(output.model.callId).toBe(developmentStageCallId(f.key,'episodes'));
  await f.store.saveCandidate(f.key,output);const decision={candidateDigest:output.digest,output:output.output};
  const review=await f.store.review(f.key,'episodes',decision,f.host);expect((await f.store.read(f.key)).episodes.review).toEqual(review);expect((await f.store.read(f.key)).foundation.review).toEqual(reviewed);expect(await f.store.isCurrent(f.key)).toBe(true);
});
it('distinguishes new stale decisions from authorized semantic retries and keeps historical rejection',async()=>{
  const f=await setup();await f.store.saveCandidate(f.key,f.candidate);const reviewed=await f.store.review(f.key,'foundation',f.decision,f.host);
  const next=await f.store.putBrief({...f.put,expectedRevision:1,idea:'修改后的创意。'});expect(await f.store.isCurrent(f.key)).toBe(false);expect((await f.store.getBrief({tenantId:'tenant',projectId:'project',briefId:f.brief.briefId})).brief).toEqual(next.brief);
  expect(await f.store.start(f.command)).toEqual(f.run);expect(await f.store.putBrief(f.put)).toMatchObject({brief:f.run.brief});expect(await f.store.review(f.key,'foundation',f.decision,f.host)).toEqual(reviewed);
  await expect(f.store.review(f.key,'foundation',f.decision,{...f.host,authorize:()=>false})).rejects.toMatchObject({code:'FORBIDDEN'});
  const fresh=await setup();await fresh.store.saveCandidate(fresh.key,fresh.candidate);await fresh.store.putBrief({...fresh.put,expectedRevision:1,idea:'新版本'});
  await expect(fresh.store.review(fresh.key,'foundation',fresh.decision,fresh.host)).rejects.toMatchObject({code:'CONFLICT'});
  const rejected=await fresh.store.reject(fresh.key,'foundation','旧版本需要重做',fresh.host);expect(await fresh.store.reject(fresh.key,'foundation','旧版本需要重做',fresh.host)).toEqual(rejected);expect((await fresh.store.read(fresh.key)).foundation.review).toEqual(rejected);
  await expect(fresh.store.reject(fresh.key,'foundation','另一个理由',fresh.host)).rejects.toMatchObject({code:'CONFLICT'});
});
it('refuses conflicts, missing candidates, unauthorized hosts and a different saved model result',async()=>{
  const f=await setup();await expect(f.store.review(f.key,'foundation',f.decision,f.host)).rejects.toMatchObject({code:'INCOMPLETE'});await expect(f.store.reject(f.key,'foundation','重写',f.host)).rejects.toMatchObject({code:'INCOMPLETE'});
  await expect(f.store.putBrief({...f.put,actorId:'other'})).rejects.toMatchObject({code:'CONFLICT'});await expect(f.store.putBrief({...f.put,expectedRevision:4})).rejects.toMatchObject({code:'CONFLICT'});
  await expect(f.store.start({...f.command,methods:{...f.command.methods,foundation:{...f.command.methods.foundation,digest:'b'.repeat(64)}}})).rejects.toMatchObject({code:'CONFLICT'});
  await expect(f.store.start({...f.command,execution:{...f.command.execution,reservation:{tokens:50,costMicros:0}}})).rejects.toMatchObject({code:'CONFLICT'});
  await expect(f.store.start({...f.command,runId:'new',expectedRevision:2})).rejects.toMatchObject({code:'CONFLICT'});
  await f.store.saveCandidate(f.key,f.candidate);const output={...f.candidate.output,title:'另一个模型结果'};const alternative=createFoundationCandidate(f.run.brief,output,{...f.candidate.model,outputDigest:hash(output)});
  await expect(f.store.saveCandidate(f.key,alternative)).rejects.toMatchObject({code:'CONFLICT'});
  const modelWrong=structuredClone(f.candidate);modelWrong.model.modelIdentity='other';const {digest:_digest,...body}=modelWrong;Object.assign(modelWrong,{digest:hash(body)});await expect(f.store.saveCandidate(f.key,modelWrong)).rejects.toMatchObject({code:'INVALID_EVIDENCE'});
  await f.store.review(f.key,'foundation',f.decision,f.host);await expect(f.store.review(f.key,'foundation',f.decision,{...f.host,actor:{kind:'human',id:'other'}})).rejects.toMatchObject({code:'CONFLICT'});await expect(f.store.reject(f.key,'foundation','重做',f.host)).rejects.toMatchObject({code:'CONFLICT'});
});
it.each(['briefs','runs','candidates','reviews'] as const)('rejects corrupted stored %s instead of trusting its digest',async table=>{
  const f=await setup();await f.store.saveCandidate(f.key,f.candidate);await f.store.review(f.key,'foundation',f.decision,f.host);
  const row=f.data[table][0]!;if(table==='briefs')row['actor_id']='bad\n';else if(table==='runs')row['request_digest']='b'.repeat(64);else if(table==='candidates')row['digest']='b'.repeat(64);else row['status']='adopted';
  await expect(f.store.read(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('redacts transaction failures and supports acknowledgement-loss retry without duplicate rows',async()=>{
  const f=await setup();f.options.commitAckLost=true;await expect(f.store.saveCandidate(f.key,f.candidate)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.data.candidates).toHaveLength(1);expect(await f.store.saveCandidate(f.key,f.candidate)).toEqual(f.candidate);expect(f.data.candidates).toHaveLength(1);
  f.options.fail=['SELECT stage'];await expect(f.store.read(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.query.mock.calls.some(([sql])=>sql==='ROLLBACK')).toBe(true);
  f.options.fail=['SELECT stage','ROLLBACK'];await expect(f.store.read(f.key)).rejects.toMatchObject({operation:'database rollback'});expect(f.release).toHaveBeenLastCalledWith(true);
  f.options.fail=[];f.options.releaseFailure=true;await expect(f.store.read(f.key)).rejects.toMatchObject({operation:'database release'});
});
it('distinguishes absent runs/briefs from storage lookup failures and rolls back an empty insert',async()=>{
  const f=await setup();const empty=memoryDatabase();
  await expect(empty.store.getBrief({tenantId:'tenant',projectId:'project',briefId:'missing'})).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(empty.store.start(f.command)).rejects.toMatchObject({code:'NOT_FOUND'});await expect(empty.store.read(f.key)).rejects.toMatchObject({code:'NOT_FOUND'});await expect(empty.store.isCurrent(f.key)).rejects.toMatchObject({code:'NOT_FOUND'});
  empty.options.emptyBrief=true;await expect(empty.store.putBrief(f.put)).rejects.toMatchObject({operation:'brief insertion'});expect(empty.data.briefs).toHaveLength(0);
  f.options.fail=['SELECT brief_id'];await expect(f.store.isCurrent(f.key)).rejects.toMatchObject({operation:'run brief lookup'});
});
it('validates stored header bindings, canonical timestamps and missing pinned source rows',async()=>{
  const f=await setup();f.data.briefs[0]!['created_at']='2026-11-16T12:00:00.000Z';f.data.runs[0]!['created_at']='2026-11-16T12:00:00.000Z';expect((await f.store.read(f.key)).run).toEqual(f.run);
  f.data.runs[0]!['created_at']='2026-11-16T12:00:00Z';await expect(f.store.read(f.key)).rejects.toMatchObject({operation:'stored run'});
  const invalidBrief=await setup();invalidBrief.data.briefs[0]!['digest']='b'.repeat(64);await expect(invalidBrief.store.getBrief({tenantId:'tenant',projectId:'project',briefId:invalidBrief.brief.briefId})).rejects.toMatchObject({operation:'stored brief'});
  const missing=await setup();missing.data.briefs.length=0;await expect(missing.store.read(missing.key)).rejects.toMatchObject({operation:'stored run'});
});
it('refuses a caller-supplied upstream audit unless the matching foundation review was persisted',async()=>{
  const f=await setup();const approved=reviewFoundation(f.run.brief,f.candidate,f.decision,f.host);
  const episode=await generateEpisodes({brief:f.run.brief,foundation:approved,runner:f.runner,method:f.run.methods.episodes,context:f.context('episodes')});
  await expect(f.store.saveCandidate(f.key,episode)).rejects.toMatchObject({code:'INCOMPLETE',operation:'foundation review required'});
  expect(f.data.candidates).toHaveLength(0);expect(f.data.reviews).toHaveLength(0);
});
it.each(['extra-candidate','duplicate-candidate','duplicate-review','orphan-review','candidate-header','review-digest','review-content'] as const)('refuses inconsistent progress protocol %s',async kind=>{
  const f=await setup();await f.store.saveCandidate(f.key,f.candidate);await f.store.review(f.key,'foundation',f.decision,f.host);
  if(kind==='extra-candidate')f.data.candidates.push(structuredClone(f.data.candidates[0]!),structuredClone(f.data.candidates[0]!));
  if(kind==='duplicate-candidate')f.data.candidates.push(structuredClone(f.data.candidates[0]!));
  if(kind==='duplicate-review')f.data.reviews.push(structuredClone(f.data.reviews[0]!));
  if(kind==='orphan-review')f.data.candidates.length=0;
  if(kind==='candidate-header')f.data.candidates[0]!['upstream_digest']='b'.repeat(64);
  if(kind==='review-digest')f.data.reviews[0]!['digest']='b'.repeat(64);
  if(kind==='review-content')(f.data.reviews[0]!['record'] as Record<string,unknown>)['actorId']='different';
  await expect(f.store.read(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED',operation:'stored development progress'});
});
