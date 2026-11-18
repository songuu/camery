import {expect,it,vi} from 'vitest';
import {ChangeSetV07,validatePackage} from '@camery/ir';
import {adoptChangeSet,createVersionState,submitChangeSet} from '@camery/versioning';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {prepareOutlineMappingDraft,finalizeOutlineChangeSet} from '../src/outline/node/formal-mapping.js';
import type {OutlineMappingDraft} from '../src/outline/node/formal-contracts.js';
import {readOutlineFormalProjection} from '../src/outline/node/formal-projection.js';
import {outlineFormalMappingFixture,outlineMappingInput,rereviewOutlineMapping,selectedOutlineProjection} from './outline-formal-mapping-support.js';

const finalize=(draft:OutlineMappingDraft,alias='outline-adopt')=>finalizeOutlineChangeSet({draft,changeSetId:id(alias),author:{kind:'user',id:id('outline-adopter')},operationIds:draft.operations.map(row=>({slot:row.slot,id:id(`${alias}:${row.slot}`)}))});
function adopt(f:Awaited<ReturnType<typeof outlineFormalMappingFixture>>,alias='outline-adopt'){
  const request=finalize(prepareOutlineMappingDraft(outlineMappingInput(f)),alias),state=createVersionState(f.head),pending=submitChangeSet(state,request);
  expect(pending.issues).toEqual([]);expect(pending.status).toBe('candidate');expect(pending.state.head).toEqual(f.head);
  const adopted=adoptChangeSet(pending.state,request.id,{actor:request.author,scope:{kind:'project',id:f.head.project.id},authorize:()=>true,at:'2026-11-18T10:00:00.000Z'});
  expect(adopted.issues).toEqual([]);expect(adopted.status).toBe('adopted');
  const head=adopted.state.head;if(head.schema_version!=='0.7.0-draft')throw new Error('Expected mapped v07 head');return {...adopted.state,head,request};
}
it('adopts every edited reviewed five-piece field through the real Versioning engine while preserving unrelated objects',async()=>{
  const f=await outlineFormalMappingFixture(),before=structuredClone(f.head),state=adopt(f),{projection,binding}=selectedOutlineProjection(state.head,f.identities);
  expect(ChangeSetV07.parse(state.request)).toEqual(state.request);expect(validatePackage(state.head).valid).toBe(true);
  expect(readOutlineFormalProjection(projection,binding)).toEqual(f.review.output);expect(projection.plan.adaptation.title).toBe('人工修订后采用的停钟之夜');expect(projection.plan.adaptation.title).not.toBe(f.progress.candidate!.output.adaptation.title);
  expect(projection.plan.source).toMatchObject({candidate_digest:f.progress.candidate!.digest,review_digest:f.review.digest,run_digest:f.run.digest,source_digest:f.run.source.digest,reviewer_key:f.review.actorId,reviewer_id:f.reviewer.id});
  expect(projection.plan.review.waivers).toHaveLength(f.review.waivers.length);expect(state.head.worlds).toEqual(before.worlds);expect(state.head.scenes).toEqual([]);expect(state.head.shots).toEqual([]);expect(state.head.assets).toEqual([]);expect(f.head).toEqual(before);
});
it('returns an immutable no-op draft for already adopted evidence without changing source or head',async()=>{
  const f=await outlineFormalMappingFixture(),state=adopt(f),before=structuredClone(state.head),draft=prepareOutlineMappingDraft({...outlineMappingInput(f),head:state.head});
  expect(draft.operations).toEqual([]);expect(draft.baseRevision).toBe(state.head.revision.number);expect(draft.baseRevisions.length).toBeGreaterThan(0);expect(Object.isFrozen(draft)).toBe(true);expect(Object.isFrozen(draft.operations)).toBe(true);expect(()=>finalize(draft)).toThrowError(expect.objectContaining({name:'OutlineError',code:'INCOMPLETE'}));expect(state.head).toEqual(before);
});
it('pins a re-reviewed complete plan epoch and all dependent references to their adopted versions',async()=>{
  const f=await outlineFormalMappingFixture(),initial=adopt(f),next=await rereviewOutlineMapping(f),state=adopt({...next,head:initial.head},'outline-rereview');
  const {projection,binding}=selectedOutlineProjection(state.head,next.identities);expect(readOutlineFormalProjection(projection,binding)).toEqual(next.review.output);expect(projection.plan.version).toBe(2);
  for(const rows of [projection.beats,projection.episodePlans,projection.assets,projection.plotUnits,projection.decisions])for(const row of rows){expect(row.version).toBe(2);expect(row.adaptation_plan).toEqual({id:projection.plan.id,version:2});}
  expect(projection.characters.every(row=>row.version===1)).toBe(true);expect(projection.episodes.every(row=>row.version===1)).toBe(true);expect(prepareOutlineMappingDraft({...outlineMappingInput(next),head:state.head}).operations).toEqual([]);
});
it('maps all legal cardinalities in one review over 1000 operations with exact output round-trip',async()=>{
  const f=await outlineFormalMappingFixture({capacity:true});expect(Buffer.byteLength(JSON.stringify(f.review.output))).toBeGreaterThan(490000);expect(Buffer.byteLength(JSON.stringify(f.review.output))).toBeLessThan(524288);expect(f.run.runId).toBe('capacity-outline-new-run');expect(f.run.brief.episodeCount).toBe(100);
  const draft=prepareOutlineMappingDraft(outlineMappingInput(f));expect(draft.operations.length).toBeGreaterThan(1000);const state=adopt(f,'outline-full-capacity'),{projection,binding}=selectedOutlineProjection(state.head,f.identities);
  expect(projection.characters).toHaveLength(64);expect(projection.beats).toHaveLength(500);expect(projection.episodes).toHaveLength(100);expect(projection.episodePlans).toHaveLength(100);expect(projection.assets).toHaveLength(256);expect(projection.plotUnits).toHaveLength(100);expect(projection.decisions).toHaveLength(128);expect(readOutlineFormalProjection(projection,binding)).toEqual(f.review.output);expect(validatePackage(state.head).valid).toBe(true);
  const next=await rereviewOutlineMapping(f),request=finalize(prepareOutlineMappingDraft({...outlineMappingInput(next),head:state.head}),'outline-full-capacity-rereview');expect(request.ops.length).toBeGreaterThan(1000);
  const pending=submitChangeSet(state,request);expect(pending.issues).toEqual([]);expect(pending.status).toBe('candidate');expect(pending.state.head).toEqual(state.head);
  const adopted=adoptChangeSet(pending.state,request.id,{actor:request.author,scope:{kind:'project',id:state.head.project.id},authorize:()=>true,at:'2026-11-18T10:01:00.000Z'});
  expect(adopted.issues).toEqual([]);expect(adopted.status).toBe('adopted');const head=adopted.state.head;if(head.schema_version!=='0.7.0-draft')throw new Error('Expected re-adopted v07 head');
  const revised=selectedOutlineProjection(head,next.identities);expect(revised.projection.plan.version).toBe(2);expect(revised.projection.plan.source.review_digest).toBe(next.review.digest);
  for(const rows of [revised.projection.beats,revised.projection.episodePlans,revised.projection.assets,revised.projection.plotUnits,revised.projection.decisions])for(const row of rows){expect(row.version).toBe(2);expect(row.adaptation_plan).toEqual({id:revised.projection.plan.id,version:2});}
  expect(revised.projection.characters).toEqual(projection.characters);expect(revised.projection.episodes).toEqual(projection.episodes);expect(readOutlineFormalProjection(revised.projection,revised.binding)).toEqual(next.review.output);expect(prepareOutlineMappingDraft({...outlineMappingInput(next),head}).operations).toEqual([]);expect(head.worlds).toEqual(f.head.worlds);expect(validatePackage(head).valid).toBe(true);expect(f.exchange).toHaveBeenCalledTimes(1);
},30000);
it.each(['characters','beats','assets','plotUnits','decisions'] as const)('rejects an incomplete %s local identity collection',async group=>{const f=await outlineFormalMappingFixture(),identities=structuredClone(f.identities);identities[group].pop();expect(()=>prepareOutlineMappingDraft({...outlineMappingInput(f),identities})).toThrowError(expect.objectContaining({name:'OutlineError'}));});
it('rejects unknown local identities, duplicate stable IDs and an episode coverage hole',async()=>{
  const f=await outlineFormalMappingFixture();for(const change of [(q:typeof f.identities)=>{q.characters[0]!.localId='unknown';},(q:typeof f.identities)=>{q.assets[0]!.id=q.beats[0]!.id;},(q:typeof f.identities)=>{q.episodes[0]!.number=99;}]){const identities=structuredClone(f.identities);change(identities);expect(()=>prepareOutlineMappingDraft({...outlineMappingInput(f),identities})).toThrowError(expect.objectContaining({name:'OutlineError'}));}
});
it('rejects incorrect source owner, tenant/project scope, target and reviewer binding',async()=>{
  const f=await outlineFormalMappingFixture();for(const change of [(q:typeof f.identities)=>{q.owner.runId='other';},(q:typeof f.identities)=>{q.owner.runDigest='b'.repeat(64);},(q:typeof f.identities)=>{q.tenantId='other';},(q:typeof f.identities)=>{q.projectId='other';},(q:typeof f.identities)=>{q.target.projectId=id('other-project');}]){const identities=structuredClone(f.identities);change(identities);expect(()=>prepareOutlineMappingDraft({...outlineMappingInput(f),identities})).toThrowError(expect.objectContaining({name:'OutlineError',code:'CONFLICT'}));}
  expect(()=>prepareOutlineMappingDraft({...outlineMappingInput(f),reviewer:{...f.reviewer,key:'different-reviewer'}})).toThrowError(expect.objectContaining({name:'OutlineError',code:'CONFLICT'}));
});
it('rejects binding a story identity onto an unrelated pre-existing object',async()=>{const f=await outlineFormalMappingFixture(),identities=structuredClone(f.identities);identities.characters[0]!.id=f.head.worlds[0]!.id;expect(()=>prepareOutlineMappingDraft({...outlineMappingInput(f),identities})).toThrowError(expect.objectContaining({name:'OutlineError',code:'CONFLICT'}));});
it.each([null,undefined,0])('rejects malformed mapping input %s with the outline domain error boundary',input=>{expect(()=>prepareOutlineMappingDraft(input as never)).toThrowError(expect.objectContaining({name:'OutlineError',code:'INVALID_INPUT'}));});
it('captures descriptors without executing untrusted accessors',async()=>{const f=await outlineFormalMappingFixture(),getter=vi.fn(()=>f.progress);expect(()=>prepareOutlineMappingDraft({...outlineMappingInput(f),get progress(){return getter();}})).toThrowError(expect.objectContaining({name:'OutlineError'}));expect(getter).not.toHaveBeenCalled();});
it('rejects missing, duplicate and reserved operation IDs when finalizing a concrete draft',async()=>{
  const f=await outlineFormalMappingFixture(),draft=prepareOutlineMappingDraft(outlineMappingInput(f)),operationIds=draft.operations.map(row=>({slot:row.slot,id:id(`finalize:${row.slot}`)})),input={draft,changeSetId:id('finalize-review'),author:{kind:'user' as const,id:id('outline-adopter')},operationIds};
  expect(()=>finalizeOutlineChangeSet({...input,operationIds:operationIds.slice(1)})).toThrowError(expect.objectContaining({name:'OutlineError'}));expect(()=>finalizeOutlineChangeSet({...input,operationIds:[operationIds[0]!,...operationIds.slice(1).map(row=>({...row,id:operationIds[0]!.id}))]})).toThrowError(expect.objectContaining({name:'OutlineError'}));expect(()=>finalizeOutlineChangeSet({...input,changeSetId:f.identities.planId})).toThrowError(expect.objectContaining({name:'OutlineError'}));
});
it('rejects replacement base revisions or operation slots that diverge from the prepared intent',async()=>{
  const f=await outlineFormalMappingFixture(),initial=adopt(f),next=await rereviewOutlineMapping(f),original=prepareOutlineMappingDraft({...outlineMappingInput(next),head:initial.head});
  expect(original.baseRevisions.some(row=>row.id===f.identities.planId&&row.version===1)).toBe(true);
  for(const change of [(draft:OutlineMappingDraft)=>{draft.baseRevisions.push({...draft.baseRevisions[0]!});},(draft:OutlineMappingDraft)=>{draft.baseRevisions=[];},(draft:OutlineMappingDraft)=>{draft.operations[0]!.slot='unbound-operation';},(draft:OutlineMappingDraft)=>{const row=draft.operations.find(row=>row.op.op==='replace')!;if(row.op.op==='replace')row.op.value['version']=99;}]){const draft=structuredClone(original);change(draft);expect(()=>finalize(draft,'invalid-concrete-draft')).toThrowError(expect.objectContaining({name:'OutlineError',code:'CONFLICT'}));}
});
