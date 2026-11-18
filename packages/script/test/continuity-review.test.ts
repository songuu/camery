import {expect,it,vi} from 'vitest';
import {createContinuityCandidate} from '../src/continuity/node/candidate.js';
import {authorizeContinuityHost,captureContinuityReviewHost,rejectContinuityCandidate,reviewContinuityCandidate,validateContinuityReview} from '../src/continuity/node/review.js';
import type {ContinuityReviewHost} from '../src/continuity/node/persistence-contracts.js';
import {a,continuityReduceFixture} from './continuity-reduce-support.js';

const scope={tenantId:'continuity-review-tenant',projectId:'ordinary-project'};
const host=(authorize:ContinuityReviewHost['authorize']=()=>true):ContinuityReviewHost=>({actor:{kind:'human',id:'reviewer'},scope:{...scope},at:'2026-11-18T14:00:00.000Z',authorize});
function fixture(){const f=continuityReduceFixture(),candidate=createContinuityCandidate(scope,f.context,f.draft(0,[f.fact(),f.learn()]));return {...f,candidate,decision:{candidateDigest:candidate.digest,draft:structuredClone(candidate.draft),waivers:[]}};}

it('records a human edit independently and replays the full review without granting adoption',()=>{
  const f=fixture(),grant=vi.fn(()=>true),changed=structuredClone(f.decision);const fact=changed.draft.events[0]!;if(fact.op!=='assert_fact')throw new Error('Expected fact');fact.text='人工确认的红信事实';
  const reviewed=reviewContinuityCandidate(f.context,f.candidate,changed,host(grant));expect(reviewed.status).toBe('reviewed');if(reviewed.status!=='reviewed')throw new Error('Expected review');
  expect(reviewed).toMatchObject({candidateDigest:f.candidate.digest,actorId:'reviewer',at:host().at,output:{status:'candidate'}});expect(reviewed.output.ledger.facts[0]!.text).toBe('人工确认的红信事实');expect(f.candidate.ledger.facts[0]!.text).toBe('门后有红信');expect(Object.isFrozen(reviewed.output)).toBe(true);expect(grant).toHaveBeenCalledWith({action:'continuity:review',scope});expect(validateContinuityReview(f.context,f.candidate,reviewed)).toEqual(reviewed);
});
it('captures a strict host and its original function without invoking data getters',()=>{
  const h=host(),captured=captureContinuityReviewHost(h);Object.assign(h.actor,{id:'changed'});Object.assign(h.scope,{projectId:'changed'});expect(captured.actor.id).toBe('reviewer');expect(captured.scope.projectId).toBe(scope.projectId);expect(captured.authorize).toBe(h.authorize);expect(Object.isFrozen(captured.scope)).toBe(true);
  let accessed=0;const getter=Object.defineProperty(host(),'actor',{enumerable:true,get:()=>{accessed++;return {kind:'human',id:'reviewer'};}});expect(()=>captureContinuityReviewHost(getter)).toThrow('FORBIDDEN');expect(accessed).toBe(0);
});
it.each([null,[],new Date(),{...host(),extra:true},{...host(),actor:{kind:'agent_run',id:'agent'}},{...host(),at:'2026-11-18T14:00:00Z'},{...host(),at:'2026-02-30T14:00:00.000Z'},{...host(),authorize:true}])('refuses a malformed or non-human host %#',input=>{expect(()=>captureContinuityReviewHost(input)).toThrow('FORBIDDEN');});
it('rejects unsafe host prototypes, symbols, nonenumerable fields and opaque traps safely',()=>{
  expect(()=>captureContinuityReviewHost(Object.create(host()))).toThrow('FORBIDDEN');expect(()=>captureContinuityReviewHost({...host(),[Symbol('private')]:'secret'})).toThrow('FORBIDDEN');
  const hidden=Object.defineProperty(host(),'at',{enumerable:false,value:host().at});expect(()=>captureContinuityReviewHost(hidden)).toThrow('FORBIDDEN');const opaque=new Proxy({}, {getPrototypeOf:()=>{throw new Error('private');}});expect(()=>captureContinuityReviewHost(opaque)).toThrow('Continuity human host failed (FORBIDDEN) at host');
});
it('requires exact scope and literal synchronous permission for every action',()=>{
  for(const action of ['continuity:read','continuity:prepare','continuity:review','continuity:reject'] as const){const grant=vi.fn(()=>true);expect(authorizeContinuityHost(host(grant),action,scope).actor.id).toBe('reviewer');expect(grant).toHaveBeenCalledOnce();}
  expect(()=>authorizeContinuityHost(host(),'continuity:read',{...scope,projectId:'other'})).toThrow('FORBIDDEN');expect(()=>authorizeContinuityHost(host(()=>false),'continuity:read',scope)).toThrow('FORBIDDEN');expect(()=>authorizeContinuityHost(host(),'unknown' as never,scope)).toThrow('FORBIDDEN');
});
it('observes mistaken async rejections without invoking thenable accessors or authorizing',async()=>{
  const asyncGrant=()=>Promise.reject(new Error('private async'));expect(()=>authorizeContinuityHost(host(asyncGrant as never),'continuity:review',scope)).toThrow('FORBIDDEN');await new Promise(resolve=>setTimeout(resolve,0));
  let touched=false;const thenable=Object.defineProperty({},'then',{get:()=>{touched=true;throw new Error('private then');}});expect(()=>authorizeContinuityHost(host((()=>thenable) as never),'continuity:review',scope)).toThrow('FORBIDDEN');expect(touched).toBe(false);
  expect(()=>authorizeContinuityHost(host(()=>{throw new Error('private authorization');}),'continuity:read',scope)).toThrow('Continuity human authorization failed (FORBIDDEN) at host');
});
it('binds the original digest, scope, episode, context and previous ledger',()=>{
  const f=fixture();expect(()=>reviewContinuityCandidate(f.context,f.candidate,{...f.decision,candidateDigest:'0'.repeat(64)},host())).toThrow('CONFLICT');expect(()=>reviewContinuityCandidate(f.context,f.candidate,{...f.decision,draft:f.draft(1)},host())).toThrow('CONFLICT');
  expect(()=>reviewContinuityCandidate(f.context,f.candidate,f.decision,{...host(),scope:{...scope,projectId:'other'}})).toThrow('FORBIDDEN');const changed=structuredClone(f.context);changed.snapshotRevision++;expect(()=>reviewContinuityCandidate(changed,f.candidate,f.decision,host())).toThrow('CONFLICT');
  const second=createContinuityCandidate(scope,f.context,f.draft(1),f.candidate.ledger),decision={candidateDigest:second.digest,draft:second.draft,waivers:[]};expect(reviewContinuityCandidate(f.context,second,decision,host(),f.candidate.ledger).status).toBe('reviewed');expect(()=>reviewContinuityCandidate(f.context,second,decision,host())).toThrow('INCOMPLETE');
});
it('requires exact reasoned warning coverage and preserves declared waiver order',()=>{
  const f=fixture(),draft=f.draft(0,[{id:'plant-a',op:'plant',threadId:'a',summary:'红信来源',payoffEpisodeId:f.episodes[0]!.id,evidence:f.evidence()},{id:'plant-b',op:'plant',threadId:'b',summary:'门后身份',payoffEpisodeId:f.episodes[0]!.id,evidence:f.evidence()}]),candidate=createContinuityCandidate(scope,f.context,draft),waivers=candidate.issues.map(issue=>({code:issue.code,path:issue.path,reason:'人工保留悬念到下一集。'})).reverse();
  const reviewed=reviewContinuityCandidate(f.context,candidate,{candidateDigest:candidate.digest,draft,waivers},host());expect(reviewed.status).toBe('reviewed');if(reviewed.status==='reviewed')expect(reviewed.waivers).toEqual(waivers);
  expect(()=>reviewContinuityCandidate(f.context,candidate,{candidateDigest:candidate.digest,draft,waivers:[]},host())).toThrow('INCOMPLETE');expect(()=>reviewContinuityCandidate(f.context,candidate,{candidateDigest:candidate.digest,draft,waivers:[waivers[0],waivers[0]]},host())).toThrow('INVALID_REFERENCE');
  expect(()=>reviewContinuityCandidate(f.context,candidate,{candidateDigest:candidate.digest,draft,waivers:[{...waivers[0]!,path:'unknown'},waivers[1]]},host())).toThrow('INVALID_REFERENCE');expect(()=>reviewContinuityCandidate(f.context,candidate,{candidateDigest:candidate.digest,draft,waivers:[{...waivers[0]!,reason:' '},waivers[1]]},host())).toThrow('INVALID_INPUT');
});
it('never waives an error but allows the human to repair the draft before review',()=>{
  const f=fixture(),bad=f.draft(0,[f.fact(),{id:'unknown-use',op:'use_fact',characterId:a,factId:'red-letter',evidence:f.evidence(0,2)}]),candidate=createContinuityCandidate(scope,f.context,bad),issue=candidate.issues[0]!;
  expect(()=>reviewContinuityCandidate(f.context,candidate,{candidateDigest:candidate.digest,draft:bad,waivers:[{code:issue.code,path:issue.path,reason:'不能这样豁免'}]},host())).toThrow('INCOMPLETE');expect(reviewContinuityCandidate(f.context,candidate,{candidateDigest:candidate.digest,draft:f.draft(0,[f.fact(),f.learn()]),waivers:[]},host()).status).toBe('reviewed');
});
it('stores a reasoned rejection separately, including against the supplied historical source',()=>{
  const f=fixture(),rejected=rejectContinuityCandidate(f.context,f.candidate,{candidateDigest:f.candidate.digest,reason:'来源需要重新核对。'},host());expect(rejected).toMatchObject({status:'rejected',actorId:'reviewer',candidateDigest:f.candidate.digest,reason:'来源需要重新核对。'});expect('output' in rejected).toBe(false);expect(validateContinuityReview(f.context,f.candidate,rejected)).toEqual(rejected);
  expect(()=>rejectContinuityCandidate(f.context,f.candidate,{candidateDigest:'0'.repeat(64),reason:'拒绝'},host())).toThrow('CONFLICT');expect(()=>rejectContinuityCandidate(f.context,f.candidate,{candidateDigest:f.candidate.digest,reason:' '},host())).toThrow('INVALID_INPUT');expect(()=>rejectContinuityCandidate(f.context,f.candidate,{candidateDigest:f.candidate.digest,reason:'拒绝'},host(()=>false))).toThrow('FORBIDDEN');
});
it.each(['digest','actorId','at','output','waivers','candidateDigest'] as const)('rejects tampered stored review %s',field=>{
  const f=fixture(),review=structuredClone(reviewContinuityCandidate(f.context,f.candidate,f.decision,host()));if(review.status!=='reviewed')throw new Error('Expected review');
  if(field==='digest')review.digest='0'.repeat(64);else if(field==='actorId')review.actorId='other';else if(field==='at')review.at='2026-11-18T14:01:00.000Z';else if(field==='candidateDigest')review.candidateDigest='0'.repeat(64);else if(field==='waivers')review.waivers.push({code:'OVERDUE_THREAD',path:'unknown',reason:'伪造'});else review.output.ledger.facts[0]!.text='被篡改';
  expect(()=>validateContinuityReview(f.context,f.candidate,review)).toThrow();
});
it('rejects changed rejection audits, opaque decisions and over-budget data without exposing content',()=>{
  const f=fixture(),rejected=rejectContinuityCandidate(f.context,f.candidate,{candidateDigest:f.candidate.digest,reason:'拒绝'},host());expect(()=>validateContinuityReview(f.context,f.candidate,{...rejected,reason:'篡改'})).toThrow('CONFLICT');
  let touched=false;const decision=Object.defineProperty({},'candidateDigest',{enumerable:true,get:()=>{touched=true;return f.candidate.digest;}});expect(()=>reviewContinuityCandidate(f.context,f.candidate,decision,host())).toThrow('INVALID_INPUT');expect(touched).toBe(false);expect(()=>reviewContinuityCandidate(f.context,f.candidate,{...f.decision,extra:'x'.repeat(16_777_216)},host())).toThrow('INPUT_LIMIT');
});
it('captures the context, decision and predecessor before invoking the host authorization callback',()=>{
  const f=fixture(),decision=structuredClone(f.decision),reviewed=reviewContinuityCandidate(f.context,f.candidate,decision,host(()=>{f.context.snapshotRevision++;const fact=decision.draft.events[0]!;if(fact.op==='assert_fact')fact.text='late callback mutation';return true;}));
  expect(reviewed.status).toBe('reviewed');if(reviewed.status==='reviewed'){expect(reviewed.output.contextDigest).toBe(f.candidate.contextDigest);expect(reviewed.output.ledger.facts[0]!.text).toBe('门后有红信');}
  const next=fixture(),previous=structuredClone(next.candidate.ledger),candidate=createContinuityCandidate(scope,next.context,next.draft(1),previous),result=reviewContinuityCandidate(next.context,candidate,{candidateDigest:candidate.digest,draft:candidate.draft,waivers:[]},host(()=>{previous.facts[0]!.text='changed previous';return true;}),previous);if(result.status==='reviewed')expect(result.output.previousDigest).toBe(candidate.previousDigest);
  const rejectedFixture=fixture(),rejection={candidateDigest:rejectedFixture.candidate.digest,reason:'original reason'},rejected=rejectContinuityCandidate(rejectedFixture.context,rejectedFixture.candidate,rejection,host(()=>{rejection.reason='late reason';return true;}));expect(rejected).toMatchObject({status:'rejected',reason:'original reason'});
});
it('supports a captured null-prototype host and rejects mutated raw audit identity formats',()=>{
  const f=fixture(),plain=Object.assign(Object.create(null) as Record<string,unknown>,host()),review=reviewContinuityCandidate(f.context,f.candidate,f.decision,plain);expect(review.status).toBe('reviewed');
  expect(()=>validateContinuityReview(f.context,f.candidate,{...review,at:'2026-02-30T14:00:00.000Z'})).toThrow('INVALID_INPUT');
  const nested=Object.defineProperty({kind:'human'},'id',{enumerable:true,get:()=>{throw new Error('private actor');}});expect(()=>captureContinuityReviewHost({...host(),actor:nested})).toThrow('FORBIDDEN');
});
it('keeps a complete legal review above two MiB and replays every warning reason',()=>{
  const f=fixture(),draft=f.draft(0,Array.from({length:1000},(_,index)=>({id:'plant-'+index,op:'plant' as const,threadId:'thread-'+index,summary:'未回收线索',payoffEpisodeId:f.episodes[0]!.id,evidence:{event:f.evidence().event,quote:'门'}}))),candidate=createContinuityCandidate(scope,f.context,draft),waivers=candidate.issues.map(issue=>({code:issue.code,path:issue.path,reason:'界'.repeat(1000)}));
  const review=reviewContinuityCandidate(f.context,candidate,{candidateDigest:candidate.digest,draft,waivers},host());expect(Buffer.byteLength(JSON.stringify(review))).toBeGreaterThan(2_097_152);expect(review.status).toBe('reviewed');expect(validateContinuityReview(f.context,candidate,review)).toEqual(review);
});
