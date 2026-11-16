import { describe, expect, it } from 'vitest';
import type { BibleCandidateView } from '@camery/bible/http';
import { initialBibleDraft, mergeBibleGroups, splitBibleGroup, toggleBibleEntity, renameBibleGroup, toggleBibleSelection, inspectBibleDraft, bibleDecision, removeRejectedReferences } from '../src/bible-review-state.js';

export const bibleCandidate = (): BibleCandidateView => ({ digest:'a'.repeat(64),
  entities:[['a','林舟','character'],['b','林舟','character'],['c','北港','place']].map(([id,name,kind])=>({id:id!,name:name!,kind:kind as 'character'|'place',aliases:[],description:'保留不同来源的描述',chunkId:'chunk',evidence:[{start:0,end:2,quote:'林舟'}]})),
  relations:[{id:'r',chunkId:'chunk',from:'a',to:'c',label:'到达',evidence:[{start:0,end:2,quote:'林舟'}]}],
  claims:[{id:'f',chunkId:'chunk',kind:'fact',text:'来到北港',entityIds:['a'],evidence:[{start:0,end:2,quote:'林舟'}]}],
  mergeSuggestions:[{entityIds:['a','b'],reason:'name_or_alias_overlap'}] });

describe('explicit Bible review decisions',()=>{
  it('keeps group identities unique after merge, reject, restore, merge and split',()=>{
    const candidate=bibleCandidate();candidate.entities.forEach(entity=>{entity.kind='character';});
    let draft=mergeBibleGroups(candidate,initialBibleDraft(candidate),['g-0','g-1']);
    draft=toggleBibleEntity(candidate,draft,'a',false);draft=toggleBibleEntity(candidate,draft,'a',true);
    const restored=draft.groups.find(group=>group.memberIds.includes('a'))!;
    draft=mergeBibleGroups(candidate,draft,['g-2',restored.id]);
    draft=splitBibleGroup(candidate,draft,'g-2');
    expect(new Set(draft.groups.map(group=>group.id)).size).toBe(3);
    expect(inspectBibleDraft(candidate,draft).valid).toBe(true);
    expect(draft.groups.flatMap(group=>group.memberIds).sort()).toEqual(['a','b','c']);
  });
  it('keeps every entity separate until a user merges, retains every relation and claim',()=>{
    const candidate=bibleCandidate(); const draft=initialBibleDraft(candidate);
    expect(draft.groups.map(group=>group.memberIds)).toEqual([['a'],['b'],['c']]);
    expect(bibleDecision(candidate,draft)).toMatchObject({candidateDigest:candidate.digest,rejectedEntityIds:[],selectedRelationIds:['r'],selectedClaimIds:['f']});
    expect(inspectBibleDraft(candidate,draft)).toMatchObject({valid:true,invalidRelationIds:[],invalidClaimIds:[]});
  });
  it('merges only same-kind groups explicitly and permits splitting without deleting descriptions',()=>{
    const candidate=bibleCandidate(); const original=initialBibleDraft(candidate);
    expect(mergeBibleGroups(candidate,original,['g-0','g-2'])).toBe(original);
    expect(mergeBibleGroups(candidate,original,['g-0'])).toBe(original);
    expect(mergeBibleGroups(candidate,original,['g-0','absent'])).toBe(original);
    const merged=mergeBibleGroups(candidate,original,['g-0','g-1']);
    expect(merged.groups).toHaveLength(2); expect(merged.groups[0]?.memberIds).toEqual(['a','b']);
    expect(original.groups).toHaveLength(3); expect(candidate.entities).toHaveLength(3);
    expect(splitBibleGroup(candidate,merged,'g-0').groups.map(group=>group.memberIds)).toEqual([['a'],['b'],['c']]);
    expect(splitBibleGroup(candidate,original,'missing')).toBe(original);
    expect(splitBibleGroup(candidate,original,'g-0')).toBe(original);
  });
  it('never silently removes selected references when an entity is rejected',()=>{
    const candidate=bibleCandidate(); const draft=toggleBibleEntity(candidate,initialBibleDraft(candidate),'a',false);
    expect(draft.selectedRelationIds).toEqual(['r']); expect(draft.selectedClaimIds).toEqual(['f']);
    expect(inspectBibleDraft(candidate,draft)).toMatchObject({valid:false,invalidRelationIds:['r'],invalidClaimIds:['f']});
    expect(bibleDecision(candidate,draft)).toBeNull();
    const explicit=removeRejectedReferences(candidate,draft);
    expect(bibleDecision(candidate,explicit)).toMatchObject({rejectedEntityIds:['a'],selectedRelationIds:[],selectedClaimIds:[]});
    expect(toggleBibleEntity(candidate,draft,'a',true).groups.at(-1)?.memberIds).toEqual(['a']);
    expect(toggleBibleEntity(candidate,draft,'missing',true)).toBe(draft);
    expect(toggleBibleEntity(candidate,draft,'a',false)).toBe(draft);
    expect(toggleBibleEntity(candidate,initialBibleDraft(candidate),'a',true).groups).toHaveLength(3);
  });
  it('handles group members, names and explicit relation and claim choices without mutating prior drafts',()=>{
    const candidate=bibleCandidate(); let draft=mergeBibleGroups(candidate,initialBibleDraft(candidate),['g-0','g-1']);
    draft=toggleBibleEntity(candidate,draft,'a',false); expect(draft.groups[0]?.memberIds).toEqual(['b']);
    draft=renameBibleGroup(draft,'g-0','另一位林舟'); expect(draft.groups[0]?.name).toBe('另一位林舟');
    draft=toggleBibleSelection(draft,'relation','r',false); draft=toggleBibleSelection(draft,'claim','f',false);
    expect(bibleDecision(candidate,draft)).not.toBeNull();
    expect(toggleBibleSelection(draft,'relation','r',true).selectedRelationIds).toEqual(['r']);
    expect(toggleBibleSelection(draft,'claim','f',true).selectedClaimIds).toEqual(['f']);
    expect(toggleBibleSelection(draft,'claim','f',false).selectedClaimIds).toEqual([]);
    expect(renameBibleGroup(draft,'missing','无变化')).toEqual(draft);
    expect(bibleDecision(candidate,renameBibleGroup(draft,'g-0','   '))).toBeNull();
  });
  it('rejects missing, duplicated, foreign and mixed-kind membership and unknown associations',()=>{
    const candidate=bibleCandidate(); const draft=initialBibleDraft(candidate);
    for (const invalid of [
      {...draft,groups:draft.groups.slice(1)},
      {...draft,groups:[...draft.groups,draft.groups[0]!]},
      {...draft,rejectedEntityIds:['a']},
      {...draft,rejectedEntityIds:['unknown']},
      {...draft,groups:[{id:'g',name:'混合',memberIds:['a','b','c']}]},
      {...draft,groups:[{id:'g',name:'空',memberIds:[]},...draft.groups]},
      {...draft,selectedRelationIds:['r','r']},
      {...draft,selectedClaimIds:['f','unknown']},
      {...draft,selectedRelationIds:['unknown']},
      {...draft,groups:[{...draft.groups[0]!,name:'\0'},...draft.groups.slice(1)]},
    ]) expect(bibleDecision(candidate,invalid)).toBeNull();
  });
  it('restores an already confirmed decision and never aliases its mutable arrays',()=>{
    const candidate=bibleCandidate(); const decision=bibleDecision(candidate,initialBibleDraft(candidate))!;
    const restored=initialBibleDraft(candidate,decision); restored.groups[0]!.memberIds.push('change');
    expect(decision.groups[0]?.memberIds).toEqual(['a']);
    expect(bibleDecision({...candidate,entities:[],relations:[],claims:[],mergeSuggestions:[]},initialBibleDraft({...candidate,entities:[],relations:[],claims:[],mergeSuggestions:[]}))).not.toBeNull();
  });
});
