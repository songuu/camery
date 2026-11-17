import {expect,it} from 'vitest';
import {episodeFixture} from '../../script/test/episode-fixture.js';
import {inspectFoundationDraft,inspectEpisodeDraft,developmentDraft,developmentDecision,developmentRedoRequest,developmentRedoReason} from '../src/development-review-state.js';
import type {DevelopmentRedo,DevelopmentRunView} from '@camery/script/http';
it('keeps edits separate from the original and retains exact approved output',()=>{
  const f=episodeFixture();const draft=developmentDraft(f.foundation);draft.title='人工编辑';expect(f.foundation.title).not.toBe(draft.title);
  expect(inspectFoundationDraft(draft).valid).toBe(true);expect(developmentDecision('foundation','a'.repeat(64),draft,f.brief,f.foundation)).toEqual({candidateDigest:'a'.repeat(64),output:draft});
});
it('keeps the exact redo request until acknowledged and never invents an inherited review',()=>{
  const f=episodeFixture();const source:Pick<DevelopmentRunView,'runId'|'runDigest'|'brief'|'foundation'>={runId:'source',runDigest:'a'.repeat(64),brief:f.brief,foundation:{candidate:null,review:null}};const pending=new Map<string,DevelopmentRedo>();let ids=0;const next=()=>`redo-${++ids}`;
  expect(developmentRedoRequest(pending,source,'episodes',next)).toBeNull();expect(ids).toBe(0);
  const first=developmentRedoRequest(pending,source,'foundation',next)!;expect(first.command.expectedFoundationReviewDigest).toBeNull();expect(developmentRedoRequest(pending,source,'foundation',next)).toEqual(first);expect(ids).toBe(1);
  pending.delete(first.key);expect(developmentRedoRequest(pending,source,'foundation',next)!.command.runId).toBe('redo-2');
  source.foundation.review={status:'reviewed',digest:'b'.repeat(64),actorId:'original-human',at:'2026-11-16T12:00:00.000Z',output:f.foundation};
  const episodes=developmentRedoRequest(pending,source,'episodes',next)!;expect(episodes.command).toEqual({runId:'redo-3',expectedSourceRunDigest:source.runDigest,expectedBriefDigest:f.brief.digest,expectedFoundationReviewDigest:'b'.repeat(64)});expect(developmentRedoRequest(pending,source,'episodes',next)).toEqual(episodes);expect(ids).toBe(3);
  const invalid=new Map<string,DevelopmentRedo>();expect(developmentRedoRequest(invalid,source,'foundation',()=>source.runId)).toBeNull();expect(developmentRedoRequest(invalid,source,'foundation',()=>'/invalid')).toBeNull();expect(invalid.size).toBe(0);
});
it('explains every server redo gate without offering automatic retries',()=>{
  for(const reason of ['MODEL_UNAVAILABLE','BRIEF_CHANGED','UPSTREAM_NOT_REVIEWED','STAGE_NOT_FINISHED','UNKNOWN_RESULT','RUN_IN_PROGRESS'] as const)expect(developmentRedoReason(reason)).toBeTruthy();expect(developmentRedoReason(null)).toBeNull();expect(developmentRedoReason('UNKNOWN_RESULT')).toContain('对账');
});
it('rejects duplicate/dangling identities, self relations and an unbound protagonist',()=>{
  const f=episodeFixture();const duplicate=developmentDraft(f.foundation);duplicate.characters.push({...duplicate.characters[0]!});expect(inspectFoundationDraft(duplicate).valid).toBe(false);
  for(const change of [(x:typeof f.foundation)=>{x.mainline.characterIds=['missing'];},(x:typeof f.foundation)=>{x.relationships[0]!.to=x.relationships[0]!.from;},(x:typeof f.foundation)=>{x.characters.forEach(c=>{c.function='supporting';});}]){const x=developmentDraft(f.foundation);change(x);expect(inspectFoundationDraft(x).valid).toBe(false);}
});
it('checks exact episodes, order, retained references and season protagonist',()=>{
  const f=episodeFixture();expect(inspectEpisodeDraft(f.output,f.brief,f.foundation).valid).toBe(true);
  const x=developmentDraft(f.output);x.episodes[0]!.characterIds=['missing'];expect(inspectEpisodeDraft(x,f.brief,f.foundation).valid).toBe(false);
  x.episodes[0]!.number=2;expect(developmentDecision('episodes','a'.repeat(64),x,f.brief,f.foundation)).toBeNull();
  expect(inspectEpisodeDraft({episodes:[]},f.brief,f.foundation).valid).toBe(false);
});
it('rejects complete byte excess and invalid fields before submission',()=>{
  const f=episodeFixture();const x=developmentDraft(f.foundation);x.characters=Array.from({length:32},(_,i)=>({...x.characters[0]!,id:`c-${i}`,arc:'海'.repeat(1000)}));
  expect(inspectFoundationDraft(x).valid).toBe(false);expect(inspectFoundationDraft({...f.foundation,title:''}).valid).toBe(false);
});
it('does not rewrite invalid selections or silently remove stale references',()=>{
  const f=episodeFixture();const rules=developmentDraft(f.foundation);rules.world.rules.push({...rules.world.rules[0]!});expect(inspectFoundationDraft(rules).valid).toBe(false);
  const refs=developmentDraft(f.foundation);refs.mainline.ruleIds=['unknown'];expect(inspectFoundationDraft(refs).issues.join()).toContain('引用');
  refs.mainline.ruleIds=['tide','tide'];expect(inspectFoundationDraft(refs).valid).toBe(false);expect(refs.mainline.ruleIds).toEqual(['tide','tide']);
  const relation=developmentDraft(f.foundation);relation.relationships[0]!.from='unknown';expect(inspectFoundationDraft(relation).valid).toBe(false);
});
it('requires protagonist participation, valid per-episode rule references and bounded season content',()=>{
  const f=episodeFixture();const x=developmentDraft(f.output);x.episodes.forEach(e=>{e.characterIds=['mei'];});expect(inspectEpisodeDraft(x,f.brief,f.foundation).issues.join()).toContain('主角');
  x.episodes[0]!.ruleIds=['unknown'];expect(inspectEpisodeDraft(x,f.brief,f.foundation).issues.join()).toContain('规则');
  const oversized=developmentDraft(f.output);oversized.episodes=Array.from({length:100},(_,i)=>({...oversized.episodes[0]!,number:i+1,summary:'海'.repeat(1200)}));expect(inspectEpisodeDraft(oversized,{episodeCount:100},f.foundation).issues.join()).toContain('KiB');
  expect(developmentDecision('episodes','a'.repeat(64),f.output,f.brief,f.foundation)).toEqual({candidateDigest:'a'.repeat(64),output:f.output});expect(developmentDecision('foundation','invalid',f.foundation,f.brief,f.foundation)).toBeNull();
});
