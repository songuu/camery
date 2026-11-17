import {expect,it,vi} from 'vitest';
import {memoryDatabase} from './store-memory.js';
import {workflowFixture} from './workflow-support.js';
import {generateFoundation} from '../src/development.js';
import {developmentStageCallId,developmentRunDigest,episodeExecutionFromFull} from '../src/node/contracts.js';
import {MethodRunner,ModelSession,createStructuredGenerationExecutor} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import {generateEpisodes} from '../src/development.js';
import type {ReviewedDevelopment} from '../src/contracts.js';
import {protocolTransport} from './workflow-pg-support.js';
async function fixture(){
  const f=workflowFixture();const db=memoryDatabase();const {version:_v,digest:_d,revision:_r,...fields}=f.brief;const put={...fields,expectedRevision:0,actorId:'author'};
  const saved=await db.store.putBrief(put);const command={...f.key,briefId:f.brief.briefId,expectedRevision:1,expectedBriefDigest:saved.brief.digest,methods:f.run.methods,execution:f.run.execution};const run=await db.store.start(command);
  const candidate=await generateFoundation({brief:run.brief,runner:f.runner,method:run.methods.foundation,context:{...f.context('unused'),idempotencyKey:developmentStageCallId(f.key,'foundation')}});await db.store.saveCandidate(f.key,candidate);
  const review=await db.store.review(f.key,'foundation',{candidateDigest:candidate.digest,output:{...candidate.output,title:'原用户审阅设定'}},f.host);
  const fork={tenantId:f.key.tenantId,projectId:f.key.projectId,runId:'child',sourceRunId:f.key.runId,expectedSourceRunDigest:run.digest,expectedRevision:1,expectedBriefDigest:run.brief.digest,actorId:'new-author',methods:run.methods,stage:'episodes' as const,expectedFoundationReviewDigest:review.digest,execution:episodeExecutionFromFull(run.execution)};
  return {...f,...db,put,run,candidate,review,fork,command,child:{...f.key,runId:'child'}};
}
it('resolves the real original foundation owner without copying candidate/review rows or rewriting model receipts',async()=>{
  const f=await fixture();const child=await f.store.fork(f.fork);expect(child.origin).toEqual({version:1,stage:'episodes',sourceRunId:f.run.runId,sourceRunDigest:f.run.digest,actorId:'new-author',foundation:{runId:f.run.runId,runDigest:f.run.digest,candidateDigest:f.candidate.digest,reviewDigest:f.review.digest,execution:f.run.execution}});
  const progress=await f.store.read(f.child);expect(progress.foundation).toEqual({candidate:f.candidate,review:f.review});expect(progress.episodes).toEqual({candidate:null,review:null});
  expect(f.data.candidates.filter(row=>row['run_id']==='child')).toHaveLength(0);expect(f.data.reviews.filter(row=>row['run_id']==='child')).toHaveLength(0);
  const next=await f.store.fork({...f.fork,runId:'grandchild',sourceRunId:'child',expectedSourceRunDigest:child.digest});expect(next.origin).toMatchObject({sourceRunId:'child',foundation:{runId:f.run.runId,reviewDigest:f.review.digest}});
  expect((await f.store.read({...f.key,runId:'grandchild'})).foundation).toEqual(progress.foundation);
});
it('retains same semantic branch acknowledgements after the brief changes and rejects a reused identity with different authors or plans',async()=>{
  const f=await fixture();const first=await f.store.fork(f.fork);await f.store.putBrief({...f.put,expectedRevision:1,idea:'创意已改变，但原分支确认仍可恢复。'});
  expect(await f.store.fork(f.fork)).toEqual(first);for(const changed of [{actorId:'another'},{execution:{...f.fork.execution,modelIdentity:'another'}},{sourceRunId:'missing'}])await expect(f.store.fork({...f.fork,...changed})).rejects.toMatchObject({code:'CONFLICT'});
  await expect(f.store.fork({...f.fork,runId:'stale'})).rejects.toMatchObject({code:'CONFLICT'});
  await expect(f.store.start({...f.command,runId:'child',execution:f.fork.execution})).rejects.toThrow();
});
it('makes inherited foundation read-only even to the original reviewer and supports a fresh full-plan foundation redo',async()=>{
  const f=await fixture();await f.store.fork(f.fork);const host={...f.host,authorize:vi.fn(()=>true)};
  await expect(f.store.saveCandidate(f.child,f.candidate)).rejects.toMatchObject({code:'FORBIDDEN'});await expect(f.store.review(f.child,'foundation',{candidateDigest:f.candidate.digest,output:f.candidate.output},host)).rejects.toMatchObject({code:'FORBIDDEN'});await expect(f.store.reject(f.child,'foundation','不应更改原审核。',host)).rejects.toMatchObject({code:'FORBIDDEN'});expect(host.authorize).not.toHaveBeenCalled();
  const fresh=await f.store.fork({...f.fork,runId:'fresh-foundation',stage:'foundation',expectedFoundationReviewDigest:null,execution:f.run.execution});expect(fresh.origin).toMatchObject({stage:'foundation',foundation:null});expect((await f.store.read({...f.key,runId:fresh.runId})).foundation).toEqual({candidate:null,review:null});
});
it('binds new episodes to a changed trusted model while preserving the source profile and original audit',async()=>{
  const f=await fixture();const execution={...f.fork.execution,connectionId:'new-connection',modeDigest:'d'.repeat(64),modelIdentity:'new-model'};const child=await f.store.fork({...f.fork,execution});
  const session=new ModelSession(new OpenAiCompatibleLlm(protocolTransport(),{model:execution.modelIdentity,structuredOutput:'json_schema'}),{tenantId:child.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:execution.modelIdentity,evidence:'synthetic_replay',maxCalls:1,timeoutMs:2000});
  const runner=new MethodRunner(f.methods,[createStructuredGenerationExecutor(session)]);const candidate=await generateEpisodes({brief:child.brief,foundation:f.review as ReviewedDevelopment<'foundation'>,runner,method:child.methods.episodes,context:{tenantId:child.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,idempotencyKey:developmentStageCallId(f.child,'episodes'),signal:new AbortController().signal}});
  await f.store.saveCandidate(f.child,candidate);const reviewed=await f.store.review(f.child,'episodes',{candidateDigest:candidate.digest,output:candidate.output},f.host);const progress=await f.store.read(f.child);
  expect(progress.foundation).toEqual({candidate:f.candidate,review:f.review});expect(progress.episodes).toEqual({candidate,review:reviewed});expect(candidate.model).toMatchObject({connectionId:'new-connection',modelIdentity:'new-model'});expect(progress.foundation.candidate!.model).not.toEqual(candidate.model);expect(session.callsUsed).toBe(1);
});
it('rejects bad source snapshots, unreviewed or rejected settings and invalid fork data before writes',async()=>{
  const f=await fixture();for(const change of [{expectedSourceRunDigest:'d'.repeat(64)},{expectedFoundationReviewDigest:'d'.repeat(64)},{expectedRevision:2},{expectedBriefDigest:'d'.repeat(64)}])await expect(f.store.fork({...f.fork,...change})).rejects.toMatchObject({code:'CONFLICT'});
  await expect(f.store.fork({...f.fork,projectId:'other'})).rejects.toMatchObject({code:'NOT_FOUND'});await expect(f.store.fork({...f.fork,runId:f.key.runId})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.store.fork({...f.fork,runId:f.key.runId,sourceRunId:'different'})).rejects.toMatchObject({code:'CONFLICT'});
  const reviews=f.data.reviews.splice(0);await expect(f.store.fork(f.fork)).rejects.toMatchObject({code:'INCOMPLETE'});f.data.reviews.push(...reviews);
  f.data.reviews.splice(0);await f.store.reject(f.key,'foundation','重新开发。',f.host);await expect(f.store.fork(f.fork)).rejects.toMatchObject({code:'INCOMPLETE'});
  const fresh=memoryDatabase();await expect(fresh.store.fork({})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(fresh.connect).not.toHaveBeenCalled();
});
it('keeps fork writes atomic across insert failures and commit acknowledgement loss with stable ordered locks',async()=>{
  const f=await fixture();f.options.fail=['INSERT INTO camery_script.run_origins'];await expect(f.store.fork(f.fork)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.data.runs).toHaveLength(1);expect(f.data.run_origins).toHaveLength(0);
  f.options.fail=[];f.options.commitAckLost=true;await expect(f.store.fork(f.fork)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.data.run_origins).toHaveLength(1);const recovered=await f.store.fork(f.fork);expect(recovered.runId).toBe('child');expect(f.data.runs).toHaveLength(2);
  const locks=f.query.mock.calls.filter(([sql])=>sql.startsWith('SELECT pg_advisory')).slice(-3).map(([,values])=>JSON.parse(values![0] as string) as string[]);expect(locks[0]![0]).toBe('camery_script:brief');expect(locks.slice(1).map(value=>value[3])).toEqual(['child',f.key.runId].sort());
});
it('captures fork input before a pool wait and rebuilds source bindings rather than trusting a rehashed origin',async()=>{
  const f=await fixture();let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});f.options.wait={prefix:'SELECT brief_id',gate};const command=structuredClone(f.fork);const pending=f.store.fork(command);command.actorId='mutated-after-call';release();const child=await pending;delete f.options.wait;expect(child.origin!.actorId).toBe('new-author');
  const origin=f.data.run_origins[0]!;const record=structuredClone(origin['record']) as NonNullable<typeof child.origin>;record.actorId='different';origin['record']=record;await expect(f.store.read(f.child)).rejects.toMatchObject({code:'STORAGE_FAILED'});record.actorId='new-author';
  if(record.foundation)record.foundation.execution.modelIdentity='forged-source-model';origin['record']=record;const row=f.data.runs.find(value=>value['run_id']==='child')!;row['digest']=developmentRunDigest({...child,origin:record});await expect(f.store.read(f.child)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('refuses local shadow foundation rows in an origin-only child and missing source evidence',async()=>{
  const f=await fixture();await f.store.fork(f.fork);const shadow={...structuredClone(f.data.candidates[0]!),run_id:'child'};f.data.candidates.push(shadow);await expect(f.store.read(f.child)).rejects.toMatchObject({code:'STORAGE_FAILED'});f.data.candidates.pop();f.data.reviews.splice(0);await expect(f.store.read(f.child)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
