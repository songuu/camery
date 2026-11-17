import {expect,it,vi} from 'vitest';
import {generateFoundation,generateEpisodes} from '../src/development.js';
import {developmentStageCallId,episodeExecutionFromFull} from '../src/node/contracts.js';
import {MethodRunner,createStructuredGenerationExecutor} from '@camery/methods';
import {memoryDatabase} from './store-memory.js';
import {workflowFixture} from './workflow-support.js';
async function fixture(){
  const f=workflowFixture();const db=memoryDatabase();const {version:_v,digest:_d,revision:_r,...fields}=f.brief;const put={...fields,expectedRevision:0,actorId:'author'};const saved=await db.store.putBrief(put);
  const run=await db.store.start({...f.key,briefId:f.brief.briefId,expectedRevision:1,expectedBriefDigest:saved.brief.digest,methods:f.run.methods,execution:f.run.execution});
  const foundation=await generateFoundation({...f,method:f.foundationMethod,context:f.context(developmentStageCallId(f.key,'foundation'))});await db.store.saveCandidate(f.key,foundation);const reviewed=await db.store.review(f.key,'foundation',{candidateDigest:foundation.digest,output:foundation.output},f.host);
  const episodes=await generateEpisodes({...f,foundation:reviewed as Parameters<typeof generateEpisodes>[0]['foundation'],method:f.episodeMethod,context:f.context(developmentStageCallId(f.key,'episodes'))});await db.store.saveCandidate(f.key,episodes);const complete=await db.store.review(f.key,'episodes',{candidateDigest:episodes.digest,output:episodes.output},f.host);
  const source={...f.key,runDigest:run.digest,briefDigest:f.brief.digest,foundationReviewDigest:reviewed.digest,episodesReviewDigest:complete.digest};return {...f,...db,put,source};
}
it('reconstructs both reviewed phases on the caller connection with the brief lock before run locks and no nested transaction',async()=>{
  const f=await fixture();const client=await f.pool.connect();f.query.mockClear();f.release.mockClear();f.connect.mockClear();const before=structuredClone(f.data);const result=await f.store.readForAdoption(client,f.source);expect(result.episodes.review?.status).toBe('reviewed');expect(f.data).toEqual(before);expect(f.connect).not.toHaveBeenCalled();
  const calls=f.query.mock.calls;expect(calls.some(([sql])=>['BEGIN','COMMIT','ROLLBACK'].includes(sql))).toBe(false);const locks=calls.filter(([sql])=>sql.startsWith('SELECT pg_advisory_xact_lock')).map(([,values])=>JSON.parse(values![0] as string));expect(locks).toEqual([['camery_script:brief',f.key.tenantId,f.key.projectId,f.brief.briefId],['camery_script:run',f.key.tenantId,f.key.projectId,f.key.runId]]);expect(f.release).not.toHaveBeenCalled();
});
it.each(['runDigest','briefDigest','foundationReviewDigest','episodesReviewDigest'] as const)('refuses a changed expected %s after reconstructing actual evidence',async field=>{
  const f=await fixture();await expect(f.store.readForAdoption(await f.pool.connect(),{...f.source,[field]:'d'.repeat(64)})).rejects.toMatchObject({code:'CONFLICT'});
});
it('refuses stale briefs or missing human reviews and captures source identity before awaiting SQL',async()=>{
  const f=await fixture();await f.store.putBrief({...f.put,expectedRevision:1,idea:'正式采用前创意已更新。'});await expect(f.store.readForAdoption(await f.pool.connect(),f.source)).rejects.toMatchObject({code:'CONFLICT'});
  const current=await fixture();current.data.reviews.splice(current.data.reviews.findIndex(row=>row['stage']==='episodes'),1);await expect(current.store.readForAdoption(await current.pool.connect(),current.source)).rejects.toMatchObject({code:'INCOMPLETE'});
  const missing=await fixture();await expect(missing.store.readForAdoption(await missing.pool.connect(),{...missing.source,runId:'missing'})).rejects.toMatchObject({code:'NOT_FOUND'});
  const next=await fixture();const read=vi.fn(next.query.getMockImplementation()!);const client=await next.pool.connect();const proxy=new Proxy(client,{get(target,property){return property==='query'?read:Reflect.get(target,property);}});const command={...next.source};const reading=next.store.readForAdoption(proxy,command);command.runId='substituted';expect((await reading).run.runId).toBe(next.key.runId);
});
it('resolves inherited foundation evidence and locks its actual owner together with the new episodes run',async()=>{
  const f=await fixture();const original=await f.store.read(f.key);const childKey={...f.key,runId:'child-for-adoption'};const child=await f.store.fork({...childKey,sourceRunId:f.key.runId,expectedSourceRunDigest:original.run.digest,expectedRevision:1,expectedBriefDigest:f.brief.digest,actorId:'child-author',methods:f.run.methods,stage:'episodes',expectedFoundationReviewDigest:original.foundation.review!.digest,execution:episodeExecutionFromFull(f.run.execution)});
  const runner=new MethodRunner(f.methods,[createStructuredGenerationExecutor(await f.sessionFor())]);const candidate=await generateEpisodes({...f,runner,brief:child.brief,foundation:original.foundation.review as Parameters<typeof generateEpisodes>[0]['foundation'],method:child.methods.episodes,context:f.context(developmentStageCallId(childKey,'episodes'))});await f.store.saveCandidate(childKey,candidate);const review=await f.store.review(childKey,'episodes',{candidateDigest:candidate.digest,output:candidate.output},f.host);
  const client=await f.pool.connect();f.query.mockClear();const result=await f.store.readForAdoption(client,{...f.source,...childKey,runDigest:child.digest,episodesReviewDigest:review.digest});expect(result.foundation).toEqual(original.foundation);
  const locks=f.query.mock.calls.filter(([sql])=>sql.startsWith('SELECT pg_advisory_xact_lock')).map(([,values])=>JSON.parse(values![0] as string));expect(locks.map(parts=>parts[0])).toEqual(['camery_script:brief','camery_script:run','camery_script:run']);expect(locks.slice(1).map(parts=>parts[3])).toEqual([childKey.runId,f.key.runId].sort());
});
it('rejects invalid source data before reading accessors and redacts unexpected driver failures',async()=>{
  const f=await fixture();let invoked=false;const bad=Object.defineProperty({...f.source},'briefDigest',{enumerable:true,get(){invoked=true;throw new Error('private');}});f.query.mockClear();await expect(f.store.readForAdoption(await f.pool.connect(),bad)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(invoked).toBe(false);expect(f.query).not.toHaveBeenCalled();
  f.options.fail=['SELECT brief_id'];await expect(f.store.readForAdoption(await f.pool.connect(),f.source)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
