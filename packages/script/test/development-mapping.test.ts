import {expect,it,vi} from 'vitest';
import {createVersionState,submitChangeSet,adoptChangeSet} from '@camery/versioning';
import {validatePackage} from '@camery/ir';
import {fixtureId as id,makePackage} from '../../ir/test/fixtures';
import {prepareDevelopmentDraft,finalizeDevelopmentChangeSet} from '../src/node/development-mapping.js';
import type {DevelopmentMappingDraft} from '../src/node/development-mapping.js';
import {developmentRunDigest} from '../src/node/contracts.js';
import {createFoundationCandidate,createEpisodeCandidate} from '../src/development.js';
import type {ReviewedDevelopment} from '../src/contracts.js';
import {mappingFixture} from './development-mapping-fixture.js';

function finalize(draft:DevelopmentMappingDraft,alias='mapping-change'){
  return finalizeDevelopmentChangeSet({draft,changeSetId:id(alias),author:{kind:'user',id:id('adopter')},operationIds:draft.operations.map(row=>({slot:row.slot,id:id(alias+row.slot)}))});
}
function adopt(input:Awaited<ReturnType<typeof mappingFixture>>,alias='mapping-change'){
  const request=finalize(prepareDevelopmentDraft(input),alias);const submitted=submitChangeSet(createVersionState(input.head),request);expect(submitted.issues).toEqual([]);
  const result=adoptChangeSet(submitted.state,request.id,{actor:request.author,scope:{kind:'project',id:input.head.project.id},at:'2026-11-17T05:00:00.000Z',authorize:()=>true});expect(result.issues).toEqual([]);
  if(result.state.head.schema_version!=='0.6.0-draft')throw new Error('Expected mapped formal schema');return {...result.state,head:result.state.head};
}

it('maps all reviewed development fields to complete typed IR through the unchanged engine',async()=>{
  const input=await mappingFixture();const draft=prepareDevelopmentDraft(input);const request=finalizeDevelopmentChangeSet({draft,changeSetId:id('full-mapping-change'),author:{kind:'user',id:id('adopter')},operationIds:draft.operations.map(row=>({slot:row.slot,id:id('op-'+row.slot)}))});
  const submitted=submitChangeSet(createVersionState(input.head),request);expect(submitted.issues).toEqual([]);expect(submitted.status).toBe('candidate');
  const adopted=adoptChangeSet(submitted.state,request.id,{actor:request.author,scope:{kind:'project',id:input.head.project.id},at:'2026-11-17T05:00:00.000Z',authorize:()=>true});expect(adopted.issues).toEqual([]);expect(adopted.status).toBe('adopted');
  const head=adopted.state.head;if(head.schema_version!=='0.6.0-draft')throw new Error('Expected complete schema');expect(validatePackage(head).valid).toBe(true);
  const foundation=input.progress.foundation.review!;const episodeReview=input.progress.episodes.review!;if(foundation.status!=='reviewed'||episodeReview.status!=='reviewed')throw new Error('Expected actual host reviews');
  expect(head.worlds[0]).toEqual({id:input.identities.worldId,version:1,setting:foundation.output.world.setting,era:foundation.output.world.era,rules:foundation.output.world.rules.map(rule=>({key:rule.id,text:rule.text}))});
  expect(head.characters).toHaveLength(foundation.output.characters.length);expect(head.characters[0]!.development).toEqual({function:foundation.output.characters[0]!.function,desire:foundation.output.characters[0]!.desire,obstacle:foundation.output.characters[0]!.obstacle,arc:foundation.output.characters[0]!.arc});
  expect(head.development_plans[0]!.mainline.progression).toBe(foundation.output.mainline.progression);expect(head.development_plans[0]!.source).toMatchObject({reviewer_key:foundation.actorId,reviewed_at:foundation.at,candidate_digest:foundation.candidateDigest,review_digest:foundation.digest,run_id:input.progress.run.runId});
  expect(head.episode_plans.map(plan=>({summary:plan.summary,goal:plan.goal,conflict:plan.conflict,turn:plan.turn,ending:plan.ending}))).toEqual(episodeReview.output.episodes.map(episode=>({summary:episode.summary,goal:episode.goal,conflict:episode.conflict,turn:episode.turn,ending:episode.ending})));
  expect(head.scenes).toEqual([]);expect(head.shots).toEqual([]);expect(head.assets).toEqual([]);
});
it('returns a real unchanged draft while retaining every existing dependency as a base',async()=>{
  const input=await mappingFixture();const state=adopt(input);const draft=prepareDevelopmentDraft({...input,head:state.head});
  expect(draft.operations).toEqual([]);expect(draft.baseRevision).toBe(state.head.revision.number);expect(draft.baseRevisions).toHaveLength(11);expect(draft.baseRevisions.every(ref=>ref.version===1)).toBe(true);
  expect(()=>finalize(draft)).toThrowError(expect.objectContaining({code:'INCOMPLETE'}));expect(Object.isFrozen(draft.operations)).toBe(true);
});
it('keeps same-name source characters independent and maps local constructor keys as data',async()=>{
  const input=await mappingFixture({constructorId:true});const state=adopt(input);expect(state.head.characters.filter(character=>character.name==='林舟')).toHaveLength(2);
  expect(new Set(state.head.characters.map(character=>character.id)).size).toBe(3);expect(state.head.worlds[0]!.rules[0]!.key).toBe('constructor');expect(state.head.development_plans[0]!.open_questions[0]!.key).toBe('constructor');
  expect(state.head.episode_plans[0]!.rule_refs[0]).toEqual({world_id:input.identities.worldId,key:'constructor'});
});
it('preserves voice and existing role while pinning all parents to predicted changed versions',async()=>{
  const input=await mappingFixture();const state=adopt(input);const original=makePackage();const voiceRef=original.asset_references.find(ref=>ref.id===id('ar_voice'))!;const voice=original.assets.find(asset=>asset.id===voiceRef.asset_id)!;const character=state.head.characters[0]!;
  const manual={schema_version:'0.6.0-draft' as const,id:id('manual-voice'),base_revision:state.head.revision.number,author:{kind:'user' as const,id:id('adopter')},status:'candidate' as const,base_revisions:[{id:character.id,version:character.version}],ops:[
    {op:'add' as const,op_id:id('add-voice'),collection:'assets' as const,value:voice},{op:'add' as const,op_id:id('add-voice-ref'),collection:'asset_references' as const,value:voiceRef},
    {op:'update' as const,op_id:id('custom-character'),collection:'characters' as const,target:character.id,set:{role:'人工角色说明',default_voice_ref_id:voiceRef.id,development:{...character.development!,desire:'人工写入后待本次采用明确覆盖。'}}},
  ]};
  const pending=submitChangeSet(state,manual);expect(pending.issues).toEqual([]);const edited=adoptChangeSet(pending.state,manual.id,{actor:manual.author,scope:{kind:'project',id:input.head.project.id},at:'2026-11-17T05:01:00.000Z',authorize:()=>true});expect(edited.issues).toEqual([]);
  const draft=prepareDevelopmentDraft({...input,head:edited.state.head});const applied=submitChangeSet(edited.state,finalize(draft,'restore-reviewed-story'));expect(applied.issues).toEqual([]);const preview=applied.state.changes.at(-1)!.preview!;if(preview.schema_version!=='0.6.0-draft')throw new Error('Expected schema6');
  const mapped=preview.characters.find(row=>row.id===character.id)!;expect(mapped.role).toBe('人工角色说明');expect(mapped.default_voice_ref_id).toBe(voiceRef.id);expect(mapped.version).toBe(3);
  const plan=preview.development_plans[0]!;expect(plan.version).toBe(2);expect(plan.characters.find(ref=>ref.id===mapped.id)!.version).toBe(3);
  for(const episode of preview.episode_plans){expect(episode.development_plan).toEqual({id:plan.id,version:2});expect(episode.characters.find(ref=>ref.id===mapped.id)!.version).toBe(3);}
  expect(preview.assets).toEqual([voice]);expect(preview.asset_references).toEqual([voiceRef]);
});
it('retains old foundation objects during a complete redo and repoints only the stable plan and episode slots',async()=>{
  const first=await mappingFixture({runId:'old-owner'});const state=adopt(first);const next=await mappingFixture({runId:'new-owner'});const result=adopt({...next,head:state.head},'full-redo-mapping');
  expect(result.head.worlds).toHaveLength(2);expect(result.head.characters).toHaveLength(6);expect(result.head.character_relationships).toHaveLength(4);
  expect(result.head.worlds.find(world=>world.id===first.identities.worldId)).toEqual(state.head.worlds[0]);expect(result.head.development_plans[0]!.world.id).toBe(next.identities.worldId);expect(result.head.development_plans[0]!.version).toBe(2);
  expect(result.head.episodes.map(episode=>episode.id)).toEqual(state.head.episodes.map(episode=>episode.id));
});
it('preserves the actual foundation owner and audit when only episodes were regenerated',async()=>{
  const first=await mappingFixture({runId:'foundation-owner'});const state=adopt(first);const child=await mappingFixture({runId:'episode-child',parent:first});const result=adopt({...child,head:state.head},'episode-redo-mapping');
  expect(result.head.worlds).toEqual(state.head.worlds);expect(result.head.characters).toEqual(state.head.characters);expect(result.head.development_plans).toEqual(state.head.development_plans);
  expect(result.head.development_plans[0]!.source.run_id).toBe(first.progress.run.runId);expect(result.head.development_plans[0]!.source.run_digest).toBe(first.progress.run.digest);
  expect(result.head.episode_plans.every(episode=>episode.source.run_id===child.progress.run.runId&&episode.source.run_digest===child.progress.run.digest)).toBe(true);expect(result.head.episode_plans[0]!.source.reviewer_key).toBe('episode-editor');
});
it('shrinks only owned old episode slots and lets original IR validation protect an existing user scene',async()=>{
  const first=await mappingFixture({count:3});const state=adopt(first);const next=await mappingFixture({count:2,revision:2,runId:'shorter-development'});next.identities.episodes=first.identities.episodes;
  const draft=prepareDevelopmentDraft({...next,head:state.head});expect(draft.operations.filter(row=>row.op.op==='remove').map(row=>row.op.collection).sort()).toEqual(['episode_plans','episodes']);
  const clean=submitChangeSet(state,finalize(draft,'reduce-episodes'));expect(clean.issues).toEqual([]);expect(clean.state.changes.at(-1)!.preview!.episodes).toHaveLength(2);
  const protectedHead=structuredClone(state.head);protectedHead.scenes.push({id:id('user-scene'),version:1,episode_id:first.identities.episodes[2]!.episodeId,order_key:'001',title:'人工场景',location_id:null,character_ids:[],script_text:'保留人工正文。',start_state:'等待',end_state:'继续'});protectedHead.project.scope.expected_scene_count=1;
  const protectedDraft=prepareDevelopmentDraft({...next,head:protectedHead});expect(protectedDraft.operations.map(row=>String(row.op.collection))).not.toContain('scenes');
  const blocked=submitChangeSet(createVersionState(protectedHead),finalize(protectedDraft,'do-not-delete-user-scene'));expect(blocked.status).toBe('rejected');expect(blocked.issues.length).toBeGreaterThan(0);expect(blocked.state.head.scenes).toEqual(protectedHead.scenes);
});
it('retains all dependency bases so intervening source object edits conflict and newly added locks still block',async()=>{
  const input=await mappingFixture();const state=adopt(input);const child=await mappingFixture({parent:input,runId:'after-review'});const draft=prepareDevelopmentDraft({...child,head:state.head});const request=finalize(draft,'before-change');
  expect(draft.baseRevisions.map(ref=>ref.id)).toContain(input.identities.worldId);
  const changed=structuredClone(state.head);changed.worlds[0]!.version++;changed.worlds[0]!.setting='后来改变的世界。';
  const conflict=submitChangeSet(createVersionState(changed),request);expect(conflict.status).toBe('conflicted');expect(conflict.issues.map(issue=>issue.code)).toContain('REVISION_CONFLICT');
  const locked=structuredClone(state.head);locked.locks.push({id:id('plan-lock'),version:1,target:child.identities.episodes[0]!.planId,fields:['source'],owner_id:id('adopter'),reason:'人工锁定来源'});
  const blocked=submitChangeSet(createVersionState(locked),request);expect(blocked.status).toBe('rejected');expect(blocked.issues.map(issue=>issue.code)).toContain('LOCKED');
});
it('maps the maximum reviewed 100-episode bundle within the bounded ChangeSet without fabricating scenes',async()=>{
  const input=await mappingFixture({count:100});const draft=prepareDevelopmentDraft(input);expect(draft.operations).toHaveLength(207);const request=finalize(draft,'hundred-episodes');expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThanOrEqual(524288);
  const result=submitChangeSet(createVersionState(input.head),request);expect(result.status).toBe('candidate');expect(result.issues).toEqual([]);expect(result.state.changes[0]!.preview!.scenes).toEqual([]);
});
it('adds complete development to an existing formal project without replacing unrelated scenes, voices or media',async()=>{
  const input=await mappingFixture();const head={...input.head,...(await import('@camery/ir')).upgradeV05Package(makePackage())};const before=structuredClone(head);
  const state=adopt({...input,head});expect(state.head.scenes).toEqual(before.scenes);expect(state.head.assets).toEqual(before.assets);expect(state.head.sources).toEqual(before.sources);expect(state.head.shots).toEqual(before.shots);expect(state.head.episodes).toHaveLength(before.episodes.length+2);
});
it('does not mutate its trusted source, bindings, head or finalized draft',async()=>{
  const input=await mappingFixture();const before=JSON.stringify(input);const draft=prepareDevelopmentDraft(input);const draftBefore=JSON.stringify(draft);finalize(draft);expect(JSON.stringify(input)).toBe(before);expect(JSON.stringify(draft)).toBe(draftBefore);
});
it.each(['candidate-head','invalid-head','world-in-character','plan-owner','episode-owner','revision-overflow'] as const)('rejects inconsistent current formal state: %s',async kind=>{
  const input=await mappingFixture();const state=adopt(input);const head=structuredClone(state.head);
  if(kind==='candidate-head')head.revision.status='candidate';if(kind==='invalid-head')head.characters=[];
  if(kind==='world-in-character'){head.worlds=[];head.development_plans=[];head.episode_plans=[];head.characters.push({id:input.identities.worldId,version:1,name:'碰撞',role:'配角',default_voice_ref_id:null});}
  if(kind==='plan-owner'){head.development_plans[0]!.source.tenant_key='foreign';for(const plan of head.episode_plans)plan.source.tenant_key='foreign';}
  if(kind==='episode-owner'){head.development_plans[0]!.version=2;head.episode_plans[0]!.source.tenant_key='foreign';}
  if(kind==='revision-overflow'){head.characters[0]!.version=Number.MAX_SAFE_INTEGER;head.characters[0]!.development!.desire='必须明确恢复原审阅欲望。';}
  expect(()=>prepareDevelopmentDraft({...input,head})).toThrowError(expect.objectContaining({code:kind==='revision-overflow'?'INPUT_LIMIT':'CONFLICT'}));
});
it('does not remove a mapped old episode plan that was reassigned to a different development plan',async()=>{
  const input=await mappingFixture({count:3});const state=adopt(input);const next=await mappingFixture({count:2,revision:2,runId:'shorter'});next.identities.episodes=input.identities.episodes;
  const head=structuredClone(state.head);const another={...head.development_plans[0]!,id:id('another-plan')};head.development_plans.push(another);head.episode_plans[2]!.development_plan={id:another.id,version:1};
  expect(()=>prepareDevelopmentDraft({...next,head})).toThrowError(expect.objectContaining({code:'CONFLICT'}));
});
it.each(['callId','connectionId','modeDigest','modelIdentity'] as const)('reconstructs a valid receipt and still rejects the wrong foundation model owner %s',async field=>{
  const input=await mappingFixture();const candidate=input.progress.foundation.candidate!;const receipt={...candidate.model,[field]:field==='modeDigest'?'f'.repeat(64):'wrong-owner'};
  const reconstructed=createFoundationCandidate(input.progress.run.brief,candidate.output,receipt);expect(()=>prepareDevelopmentDraft({...input,progress:{...input.progress,foundation:{...input.progress.foundation,candidate:reconstructed}}})).toThrowError(expect.objectContaining({code:'INVALID_EVIDENCE'}));
});
it('rejects the wrong child model owner after reconstructing its complete valid episode receipt',async()=>{
  const input=await mappingFixture();const candidate=input.progress.episodes.candidate!;const reconstructed=createEpisodeCandidate(input.progress.run.brief,input.progress.foundation.review as ReviewedDevelopment<'foundation'>,candidate.output,{...candidate.model,connectionId:'wrong-child-owner'});
  expect(()=>prepareDevelopmentDraft({...input,progress:{...input.progress,episodes:{...input.progress.episodes,candidate:reconstructed}}})).toThrowError(expect.objectContaining({code:'INVALID_EVIDENCE'}));
});
it('rejects legacy targets instead of implicitly upgrading',async()=>{
  const input=await mappingFixture();expect(()=>prepareDevelopmentDraft({...input,head:makePackage()})).toThrowError(expect.objectContaining({code:'INVALID_INPUT'}));
});
it.each(['scope','target','owner','reviewer','duplicate-object','duplicate-local','missing-local','extra-local','duplicate-slot','missing-slot','protected-id'] as const)('rejects wrong or incomplete persisted identity mapping: %s',async kind=>{
  const input=await mappingFixture();const mapping=input.identities;
  if(kind==='scope')mapping.tenantId='foreign';if(kind==='target')mapping.target.projectId=id('foreign');if(kind==='owner')mapping.foundationOwner.runId='foreign';if(kind==='reviewer')input.reviewers.foundation.key='foreign';
  if(kind==='duplicate-object')mapping.characters[0]!.id=mapping.worldId;if(kind==='duplicate-local')mapping.characters[1]!.localId=mapping.characters[0]!.localId;
  if(kind==='missing-local')mapping.characters.pop();if(kind==='extra-local')mapping.characters.push({localId:'unreviewed',id:id('unreviewed')});if(kind==='duplicate-slot')mapping.episodes[1]!.number=1;
  if(kind==='missing-slot')mapping.episodes.pop();if(kind==='protected-id')mapping.planId=input.head.project.id;
  expect(()=>prepareDevelopmentDraft(input)).toThrowError(expect.objectContaining({code:'CONFLICT'}));
});
it.each(['missing-candidate','missing-review','rejected-review','candidate-body','review-body','candidate-link','source-run','source-brief','source-foundation','source-episodes','model-call','model-owner'] as const)('rejects unreviewed, stale or corrupt original evidence: %s',async kind=>{
  const input=await mappingFixture();const progress=structuredClone(input.progress);
  if(kind==='missing-candidate')Object.assign(progress.foundation,{candidate:null});if(kind==='missing-review')Object.assign(progress.episodes,{review:null});
  if(kind==='rejected-review')Object.assign(progress.episodes.review!,{status:'rejected'});if(kind==='candidate-body')progress.foundation.candidate!.output.title+='篡改';
  if(kind==='review-body')Object.assign(progress.foundation.review!,{output:{}});if(kind==='candidate-link')Object.assign(progress.episodes.review!,{candidateDigest:'f'.repeat(64)});
  if(kind==='source-run')input.source.runDigest='f'.repeat(64);if(kind==='source-brief')input.source.briefDigest='f'.repeat(64);if(kind==='source-foundation')input.source.foundationReviewDigest='f'.repeat(64);if(kind==='source-episodes')input.source.episodesReviewDigest='f'.repeat(64);
  if(kind==='model-call')Object.assign(progress.foundation.candidate!.model,{callId:'wrong'});if(kind==='model-owner')Object.assign(progress.episodes.candidate!.model,{connectionId:'wrong'});
  expect(()=>prepareDevelopmentDraft({...input,progress})).toThrow();
});
it('rejects inherited audit metadata that disagrees with the actual original candidate even after the run digest is recalculated',async()=>{
  const first=await mappingFixture();const input=await mappingFixture({parent:first,runId:'inherited'});input.progress.run.origin!.foundation!.candidateDigest='f'.repeat(64);Object.assign(input.progress.run,{digest:developmentRunDigest(input.progress.run)});input.source.runDigest=input.progress.run.digest;
  expect(()=>prepareDevelopmentDraft(input)).toThrowError(expect.objectContaining({code:'CONFLICT'}));
});
it('captures input without invoking getters and enforces the total input byte boundary',async()=>{
  const input=await mappingFixture();const getter=vi.fn(()=>input.progress);expect(()=>prepareDevelopmentDraft({...input,get progress(){return getter();}})).toThrow();expect(getter).not.toHaveBeenCalled();
  expect(()=>prepareDevelopmentDraft({...input,head:{payload:'x'.repeat(2_097_152)}})).toThrowError(expect.objectContaining({code:'INPUT_LIMIT'}));
});
it.each(['missing-slot','duplicate-slot','duplicate-id','change-collision','object-collision','wrong-slot','missing-base','wrong-version','agent-author'] as const)('rejects finalization with unfixed identities or modified draft bindings: %s',async kind=>{
  const input=await mappingFixture();const state=adopt(input);const child=await mappingFixture({parent:input,runId:'finalization-child'});const draft=structuredClone(prepareDevelopmentDraft({...child,head:state.head}));
  const fixed={draft,changeSetId:id('fixed-change'),author:{kind:'user' as const,id:id('adopter')},operationIds:draft.operations.map(row=>({slot:row.slot,id:id('fixed-'+row.slot)}))};
  if(kind==='missing-slot')fixed.operationIds.pop();if(kind==='duplicate-slot')fixed.operationIds[1]!.slot=fixed.operationIds[0]!.slot;if(kind==='duplicate-id')fixed.operationIds[1]!.id=fixed.operationIds[0]!.id;
  if(kind==='change-collision')fixed.operationIds[0]!.id=fixed.changeSetId;if(kind==='object-collision')fixed.changeSetId=state.head.characters[0]!.id;if(kind==='wrong-slot'){draft.operations[0]!.slot='episodes:wrong:replace';fixed.operationIds[0]!.slot=draft.operations[0]!.slot;}
  if(kind==='missing-base')draft.baseRevisions=[];if(kind==='wrong-version'){const op=draft.operations[0]!.op;if(op.op==='replace')op.value['version']=999;}
  if(kind==='agent-author')Object.assign(fixed.author,{kind:'agent_run'});
  expect(()=>finalizeDevelopmentChangeSet(fixed)).toThrow();
});
it('rejects duplicate object bases and an operation identity colliding with an existing object',async()=>{
  const input=await mappingFixture();const state=adopt(input);const child=await mappingFixture({parent:input,runId:'fixed-base-child'});const draft=structuredClone(prepareDevelopmentDraft({...child,head:state.head}));
  const fixed={draft,changeSetId:id('fixed-bases'),author:{kind:'user' as const,id:id('adopter')},operationIds:draft.operations.map(row=>({slot:row.slot,id:id('fixed-base'+row.slot)}))};
  draft.baseRevisions.push({...draft.baseRevisions[0]!});expect(()=>finalizeDevelopmentChangeSet(fixed)).toThrowError(expect.objectContaining({code:'CONFLICT'}));draft.baseRevisions.pop();
  fixed.operationIds[0]!.id=state.head.worlds[0]!.id;expect(()=>finalizeDevelopmentChangeSet(fixed)).toThrowError(expect.objectContaining({code:'CONFLICT'}));
});
it('rejects accessor operation IDs and bounds finalization data before using it',async()=>{
  const input=await mappingFixture();const draft=prepareDevelopmentDraft(input);const getter=vi.fn(()=>id('hidden-op'));const operations=draft.operations.map(row=>({slot:row.slot,id:id(row.slot)}));Object.defineProperty(operations[0],'id',{enumerable:true,get:getter});
  expect(()=>finalizeDevelopmentChangeSet({draft,changeSetId:id('hidden-change'),author:{kind:'user',id:id('adopter')},operationIds:operations})).toThrow();expect(getter).not.toHaveBeenCalled();
  const large=structuredClone(draft);const op=large.operations[0]!.op;if(op.op==='add')op.value['unbounded']='x'.repeat(1_048_576);expect(()=>finalize(large)).toThrowError(expect.objectContaining({code:'INPUT_LIMIT'}));
});
