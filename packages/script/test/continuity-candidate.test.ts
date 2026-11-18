import {expect,it} from 'vitest';
import {createContinuityCandidate,validateContinuityCandidate} from '../src/continuity/node/candidate.js';
import {a,continuityReduceFixture} from './continuity-reduce-support.js';
const scope={tenantId:'continuity-tenant',projectId:'ordinary-project'};
it('creates a replayable integrity candidate with all four ledgers and no adoption claim',()=>{
  const f=continuityReduceFixture(),draft=f.draft(0,[f.fact(),f.learn()]),candidate=createContinuityCandidate(scope,f.context,draft);
  expect(candidate).toMatchObject({status:'candidate',scope,previousDigest:null,issues:[]});expect(candidate.digest).toMatch(/^[a-f0-9]{64}$/);expect(candidate.ledger.knowledge[0]?.characterId).toBe(a);expect(validateContinuityCandidate(f.context,candidate)).toEqual(candidate);expect(Object.isFrozen(candidate.draft.events)).toBe(true);
  draft.events[0]!.evidence.quote='changed';expect(candidate.draft.events[0]!.evidence.quote).not.toBe('changed');expect('adoption' in candidate).toBe(false);
});
it('preserves knowledge issues instead of manufacturing a successful ledger',()=>{const f=continuityReduceFixture(),candidate=createContinuityCandidate(scope,f.context,f.draft(0,[f.fact(),{id:'use',op:'use_fact',characterId:a,factId:'red-letter',evidence:f.evidence(0,2)}]));expect(candidate.issues[0]?.code).toBe('KNOWLEDGE_REQUIRED');expect(candidate.ledger.knowledge).toEqual([]);expect(validateContinuityCandidate(f.context,candidate)).toEqual(candidate);});
it('binds the exact previous ledger and current context independently of a supplied digest',()=>{
  const f=continuityReduceFixture(),first=createContinuityCandidate(scope,f.context,f.draft(0,[f.fact(),f.learn()])),second=createContinuityCandidate(scope,f.context,f.draft(1),first.ledger);expect(second.previousDigest).not.toBeNull();expect(validateContinuityCandidate(f.context,second,first.ledger)).toEqual(second);
  const previous=structuredClone(first.ledger);previous.facts[0]!.text='不同的声明';expect(()=>validateContinuityCandidate(f.context,second,previous)).toThrow('CONFLICT');
  const context=structuredClone(f.context);context.snapshotRevision++;expect(()=>validateContinuityCandidate(context,first)).toThrow('CONFLICT');
});
it.each(['ledger','issues','digest','scope'] as const)('rejects a changed %s even if the supplied record is structurally valid',field=>{
  const f=continuityReduceFixture(),candidate=structuredClone(createContinuityCandidate(scope,f.context,f.draft(0,[f.fact()])));
  if(field==='ledger')candidate.ledger.facts[0]!.text='被修改的事实';else if(field==='issues')candidate.issues.push({code:'UNKNOWN_FACT',severity:'error',path:'events.0',eventId:'assert',message:'虚构问题'});else if(field==='digest')candidate.digest='0'.repeat(64);else candidate.scope.projectId='changed-project';
  expect(()=>validateContinuityCandidate(f.context,candidate)).toThrow('CONFLICT');
});
it('refuses status escalation, unsafe objects and byte excess with safe domain context',()=>{
  const f=continuityReduceFixture(),candidate=createContinuityCandidate(scope,f.context,f.draft());expect(()=>validateContinuityCandidate(f.context,{...candidate,status:'adopted'})).toThrow('INVALID_INPUT');
  let accessed=0;const getter=Object.defineProperty({},'tenantId',{enumerable:true,get:()=>{accessed++;throw new Error('private');}});expect(()=>createContinuityCandidate(getter,f.context,f.draft())).toThrow('INVALID_INPUT');expect(accessed).toBe(0);
  expect(()=>createContinuityCandidate(scope,f.context,{...f.draft(),extra:'x'.repeat(524288)})).toThrow('INPUT_LIMIT');
});
it('creates and replays a candidate from a complete context larger than two MiB',()=>{
  const f=continuityReduceFixture();f.context.events[0]!.text='x'.repeat(2_100_000);const candidate=createContinuityCandidate(scope,f.context,f.draft());expect(validateContinuityCandidate(f.context,candidate)).toEqual(candidate);
  const reordered=Object.fromEntries(Object.entries(candidate).reverse());expect(validateContinuityCandidate(f.context,reordered)).toEqual(candidate);
});
