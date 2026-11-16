import { BibleConfirmSchema, boundedBibleSchema, type BibleCandidateView, type BibleConfirm } from '@camery/bible/http';

export type BibleDraft = Omit<BibleConfirm,'candidateDigest'>;
export function initialBibleDraft(candidate:BibleCandidateView, decision?:BibleConfirm|null):BibleDraft {
  return decision ? {groups:decision.groups.map(group=>({...group,memberIds:[...group.memberIds]})),rejectedEntityIds:[...decision.rejectedEntityIds],
    selectedRelationIds:[...decision.selectedRelationIds],selectedClaimIds:[...decision.selectedClaimIds]} : {
    groups:candidate.entities.map((entity,index)=>({id:`g-${index}`,name:entity.name,memberIds:[entity.id]})),rejectedEntityIds:[],
    selectedRelationIds:candidate.relations.map(relation=>relation.id),selectedClaimIds:candidate.claims.map(claim=>claim.id)};
}
export function mergeBibleGroups(candidate:BibleCandidateView,draft:BibleDraft,ids:string[]):BibleDraft {
  const selected=draft.groups.filter(group=>ids.includes(group.id));
  if (selected.length<2 || selected.length!==new Set(ids).size) return draft;
  const entities=new Map(candidate.entities.map(entity=>[entity.id,entity]));
  const members=selected.flatMap(group=>group.memberIds);
  if (new Set(members.map(id=>entities.get(id)?.kind)).size!==1) return draft;
  const first=selected[0]!;
  return {...draft,groups:draft.groups.flatMap(group=>group.id===first.id?[{...group,memberIds:members}]:ids.includes(group.id)?[]:[group])};
}
export function splitBibleGroup(candidate:BibleCandidateView,draft:BibleDraft,id:string):BibleDraft {
  const group=draft.groups.find(item=>item.id===id);
  if (!group || group.memberIds.length<2) return draft;
  const used=new Set(draft.groups.filter(item=>item.id!==id).map(item=>item.id));
  return {...draft,groups:draft.groups.flatMap(item=>item.id!==id?[item]:item.memberIds.map(member=>{
    const index=candidate.entities.findIndex(entity=>entity.id===member);
    let groupId=`g-${index}`;let suffix=0;
    while(used.has(groupId))groupId=`g-${index}-${++suffix}`;
    used.add(groupId);
    return {id:groupId,name:candidate.entities[index]!.name,memberIds:[member]};
  }))};
}
export function toggleBibleEntity(candidate:BibleCandidateView,draft:BibleDraft,id:string,keep:boolean):BibleDraft {
  const index=candidate.entities.findIndex(entity=>entity.id===id);
  if (index===-1 || draft.rejectedEntityIds.includes(id)!==keep) return draft;
  if (keep) {
    // Restoring one member must not silently recreate a prior merge.
    const used=new Set(draft.groups.map(group=>group.id)); let groupId=`g-${index}`;let suffix=0;
    while (used.has(groupId)) groupId=`g-${index}-${++suffix}`;
    return {...draft,rejectedEntityIds:draft.rejectedEntityIds.filter(member=>member!==id),
      groups:[...draft.groups,{id:groupId,name:candidate.entities[index]!.name,memberIds:[id]}]};
  }
  return {...draft,rejectedEntityIds:[...draft.rejectedEntityIds,id],
    groups:draft.groups.map(group=>({...group,memberIds:group.memberIds.filter(member=>member!==id)})).filter(group=>group.memberIds.length>0)};
}
export function renameBibleGroup(draft:BibleDraft,id:string,name:string):BibleDraft {
  return {...draft,groups:draft.groups.map(group=>group.id===id?{...group,name}:group)};
}
export function toggleBibleSelection(draft:BibleDraft,kind:'relation'|'claim',id:string,keep:boolean):BibleDraft {
  const field=kind==='relation'?'selectedRelationIds':'selectedClaimIds';
  const selected=draft[field].filter(member=>member!==id);
  return {...draft,[field]:keep?[...selected,id]:selected};
}
export function inspectBibleDraft(candidate:BibleCandidateView,draft:BibleDraft) {
  const rejected=new Set(draft.rejectedEntityIds);
  const invalidRelationIds=candidate.relations.filter(item=>draft.selectedRelationIds.includes(item.id) && (rejected.has(item.from)||rejected.has(item.to))).map(item=>item.id);
  const invalidClaimIds=candidate.claims.filter(item=>draft.selectedClaimIds.includes(item.id) && item.entityIds.some(id=>rejected.has(id))).map(item=>item.id);
  const partition=[...draft.groups.flatMap(group=>group.memberIds),...draft.rejectedEntityIds];
  const entities=new Map(candidate.entities.map(entity=>[entity.id,entity]));
  const relationIds=new Set(candidate.relations.map(item=>item.id)); const claimIds=new Set(candidate.claims.map(item=>item.id));
  const parsed=boundedBibleSchema(BibleConfirmSchema).safeParse({candidateDigest:candidate.digest,...draft});
  const valid=parsed.success && partition.length===entities.size && new Set(partition).size===entities.size && partition.every(id=>entities.has(id)) &&
    new Set(draft.groups.map(group=>group.id)).size===draft.groups.length &&
    draft.groups.every(group=>new Set(group.memberIds.map(id=>entities.get(id)?.kind)).size===1) &&
    new Set(draft.selectedRelationIds).size===draft.selectedRelationIds.length && draft.selectedRelationIds.every(id=>relationIds.has(id)) &&
    new Set(draft.selectedClaimIds).size===draft.selectedClaimIds.length && draft.selectedClaimIds.every(id=>claimIds.has(id)) &&
    invalidRelationIds.length===0 && invalidClaimIds.length===0;
  return {valid,invalidRelationIds,invalidClaimIds};
}
export function bibleDecision(candidate:BibleCandidateView,draft:BibleDraft):BibleConfirm|null {
  if (!inspectBibleDraft(candidate,draft).valid) return null;
  return boundedBibleSchema(BibleConfirmSchema).parse({candidateDigest:candidate.digest,...draft});
}
/** Only called by the explicit discard-associations action; rejecting an entity alone preserves selections. */
export function removeRejectedReferences(candidate:BibleCandidateView,draft:BibleDraft):BibleDraft {
  const issues=inspectBibleDraft(candidate,draft);
  return {...draft,selectedRelationIds:draft.selectedRelationIds.filter(id=>!issues.invalidRelationIds.includes(id)),
    selectedClaimIds:draft.selectedClaimIds.filter(id=>!issues.invalidClaimIds.includes(id))};
}
