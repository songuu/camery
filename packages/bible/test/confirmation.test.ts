import { expect, it, vi } from 'vitest';
import { confirmBible, rejectBibleCandidate } from '../src/confirmation.js';
import { hash } from '../src/data.js';
import { reviewFixture } from './review-support.js';
import type { ReviewHost } from '../src/contracts.js';

it('requires explicit human groups and preserves contradictory descriptions with exact global evidence',()=>{
  const {source,candidate,decision,host}=reviewFixture(); const result=confirmBible(source,candidate,decision,host);
  expect(result.status).toBe('confirmed'); expect(result.entities).toHaveLength(2); expect(candidate.status).toBe('candidate');
  expect(result.entities.find(e=>e.id==='lin')!.descriptions.map(d=>d.text)).toContain('小林不识字。');
  expect(result.entities.find(e=>e.id==='lin')!.descriptions.map(d=>d.text)).toContain('小林读懂了信。');
  expect(result.entities.find(e=>e.id==='lin')!.aliases).toContain('林先生');
  for(const relation of result.relations)expect([relation.from,relation.to]).toEqual(['lin','qing']);
  for(const claim of result.claims)expect(claim.entityIds).toEqual(['lin']);
  for(const entity of result.entities) for(const description of entity.descriptions) for(const quote of description.evidence)
    expect(source.document.text.slice(quote.start,quote.end)).toBe(quote.quote);
  expect(result.actorId).toBe('reviewer'); expect(result.candidateDigest).toBe(candidate.digest);
  const {digest,...body}=result; expect(digest).toBe(hash(body)); expect(Object.isFrozen(result.entities[0]!.descriptions)).toBe(true);
});
it('lets a reviewer keep same-name entities separate instead of accepting the suggestion',()=>{
  const {source,candidate,decision,host}=reviewFixture(); decision.groups=candidate.entities.map((e,i)=>({id:'person-'+i,memberIds:[e.id],name:e.name}));
  const result=confirmBible(source,candidate,decision,host); expect(result.entities).toHaveLength(candidate.entities.length);
  expect(result.relations[0]!.from).not.toBe(result.relations[1]!.from);
});
it('is deterministic across decision ordering and repeats while isolating caller mutation',()=>{
  const {source,candidate,decision,host}=reviewFixture(); const result=confirmBible(source,candidate,decision,host);
  decision.groups.reverse(); for(const group of decision.groups)group.memberIds.reverse(); decision.selectedClaimIds.reverse(); decision.selectedRelationIds.reverse();
  expect(confirmBible(source,candidate,decision,host)).toEqual(result); decision.groups[0]!.name='后来修改';
  expect(result.entities.some(e=>e.name==='后来修改')).toBe(false);
});
it.each([
  (x:ReturnType<typeof reviewFixture>)=>x.decision.groups.pop(),
  (x:ReturnType<typeof reviewFixture>)=>x.decision.groups[0]!.memberIds.push(x.decision.groups[1]!.memberIds[0]!),
  (x:ReturnType<typeof reviewFixture>)=>x.decision.groups[0]!.memberIds.push('missing'),
  (x:ReturnType<typeof reviewFixture>)=>x.decision.groups.push({...x.decision.groups[0]!,memberIds:[]}),
  (x:ReturnType<typeof reviewFixture>)=>x.decision.groups[1]!.id=x.decision.groups[0]!.id,
  (x:ReturnType<typeof reviewFixture>)=>x.decision.rejectedEntityIds.push(x.decision.groups[0]!.memberIds[0]!),
  (x:ReturnType<typeof reviewFixture>)=>x.decision.rejectedEntityIds.push('missing'),
  (x:ReturnType<typeof reviewFixture>)=>x.decision.selectedRelationIds.push('missing'),
  (x:ReturnType<typeof reviewFixture>)=>x.decision.selectedRelationIds.push(x.decision.selectedRelationIds[0]!),
  (x:ReturnType<typeof reviewFixture>)=>x.decision.selectedClaimIds.push('missing'),
  (x:ReturnType<typeof reviewFixture>)=>x.decision.selectedClaimIds.push(x.decision.selectedClaimIds[0]!),
])('rejects incomplete, duplicate or fabricated review decisions %#',breakDecision=>{
  const x=reviewFixture(); breakDecision(x); expect(()=>confirmBible(x.source,x.candidate,x.decision,x.host)).toThrow();
});
it('does not silently prune references to rejected entities',()=>{
  const {source,candidate,decision,host}=reviewFixture(); const removed=decision.groups.pop()!; decision.rejectedEntityIds=removed.memberIds;
  expect(()=>confirmBible(source,candidate,decision,host)).toThrow(); decision.selectedRelationIds=[];
  expect(confirmBible(source,candidate,decision,host).entities).toHaveLength(1);
  const all=decision.groups.pop()!; decision.rejectedEntityIds.push(...all.memberIds);
  expect(()=>confirmBible(source,candidate,decision,host)).toThrow(); decision.selectedClaimIds=[];
  expect(confirmBible(source,candidate,decision,host).entities).toEqual([]);
  decision.rejectedEntityIds.push(decision.rejectedEntityIds[0]!); expect(()=>confirmBible(source,candidate,decision,host)).toThrow();
});
it('rejects merging unlike entity kinds',()=>{
  const x=reviewFixture(); const candidate=structuredClone(x.candidate); const record=candidate.records[0]!;
  record.output.entities[1]!.kind='place'; record.model.outputDigest=hash(record.output);
  const {digest:_recordDigest,...recordBody}=record; Object.assign(record,{digest:hash(recordBody)});
  // Re-assembly creates a valid candidate; only the human's mixed-kind group is wrong.
  return import('../src/candidate.js').then(({assembleBibleCandidate})=>{
    const valid=assembleBibleCandidate(x.source,x.plan,candidate.records,x.candidate.method);
    const decision={...x.decision,candidateDigest:valid.digest,groups:[{id:'all',name:'混合',memberIds:valid.entities.map(e=>e.id)}]};
    expect(()=>confirmBible(x.source,valid,decision,x.host)).toThrow();
  });
});
it.each([
  {actor:{kind:'agent',id:'research'}}, {actor:{kind:'human',id:'bad\n'}}, {tenantId:'other'}, {projectId:'other'},
  {at:'2026-11-16'}, {at:'2026-02-30T10:00:00.000Z'}, {authorize:()=>false}, {authorize:()=>{throw new Error('secret');}},
  {authorize:()=>Promise.resolve(true)}, {authorize:()=>1}, {authorize:undefined},
])('fails closed for untrusted or unauthorized hosts %j',patch=>{
  const x=reviewFixture(); expect(()=>confirmBible(x.source,x.candidate,x.decision,{...x.host,...patch} as ReviewHost)).toThrow('FORBIDDEN');
});
it('binds current source and exact candidate digest before asking for permission',()=>{
  const x=reviewFixture(); const authorize=vi.fn(()=>true); const host={...x.host,authorize};
  expect(()=>confirmBible({...x.source,revision:2},x.candidate,x.decision,host)).toThrow(); expect(authorize).not.toHaveBeenCalled();
  expect(()=>confirmBible(x.source,x.candidate,{...x.decision,candidateDigest:'a'.repeat(64)},host)).toThrow('CONFLICT');
  expect(()=>confirmBible(x.source,x.candidate,{...x.decision,approved:true},host)).toThrow(); expect(authorize).not.toHaveBeenCalled();
});
it('captures actor and choices before a trusted callback can mutate caller state',()=>{
  const x=reviewFixture(); const host={...x.host,authorize:()=>{x.decision.groups[0]!.name='被修改'; Object.assign(x.host.actor,{id:'other'});return true;}};
  const result=confirmBible(x.source,x.candidate,x.decision,host); expect(result.actorId).toBe('reviewer'); expect(result.entities[0]!.name).not.toBe('被修改');
});
it('records an explicit human rejection without adopting or rewriting any candidate',()=>{
  const x=reviewFixture(); const authorize=vi.fn(()=>true); const result=rejectBibleCandidate(x.source,x.candidate,'人物身份需要重新核对。',{...x.host,authorize});
  expect(result).toMatchObject({status:'rejected',candidateDigest:x.candidate.digest,actorId:'reviewer',reason:'人物身份需要重新核对。'});
  expect(authorize).toHaveBeenCalledWith({actorId:'reviewer',source:x.plan.source,action:'bible:reject'}); expect(x.candidate.status).toBe('candidate');
  expect(()=>rejectBibleCandidate(x.source,x.candidate,' ',x.host)).toThrow();
  expect(()=>rejectBibleCandidate(x.source,x.candidate,'x'.repeat(1001),x.host)).toThrow();
});
