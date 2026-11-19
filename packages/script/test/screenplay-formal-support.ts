import {adoptChangeSet,createVersionState,submitChangeSet} from '@camery/versioning';
import {captureContinuityContext} from '../src/continuity/context.js';
import {projectScreenplayReferences} from '../src/screenplay/node/source.js';
import {prepareOutlineMappingDraft,finalizeOutlineChangeSet} from '../src/outline/node/formal-mapping.js';
import {outlineFormalMappingFixture,outlineMappingInput} from './outline-formal-mapping-support.js';
import {screenplayFixture} from './screenplay-support.js';
/** Pure engine and immutable replay fixture; actual PostgreSQL acceptance is tested separately. */
export async function screenplayFormalFixture(){
  const original=await outlineFormalMappingFixture(),sample=screenplayFixture(),id=sample.id,mapping=prepareOutlineMappingDraft(outlineMappingInput(original));
  const request=finalizeOutlineChangeSet({draft:mapping,changeSetId:id('script-formal-outline-change'),author:{kind:'user',id:original.reviewer.id},operationIds:mapping.operations.map((row,index)=>({slot:row.slot,id:id('script-formal-outline-op-'+index)}))});
  const native=adoptChangeSet(submitChangeSet(createVersionState(original.head),request).state,request.id,{actor:{kind:'user',id:original.reviewer.id},scope:{kind:'project',id:original.head.project.id},at:original.host.at,authorize:()=>true});
  if(native.status!=='adopted'||native.state.head.schema_version!=='0.7.0-draft')throw new Error('formal source fixture');
  const head=native.state.head,nativeContext=captureContinuityContext(head),episode=nativeContext.episodes[0]!,plan=head.adaptation_plans[0]!,episodePlan=head.outline_episode_plans.find(row=>row.episode_id===episode.id)!;
  const context={...sample.context,schemaVersion:head.schema_version,projectId:head.project.id,packageId:head.package_id,snapshotRevision:head.revision.number,episode:{...episode,title:episodePlan.title,targetSeconds:head.episodes[0]!.target_seconds},nativeContext,
    outline:{plan:{id:plan.id,version:plan.version},episodePlan:{id:episodePlan.id,version:episodePlan.version},sourceDigest:plan.source.source_digest,synopsis:episodePlan.synopsis,openingHook:{type:episodePlan.opening_hook.type,text:episodePlan.opening_hook.text,beat:episodePlan.opening_hook.beat},cliffhanger:{type:episodePlan.cliffhanger.type,text:episodePlan.cliffhanger.text,beat:episodePlan.cliffhanger.beat},beats:episodePlan.beats.map(ref=>{const row=head.outline_beats.find(value=>value.id===ref.id)!;return {ref,order:row.order,characters:row.characters,goal:row.goal,conflict:row.conflict,turn:row.turn,consequence:row.consequence,referenceIds:row.origin.source_ref_ids};})},
    characters:head.characters.map(row=>({id:row.id,version:row.version,name:row.name,role:row.role})),locations:[],references:projectScreenplayReferences(original.run.source)};
  const draft=structuredClone(sample.draft);draft.episodeId=episode.id;draft.title=episodePlan.title;draft.openingHook!.type=episodePlan.opening_hook.type;draft.closingHook!.type=episodePlan.cliffhanger.type;
  draft.scenes[0]!.characterIds=[head.characters[0]!.id];for(const beat of draft.scenes[0]!.beats){beat.outlineBeatIds=episodePlan.beats.map(row=>row.id);for(const line of beat.lines)line.speakerId=head.characters[0]!.id;}
  return {original,id,head,context,draft,state:native.state,scope:{tenantId:original.key.tenantId,projectId:original.key.projectId},target:original.identities.target};
}
