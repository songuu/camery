import {expect,it,vi} from 'vitest';
import {screenplayFixture} from './screenplay-support.js';
import {createScreenplayCandidate,validateScreenplayCandidate,reviewScreenplayCandidate,validateScreenplayReview} from '../src/screenplay/node/review.js';
function fixture(){const f=screenplayFixture();const scope={tenantId:'tenant',projectId:'project'};const candidate=createScreenplayCandidate(scope,f.context,f.draft);const host={actor:{kind:'human' as const,id:'editor'},scope,at:'2026-11-19T05:00:00.000Z',authorize:vi.fn(()=>true)};return {...f,scope,candidate,host};}
it('retains the original candidate and recompiles human edits with individually located warning decisions',()=>{
  const f=fixture(),draft=structuredClone(f.draft);draft.scenes[0]!.beats[1]!.lines[0]!.text='逐字保留人工修改。';
  const modified=createScreenplayCandidate(f.scope,f.context,draft),waivers=modified.issues.filter(row=>row.severity==='warning').map(row=>({issueId:row.id,reason:'人工逐条确认创作选择。'}));
  const review=reviewScreenplayCandidate(f.context,f.candidate,{candidateDigest:f.candidate.digest,draft,waivers},f.host);
  expect(review.output.draft).toEqual(draft);expect(review.candidateDigest).toBe(f.candidate.digest);expect(review.output.digest).toBe(modified.digest);
  expect(validateScreenplayReview(f.context,f.candidate,review)).toEqual(review);expect(validateScreenplayCandidate(f.context,f.candidate)).toEqual(f.candidate);
  expect(f.candidate.draft).toEqual(f.draft);expect(Object.isFrozen(review.output)).toBe(true);
});
it.each(['missing','duplicate','unknown','error','candidate','digest','context','host','scope','async','thenable'] as const)('refuses %s and never infers human approval',mode=>{
  const f=fixture(),draft=structuredClone(f.draft),waivers=f.candidate.issues.filter(row=>row.severity==='warning').map(row=>({issueId:row.id,reason:'显式人工决定。'}));
  const decision={candidateDigest:f.candidate.digest,draft,waivers};
  if(mode==='missing')waivers.pop();if(mode==='duplicate')waivers.push(waivers[0]!);if(mode==='unknown')waivers[0]!.issueId='unknown';
  if(mode==='error')draft.openingHook=null;if(mode==='candidate')decision.candidateDigest='b'.repeat(64);
  if(mode==='digest')f.candidate={...f.candidate,digest:'b'.repeat(64)};
  if(mode==='context')f.context.snapshotRevision++;
  if(mode==='host')Object.defineProperty(f.host,'actor',{get:()=>{throw new Error('secret');}});
  if(mode==='scope')f.host.scope={...f.scope,tenantId:'other'};
  if(mode==='async')f.host.authorize=vi.fn(async()=>true) as never;
  if(mode==='thenable')f.host.authorize=vi.fn(()=>({then(){throw new Error('do not evaluate');}})) as never;
  expect(()=>reviewScreenplayCandidate(f.context,f.candidate,decision,f.host)).toThrow();
});
it('refuses mutated review bodies even when an unkeyed checksum could be recomputed',()=>{
  const f=fixture(),decision={candidateDigest:f.candidate.digest,draft:f.draft,waivers:f.candidate.issues.filter(row=>row.severity==='warning').map(row=>({issueId:row.id,reason:'人工明确保留。'}))};
  const review=reviewScreenplayCandidate(f.context,f.candidate,decision,f.host);
  expect(()=>validateScreenplayReview(f.context,f.candidate,{...review,digest:'b'.repeat(64)})).toThrow();
});
it('captures context and human decision before a deployment grant callback can mutate caller objects',()=>{
  const f=fixture(),context=structuredClone(f.context),decision={candidateDigest:f.candidate.digest,draft:structuredClone(f.draft),waivers:f.candidate.issues.filter(row=>row.severity==='warning').map(row=>({issueId:row.id,reason:'人工逐项确认。'}))},draft=structuredClone(decision.draft);
  f.host.authorize=vi.fn(()=>{f.context.episode.title='回调修改上下文';decision.draft.title='回调修改人改稿';return true;});
  const review=reviewScreenplayCandidate(f.context,f.candidate,decision,f.host);expect(review.output.contextDigest).toBe(f.candidate.contextDigest);expect(review.output.draft).toEqual(draft);expect(validateScreenplayReview(context,f.candidate,review)).toEqual(review);
});
