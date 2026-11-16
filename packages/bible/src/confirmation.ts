import { z } from 'zod';
import { BibleError, Id, ReviewDecisionSchema, Text } from './contracts.js';
import type { BibleCandidate, ConfirmedBible, ConfirmedEntity, RejectedBible, ReviewDecision, ReviewHost, SourceInput, SourceIdentity } from './contracts.js';
import { captureSource, copy, freeze, hash, parse } from './data.js';
import { validateBibleCandidate } from './candidate.js';

const Host = z.strictObject({ actor: z.strictObject({kind:z.literal('human'),id:Id}),tenantId:Id,projectId:Id,at:z.string().max(24),
  authorize:z.custom<ReviewHost['authorize']>(value=>typeof value==='function') });
function reviewHost(input: ReviewHost, source: SourceIdentity, action: 'bible:confirm'|'bible:reject') {
  let host: z.infer<typeof Host>;
  try {
    host=parse(Host,input,'review host');
    if (host.tenantId!==source.tenantId || host.projectId!==source.projectId || new Date(host.at).toISOString()!==host.at) throw new Error();
  } catch { throw new BibleError('FORBIDDEN','review host'); }
  // Capture identity before authorization. A callback can neither replace the actor nor edit the frozen candidate.
  const actorId=host.actor.id; const at=host.at; const authorize=host.authorize;
  let allowed: unknown;
  try { allowed=authorize(freeze({actorId,source,action})); } catch { throw new BibleError('FORBIDDEN','review authorization'); }
  if (allowed!==true) {
    // Authorization is synchronous; observe a mistaken Promise rejection without treating it as approval.
    void Promise.resolve(allowed).catch(()=>{}); throw new BibleError('FORBIDDEN','review authorization');
  }
  return {actorId,at};
}
function unique(values: readonly string[], operation: string): void {
  if (new Set(values).size!==values.length) throw new BibleError('INVALID_INPUT',operation);
}
function order(a: string,b: string): number { return a<b?-1:a>b?1:0; }
function normalizeDecision(decision: ReviewDecision): ReviewDecision {
  return freeze({...decision,groups:decision.groups.map(group=>({...group,memberIds:[...group.memberIds].sort(order)})).sort((a,b)=>order(a.id,b.id)),
    rejectedEntityIds:[...decision.rejectedEntityIds].sort(order),selectedRelationIds:[...decision.selectedRelationIds].sort(order),selectedClaimIds:[...decision.selectedClaimIds].sort(order)});
}
/** Produce a knowledge snapshot only; the authenticated application must persist it, and IR adoption remains a separate service. */
export function confirmBible(currentSource: SourceInput, input: BibleCandidate, suppliedDecision: unknown, suppliedHost: ReviewHost): ConfirmedBible {
  const source=captureSource(currentSource); const candidate=validateBibleCandidate(source,input);
  const decision=normalizeDecision(parse(ReviewDecisionSchema,copy(suppliedDecision),'review decision'));
  if (decision.candidateDigest!==candidate.digest) throw new BibleError('CONFLICT','review candidate');
  unique(decision.groups.map(group=>group.id),'review group identity'); unique(decision.rejectedEntityIds,'rejected entity identity');
  unique(decision.selectedRelationIds,'selected relation identity'); unique(decision.selectedClaimIds,'selected claim identity');
  const originals=new Map(candidate.entities.map(entity=>[entity.id,entity])); const assigned=new Map<string,string|null>();
  for (const id of decision.rejectedEntityIds) {
    if (!originals.has(id)) throw new BibleError('INVALID_INPUT','rejected entity'); assigned.set(id,null);
  }
  const entities: ConfirmedEntity[]=[];
  for (const group of decision.groups) {
    const members=group.memberIds.map(id=>{
      const entity=originals.get(id);
      if (!entity || assigned.has(id)) throw new BibleError('INVALID_INPUT','review entity membership');
      assigned.set(id,group.id); return entity;
    });
    const kind=members[0]!.kind;
    if (members.some(entity=>entity.kind!==kind)) throw new BibleError('INVALID_INPUT','review entity kind');
    const aliases=[...new Set(members.flatMap(entity=>[entity.name,...entity.aliases]))].filter(name=>name!==group.name).sort(order);
    entities.push({id:group.id,kind,name:group.name,aliases,memberIds:group.memberIds,
      descriptions:members.map(entity=>({text:entity.description,evidence:entity.evidence}))});
  }
  if (assigned.size!==originals.size) throw new BibleError('INCOMPLETE','review entity decisions');
  const target = (id: string): string => {
    const mapped=assigned.get(id); if (!mapped) throw new BibleError('INVALID_INPUT','selected reference to rejected entity'); return mapped;
  };
  const byRelation=new Map(candidate.relations.map(value=>[value.id,value])); const byClaim=new Map(candidate.claims.map(value=>[value.id,value]));
  const relations=decision.selectedRelationIds.map(id=>{
    const value=byRelation.get(id); if (!value) throw new BibleError('INVALID_INPUT','selected relation');
    return {...value,from:target(value.from),to:target(value.to)};
  });
  const claims=decision.selectedClaimIds.map(id=>{
    const value=byClaim.get(id); if (!value) throw new BibleError('INVALID_INPUT','selected claim');
    return {...value,entityIds:[...new Set(value.entityIds.map(target))]};
  });
  const actor=reviewHost(suppliedHost,source.source,'bible:confirm');
  const body={version:1 as const,status:'confirmed' as const,source:source.source,candidateDigest:candidate.digest,decision,...actor,entities,relations,claims};
  return freeze(copy({...body,digest:hash(body)}));
}

export function rejectBibleCandidate(currentSource: SourceInput, input: BibleCandidate, suppliedReason: unknown, suppliedHost: ReviewHost): RejectedBible {
  const source=captureSource(currentSource); const candidate=validateBibleCandidate(source,input); const reason=parse(Text(1000),suppliedReason,'review reason');
  const actor=reviewHost(suppliedHost,source.source,'bible:reject');
  const body={version:1 as const,status:'rejected' as const,source:source.source,candidateDigest:candidate.digest,...actor,reason};
  return freeze({...body,digest:hash(body)});
}
