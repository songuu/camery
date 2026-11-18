import {z} from 'zod';
import {ChangeSet,StoryboardPackageV06,StoryboardPackageV07,validatePackage,OUTLINE_FORMAL_BYTES} from '@camery/ir';
type FormalPackage=z.infer<typeof StoryboardPackageV06>|z.infer<typeof StoryboardPackageV07>;
import {DevelopmentError,Integer} from '../contracts.js';
import type {DevelopmentCandidate,DevelopmentStage,ReviewedDevelopment} from '../contracts.js';
import {validateFoundationCandidate,validateEpisodeCandidate} from '../development.js';
import {validateReviewedFoundation,validateReviewedEpisodes} from '../reviewed.js';
import {copy,freeze,parse,canonical} from '../data.js';
import {DevelopmentAdoptionSourceSchema,validateDevelopmentRun,developmentCandidateOwner,developmentStageCallId} from './contracts.js';
import type {DevelopmentProgress,DevelopmentAdoptionSource,DevelopmentRun} from './contracts.js';
import {DevelopmentFormalIdentitiesSchema,DevelopmentReviewerBindingsSchema,DevelopmentVersionKeySchema,FormalStableId} from './adoption-contracts.js';
import type {DevelopmentFormalIdentities,DevelopmentReviewerBindings} from './adoption-contracts.js';

const collection=z.enum(['worlds','characters','character_relationships','development_plans','episodes','episode_plans']);
type Collection=z.infer<typeof collection>;
const value=z.record(z.string(),z.unknown());
const operation=z.discriminatedUnion('op',[
  z.strictObject({op:z.literal('add'),collection,value}),
  z.strictObject({op:z.literal('replace'),collection,target:FormalStableId,value}),
  z.strictObject({op:z.literal('remove'),collection,target:FormalStableId}),
]);
type MappingOperation=z.infer<typeof operation>;
type FormalChangeSet=z.infer<typeof ChangeSet>;
const slot=z.string().min(1).max(128);
const revision=z.strictObject({id:FormalStableId,version:Integer.min(1)});
const DraftSchema=z.strictObject({version:z.literal(1),schemaVersion:z.enum(['0.6.0-draft','0.7.0-draft']).default('0.6.0-draft'),target:DevelopmentVersionKeySchema,source:DevelopmentAdoptionSourceSchema,baseRevision:Integer.min(1),baseRevisions:z.array(revision),
  operations:z.array(z.strictObject({slot,op:operation})).max(500),reservedIds:z.array(FormalStableId)});
export type DevelopmentMappingDraft=z.infer<typeof DraftSchema>;
const InputSchema=z.strictObject({progress:z.strictObject({run:z.unknown(),foundation:z.strictObject({candidate:z.unknown(),review:z.unknown()}),episodes:z.strictObject({candidate:z.unknown(),review:z.unknown()})}),
  source:DevelopmentAdoptionSourceSchema,identities:DevelopmentFormalIdentitiesSchema,reviewers:DevelopmentReviewerBindingsSchema,head:z.unknown()});
const FinalSchema=z.strictObject({draft:DraftSchema,changeSetId:FormalStableId,author:z.strictObject({kind:z.literal('user'),id:FormalStableId}),operationIds:z.array(z.strictObject({slot,id:FormalStableId})).max(500)});
type Versioned=Record<string,unknown>&{id:string;version:number};
const same=(left:unknown,right:unknown)=>canonical(left)===canonical(right);
function conflict(operation:string):never{throw new DevelopmentError('CONFLICT',operation);}
function unique<T>(values:readonly T[],operation:string):void{if(new Set(values).size!==values.length)conflict(operation);}
function exactLocalIds(input:readonly {localId:string;id:string}[],expected:readonly {id:string}[],name:string):Map<string,string>{
  unique(input.map(item=>item.localId),name+' local identities');const mapped=new Map(input.map(item=>[item.localId,item.id]));
  if(mapped.size!==expected.length||expected.some(item=>!mapped.has(item.id)))conflict(name+' complete local identities');return mapped;
}
function modelBinding(run:DevelopmentRun,stage:DevelopmentStage,candidate:DevelopmentCandidate):void{
  const owner=developmentCandidateOwner(run,stage);const profile=owner.execution;const model=candidate.model;
  if(model.connectionId!==profile.connectionId||model.modeDigest!==profile.modeDigest||model.modelIdentity!==profile.modelIdentity||model.evidence!==profile.evidence||model.callId!==developmentStageCallId(owner.key,stage))throw new DevelopmentError('INVALID_EVIDENCE','formal mapping model owner');
}
function sourceOf(run:DevelopmentRun,review:ReviewedDevelopment,reviewer:{key:string;id:string},stage:'foundation'|'episodes'){
  const owner=stage==='foundation'?run.origin?.foundation:null;
  return {tenant_key:run.tenantId,project_key:run.projectId,run_id:owner?.runId??run.runId,run_digest:owner?.runDigest??run.digest,brief_id:run.brief.briefId,brief_revision:run.brief.revision,brief_digest:run.brief.digest,
    candidate_digest:review.candidateDigest,review_digest:review.digest,reviewer_id:reviewer.id,reviewer_key:review.actorId,reviewed_at:review.at,stage};
}
function headObjects(head:FormalPackage):Map<string,{collection:string;value:Versioned}>{
  const result=new Map<string,{collection:string;value:Versioned}>();
  for(const [name,rows] of Object.entries(head))if(Array.isArray(rows))for(const row of rows){
    if(row&&typeof row==='object'&&'id' in row&&'version' in row)result.set(row.id,{collection:name,value:row as Versioned});
  }
  return result;
}
function mappingSchemaVersion(input:unknown):unknown{
  try{const head=input!==null&&typeof input==='object'?Object.getOwnPropertyDescriptor(input,'head'):undefined;
    return head&&'value' in head&&head.value!==null&&typeof head.value==='object'?Object.getOwnPropertyDescriptor(head.value,'schema_version')?.value:undefined;
  }catch{return undefined;} // The strict snapshot below owns malformed/proxy errors and their safe domain context.
}
/** Pure integrity replay of trusted stored evidence. Hashes do not authorize approval or prove latest-source freshness. */
export function prepareDevelopmentDraft(input:{progress:DevelopmentProgress;source:DevelopmentAdoptionSource;identities:DevelopmentFormalIdentities;reviewers:DevelopmentReviewerBindings;head:unknown}):DevelopmentMappingDraft{
  const version=mappingSchemaVersion(input);
  // New formal plans expand local references; preserve the legacy input budget while allowing a bounded v07 head.
  const raw=parse(InputSchema,copy(input,version==='0.7.0-draft'?OUTLINE_FORMAL_BYTES+2_097_152:2_097_152),'formal mapping input');const {source,identities,reviewers}=raw;
  const run=validateDevelopmentRun({tenantId:source.tenantId,projectId:source.projectId,runId:source.runId},raw.progress.run);
  if(!raw.progress.foundation.candidate||!raw.progress.foundation.review||!raw.progress.episodes.candidate||!raw.progress.episodes.review)throw new DevelopmentError('INCOMPLETE','reviewed mapping source');
  const foundationCandidate=validateFoundationCandidate(run.brief,raw.progress.foundation.candidate);modelBinding(run,'foundation',foundationCandidate);
  const foundation=validateReviewedFoundation(run.brief,raw.progress.foundation.review);
  const episodeCandidate=validateEpisodeCandidate(run.brief,foundation,raw.progress.episodes.candidate);modelBinding(run,'episodes',episodeCandidate);
  const episodes=validateReviewedEpisodes(run.brief,foundation,raw.progress.episodes.review);
  if(foundation.candidateDigest!==foundationCandidate.digest||episodes.candidateDigest!==episodeCandidate.digest||run.digest!==source.runDigest||run.brief.digest!==source.briefDigest
    ||foundation.digest!==source.foundationReviewDigest||episodes.digest!==source.episodesReviewDigest)conflict('formal mapping source binding');
  const owner=run.origin?.foundation??{runId:run.runId,runDigest:run.digest};
  const inherited=run.origin?.foundation;if(inherited&&(inherited.candidateDigest!==foundationCandidate.digest||inherited.reviewDigest!==foundation.digest))conflict('formal mapping inherited audit');
  if(identities.tenantId!==run.tenantId||identities.projectId!==run.projectId||identities.foundationOwner.runId!==owner.runId||identities.foundationOwner.runDigest!==owner.runDigest
    ||reviewers.foundation.key!==foundation.actorId||reviewers.episodes.key!==episodes.actorId)conflict('formal mapping authority identities');
  const head=parse(z.discriminatedUnion('schema_version',[StoryboardPackageV06,StoryboardPackageV07]),raw.head,'formal schema upgrade required');
  if(head.project.id!==identities.target.projectId||head.revision.status!=='adopted'||!validatePackage(head).valid)conflict('formal mapping adopted target');
  const characters=exactLocalIds(identities.characters,foundation.output.characters,'character');const relationships=exactLocalIds(identities.relationships,foundation.output.relationships,'relationship');
  unique(identities.episodes.map(item=>item.number),'episode slots');const slots=new Map(identities.episodes.map(item=>[item.number,item]));
  if(episodes.output.episodes.some(item=>!slots.has(item.number)))conflict('formal mapping complete episode slots');
  const ids=[identities.planId,identities.worldId,...identities.characters.map(item=>item.id),...identities.relationships.map(item=>item.id),...identities.episodes.flatMap(item=>[item.episodeId,item.planId])];unique(ids,'formal mapping global identities');
  const objects=headObjects(head);const protectedIds=[head.package_id,head.project.id,...head.locations.flatMap(location=>location.spots.map(spot=>spot.id))];
  if(ids.some(id=>protectedIds.includes(id)))conflict('formal mapping reserved identity');
  const bases=new Map<string,number>();const operations:DevelopmentMappingDraft['operations']=[];
  const find=(name:Collection,id:string)=>{const old=objects.get(id);if(old&&old.collection!==name)conflict('formal mapping identity collection');if(old)bases.set(id,old.value.version);return old?.value;};
  const upsert=(name:Collection,id:string,fields:Record<string,unknown>):number=>{
    const old=find(name,id);const row={...fields,id,version:old?.version??1};
    if(old&&same(old,row))return old.version;
    if(old&&old.version>=Number.MAX_SAFE_INTEGER)throw new DevelopmentError('INPUT_LIMIT','formal object revision');
    const op:MappingOperation=old?{op:'replace',collection:name,target:id,value:row}:{op:'add',collection:name,value:row};operations.push({slot:`${name}:${id}:${op.op}`,op});return old?old.version+1:1;
  };
  const remove=(name:Collection,id:string)=>{if(find(name,id))operations.push({slot:`${name}:${id}:remove`,op:{op:'remove',collection:name,target:id}});};
  const worldVersion=upsert('worlds',identities.worldId,{setting:foundation.output.world.setting,era:foundation.output.world.era,rules:foundation.output.world.rules.map(rule=>({key:rule.id,text:rule.text}))});
  const characterVersions=new Map<string,number>();
  for(const character of foundation.output.characters){const mapped=characters.get(character.id)!;const current=find('characters',mapped);
    characterVersions.set(mapped,upsert('characters',mapped,{name:character.name,role:current?.role??character.function,default_voice_ref_id:current?.default_voice_ref_id??null,development:{function:character.function,desire:character.desire,obstacle:character.obstacle,arc:character.arc}}));
  }
  const relationshipRefs=foundation.output.relationships.map(relationship=>{const mapped=relationships.get(relationship.id)!;return {id:mapped,version:upsert('character_relationships',mapped,{from_character_id:characters.get(relationship.from)!,to_character_id:characters.get(relationship.to)!,text:relationship.text})};});
  const characterRef=(localId:string)=>{const mapped=characters.get(localId)!;return {id:mapped,version:characterVersions.get(mapped)!};};
  const ruleRef=(key:string)=>({world_id:identities.worldId,key});
  const currentPlan=find('development_plans',identities.planId);
  if(currentPlan){const oldSource=currentPlan.source as {tenant_key:string;project_key:string};if(oldSource.tenant_key!==run.tenantId||oldSource.project_key!==run.projectId)conflict('formal mapping existing plan owner');}
  const mainline=foundation.output.mainline;
  const planVersion=upsert('development_plans',identities.planId,{title:foundation.output.title,brief:{idea:run.brief.idea,episode_count:run.brief.episodeCount,target_seconds:run.brief.targetSeconds},world:{id:identities.worldId,version:worldVersion},characters:foundation.output.characters.map(character=>characterRef(character.id)),relationships:relationshipRefs,
    mainline:{premise:mainline.premise,central_conflict:mainline.centralConflict,stakes:mainline.stakes,progression:mainline.progression,resolution:mainline.resolution,character_ids:mainline.characterIds.map(localId=>characters.get(localId)!),rule_refs:mainline.ruleIds.map(ruleRef)},open_questions:foundation.output.openQuestions.map(question=>({key:question.id,text:question.text})),source:sourceOf(run,foundation,reviewers.foundation,'foundation')});
  for(const episode of episodes.output.episodes){const mapped=slots.get(episode.number)!;upsert('episodes',mapped.episodeId,{title:episode.title,order_key:String(episode.number).padStart(3,'0'),target_seconds:run.brief.targetSeconds});
    const oldPlan=find('episode_plans',mapped.planId);if(oldPlan){const oldSource=oldPlan.source as {tenant_key:string;project_key:string};if(oldSource.tenant_key!==run.tenantId||oldSource.project_key!==run.projectId)conflict('formal mapping existing episode owner');}
    upsert('episode_plans',mapped.planId,{episode_id:mapped.episodeId,number:episode.number,development_plan:{id:identities.planId,version:planVersion},summary:episode.summary,goal:episode.goal,conflict:episode.conflict,turn:episode.turn,ending:episode.ending,characters:episode.characterIds.map(characterRef),rule_refs:episode.ruleIds.map(ruleRef),source:sourceOf(run,episodes,reviewers.episodes,'episodes')});
  }
  for(const mapped of identities.episodes.filter(item=>item.number>run.brief.episodeCount)){
    const old=find('episode_plans',mapped.planId);
    if(old){const plan=old as unknown as FormalPackage['episode_plans'][number];if(plan.development_plan.id!==identities.planId||plan.episode_id!==mapped.episodeId||plan.number!==mapped.number||plan.source.tenant_key!==run.tenantId||plan.source.project_key!==run.projectId)conflict('formal mapping removed episode owner');}
    remove('episode_plans',mapped.planId);remove('episodes',mapped.episodeId);
  }
  return freeze(parse(DraftSchema,copy({version:1,schemaVersion:head.schema_version,target:identities.target,source,baseRevision:head.revision.number,baseRevisions:[...bases].sort(([left],[right])=>left.localeCompare(right)).map(([id,version])=>({id,version})),operations,reservedIds:[...new Set([...protectedIds,...objects.keys(),...ids,reviewers.foundation.id,reviewers.episodes.id])]},1_048_576),'formal mapping draft'));
}
/** Finalize only an already prepared trusted draft, with IDs fixed by a separately persisted application intent. */
export function finalizeDevelopmentChangeSet(input:{draft:DevelopmentMappingDraft;changeSetId:string;author:{kind:'user';id:string};operationIds:readonly {slot:string;id:string}[]}):FormalChangeSet{
  const fields=parse(FinalSchema,copy(input,1_048_576),'formal change finalization');const {draft,changeSetId,author,operationIds}=fields;
  if(!draft.operations.length)throw new DevelopmentError('INCOMPLETE','unchanged development draft');
  unique(draft.operations.map(row=>row.slot),'mapping operation slots');unique(draft.baseRevisions.map(row=>row.id),'mapping object bases');unique(operationIds.map(row=>row.slot),'fixed operation slots');unique(operationIds.map(row=>row.id),'fixed operation identities');
  const ids=new Map(operationIds.map(row=>[row.slot,row.id]));
  if(ids.size!==draft.operations.length||draft.operations.some(row=>!ids.has(row.slot)))conflict('complete fixed operation identities');
  if(draft.reservedIds.includes(changeSetId)||operationIds.some(row=>row.id===changeSetId||draft.reservedIds.includes(row.id)))conflict('reserved change identities');
  const bases=new Map(draft.baseRevisions.map(row=>[row.id,row.version]));
  const ops=draft.operations.map(row=>{const target=row.op.op==='add'?row.op.value['id']:row.op.target;const id=parse(FormalStableId,target,'mapped operation target');
    if(row.slot!==`${row.op.collection}:${id}:${row.op.op}`)conflict('mapping operation slot binding');
    if(row.op.op!=='add'&&!bases.has(id)||row.op.op==='replace'&&row.op.value['version']!==bases.get(id))conflict('mapping operation base');
    return {...row.op,op_id:ids.get(row.slot)!};
  });
  return freeze(parse(ChangeSet,copy({schema_version:draft.schemaVersion,id:changeSetId,base_revision:draft.baseRevision,author,status:'candidate',base_revisions:draft.baseRevisions,ops},524288),'formal development ChangeSet'));
}
