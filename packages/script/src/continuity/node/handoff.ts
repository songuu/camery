import {z} from 'zod';
import {EpisodeStateSnapshot,StableId,StoryboardPackage,validatePackage} from '@camery/ir';
import type {AdoptionRecord,VersionState} from '@camery/versioning';
import type {StoredVersionState,VersionProjectKey} from '@camery/versioning/node';
import {snapshotJson} from '@camery/methods/json';
import {Integer} from '../../contracts.js';
import {captureContinuity,freezeContinuity} from '../boundary.js';
import {CONTINUITY_CONTEXT_BYTES,CONTINUITY_LEDGER_BYTES,ContinuityError} from '../contracts.js';
import {canonicalContinuity} from './digest.js';

const selectionSchema=z.strictObject({episodeId:StableId,expectedRevision:Integer.min(1).optional()});
const targetSchema=z.strictObject({tenantId:StableId,projectId:StableId});
const adoptionSchema=z.strictObject({change_set_id:StableId,actor_id:StableId,scope:z.strictObject({kind:z.enum(['project','episode','scene']),id:StableId}),from_revision:Integer.min(1),to_revision:Integer.min(1),at:z.iso.datetime({precision:3})});
type NativeSnapshot=z.infer<typeof EpisodeStateSnapshot>;
export interface NativeEpisodeHandoff{readonly kind:'first_episode'|'ready';readonly projectId:string;readonly episodeId:string;readonly previousEpisodeId:string|null;readonly headRevision:number;readonly writeVersion:number;readonly snapshotAdoptedRevision:number|null;readonly snapshot:NativeSnapshot|null;readonly adoption:AdoptionRecord|null}
export interface NativeContinuityReader{read(target:VersionProjectKey):Promise<StoredVersionState|null>}
function fail(code:ConstructorParameters<typeof ContinuityError>[0],path:string):never{throw new ContinuityError(code,'native handoff',path);}
function adoptedPackage(input:unknown){const pkg=captureContinuity(StoryboardPackage,input,'native package',CONTINUITY_CONTEXT_BYTES);if(!validatePackage(pkg).valid)fail('INVALID_REFERENCE','package');if(pkg.revision.status!=='adopted')fail('UNADOPTED_SNAPSHOT','revision.status');return pkg;}
function episodes(pkg:StoryboardPackage){const ordered=[...pkg.episodes].sort((a,b)=>a.order_key<b.order_key?-1:a.order_key>b.order_key?1:0);if(ordered.some((value,index)=>index>0&&value.order_key===ordered[index-1]!.order_key))fail('INVALID_REFERENCE','episodes.order_key');return ordered;}
function pins(pkg:StoryboardPackage,episodeId:string,snapshot?:NativeSnapshot){
  if(!pkg.episodes.some(episode=>episode.id===episodeId))fail('NOT_FOUND','episodeId');
  const scenes=pkg.scenes.filter(scene=>scene.episode_id===episodeId),sceneIds=new Set(scenes.map(scene=>scene.id)),beats=pkg.beats.filter(beat=>sceneIds.has(beat.scene_id)),beatIds=new Set(beats.map(beat=>beat.id));
  const characterIds=new Set([...scenes.flatMap(scene=>scene.character_ids),...(snapshot?.knowledge.map(value=>value.character_id)??[]),...(snapshot?.characters.map(value=>value.character_id)??[])]),appearanceIds=new Set(snapshot?.characters.map(value=>value.appearance_id)??[]),propIds=new Set(snapshot?.characters.flatMap(value=>value.holding)??[]),spotIds=new Set(snapshot?.characters.map(value=>value.spot_id)??[]),locationIds=new Set(scenes.flatMap(scene=>scene.location_id===null?[]:[scene.location_id]));
  // Pin the episode script and its actual state dependencies; unrelated later characters or props must not invalidate an earlier handoff.
  return [pkg.episodes.find(episode=>episode.id===episodeId)!,...scenes,...beats,...pkg.lines.filter(line=>beatIds.has(line.beat_id)),...pkg.characters.filter(value=>characterIds.has(value.id)),...pkg.appearances.filter(value=>appearanceIds.has(value.id)),...pkg.props.filter(value=>propIds.has(value.id)),...pkg.locations.filter(value=>locationIds.has(value.id)||value.spots.some(spot=>spotIds.has(spot.id)))].map(value=>({id:value.id,version:value.version}));
}
/** Computes a complete baseline; it neither creates a snapshot nor grants authority to adopt one. */
export function nativeEpisodeSnapshotPins(input:unknown,episodeId:string,snapshotInput?:unknown){const pkg=adoptedPackage(input);const id=captureContinuity(StableId,episodeId,'episode identity',128),snapshot=snapshotInput===undefined?undefined:captureContinuity(EpisodeStateSnapshot,snapshotInput,'snapshot dependencies',CONTINUITY_LEDGER_BYTES);if(snapshot&&snapshot.episode_id!==id)fail('CONFLICT','snapshot.episode_id');return freezeContinuity(pins(pkg,id,snapshot));}
function nativeProof(state:VersionState,snapshot:NativeSnapshot):AdoptionRecord{
  const history=state.revisions.filter(row=>row.collection==='episode_state_snapshots'&&row.object_id===snapshot.id).sort((a,b)=>b.version-a.version)[0];
  if(!history||history.version!==snapshot.version||!history.change_set_id||canonicalContinuity(history.value,CONTINUITY_LEDGER_BYTES)!==canonicalContinuity(snapshot,CONTINUITY_LEDGER_BYTES))fail('UNADOPTED_SNAPSHOT','snapshot.history');
  const adoption=state.adoptions.find(value=>value.change_set_id===history.change_set_id&&value.to_revision===history.snapshot_revision);
  const change=state.changes.find(value=>value.request.id===history.change_set_id);
  if(!adoption||!change||change.status!=='adopted'||adoption.to_revision>state.head.revision.number||adoption.from_revision+1!==adoption.to_revision||!StableId.safeParse(adoption.actor_id).success||
    !(adoption.scope.kind==='project'&&adoption.scope.id===state.head.project.id||adoption.scope.kind==='episode'&&adoption.scope.id===snapshot.episode_id))fail('UNADOPTED_SNAPSHOT','snapshot.adoption');
  return captureContinuity(adoptionSchema,adoption,'native adoption',16384);
}
/** Host-only read port. Authentication belongs to its caller; no HTTP-supplied snapshot or status can replace this read. */
export async function readAdoptedEpisodeHandoff(store:NativeContinuityReader,targetInput:unknown,selectionInput:unknown):Promise<NativeEpisodeHandoff>{
  const target=freezeContinuity(captureContinuity(targetSchema,targetInput,'formal target',1024)),selection=captureContinuity(selectionSchema,selectionInput,'episode selection',1024);
  let stored:StoredVersionState|null;
  try{const read=store.read.bind(store);const result=await read(target);stored=result===null?null:snapshotJson(result,CONTINUITY_CONTEXT_BYTES,65536);}
  catch{throw new ContinuityError('STORAGE_FAILED','native handoff read','$');}
  if(!stored)fail('NOT_FOUND','project');
  let pkg:StoryboardPackage;
  try{pkg=adoptedPackage(stored.state.head);}catch(error){if(error instanceof ContinuityError)throw error;fail('STORAGE_FAILED','state.head');}
  if(pkg.project.id!==target.projectId||selection.expectedRevision!==undefined&&selection.expectedRevision!==pkg.revision.number)fail('CONFLICT','revision');
  if(!Number.isSafeInteger(stored.writeVersion)||stored.writeVersion<1)fail('STORAGE_FAILED','writeVersion');
  const ordered=episodes(pkg),index=ordered.findIndex(episode=>episode.id===selection.episodeId);if(index<0)fail('NOT_FOUND','episodeId');
  const common={projectId:target.projectId,episodeId:selection.episodeId,headRevision:pkg.revision.number,writeVersion:stored.writeVersion};
  if(index===0)return freezeContinuity({...common,kind:'first_episode',previousEpisodeId:null,snapshotAdoptedRevision:null,snapshot:null,adoption:null});
  const previous=ordered[index-1]!,candidates=pkg.episode_state_snapshots.filter(value=>value.episode_id===previous.id&&value.status==='adopted');
  if(candidates.length!==1)fail(candidates.length?'CONFLICT':'INCOMPLETE','previous.snapshot');
  const snapshot=candidates[0]!,baseline=new Map(snapshot.based_on.map(ref=>[ref.id,ref.version]));if(baseline.size!==snapshot.based_on.length)fail('INVALID_REFERENCE','snapshot.based_on');
  for(const ref of pins(pkg,previous.id,snapshot))if(baseline.get(ref.id)!==ref.version)fail('INCOMPLETE','snapshot.based_on.'+ref.id);
  const facts=new Set(snapshot.facts),known=new Set<string>(),characters=new Set<string>();if(facts.size!==snapshot.facts.length)fail('INVALID_REFERENCE','snapshot.facts');
  for(const value of snapshot.knowledge){const key=value.character_id+'\0'+value.fact;if(!facts.has(value.fact)||known.has(key)||!value.source.trim())fail('INVALID_REFERENCE','snapshot.knowledge');known.add(key);}
  for(const value of snapshot.characters){if(characters.has(value.character_id))fail('INVALID_REFERENCE','snapshot.characters');characters.add(value.character_id);}
  for(const thread of snapshot.plot_threads){const setup=ordered.findIndex(value=>value.id===thread.setup_episode_id),payoff=ordered.findIndex(value=>value.id===thread.payoff_episode_id);if(setup>index-1||thread.payoff_episode_id!==null&&payoff<setup)fail('INVALID_REFERENCE','snapshot.plot_threads');}
  let adoption:AdoptionRecord;
  try{adoption=nativeProof(stored.state,snapshot);}catch(error){if(error instanceof ContinuityError)throw error;fail('STORAGE_FAILED','snapshot.history');}
  // A legacy free-text knowledge source is carried as a human-adopted assertion, never upgraded into typed event evidence.
  const result={...common,kind:'ready' as const,previousEpisodeId:previous.id,snapshotAdoptedRevision:adoption.to_revision,snapshot,adoption};
  try{return freezeContinuity(snapshotJson(result,CONTINUITY_LEDGER_BYTES));}catch{throw new ContinuityError('INPUT_LIMIT','native handoff result','$');}
}
