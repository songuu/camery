import {z} from 'zod';
import {ChangeSetV07,ChangeSetV08,StableId,StoryboardPackageV07,StoryboardPackageV08,validatePackage} from '@camery/ir';
import {OutlineError} from '../contracts.js';
import {deepFreeze} from '../boundary.js';
import type {OutlineProgress} from './persistence-contracts.js';
import {OutlineAdoptionSourceSchema,OutlineFormalIdentitiesSchema,OutlineReviewerBindingSchema,OutlineMappingDraftSchema,OUTLINE_MAPPING_CHANGE_BYTES,OUTLINE_MAPPING_MAX_OPERATIONS} from './formal-contracts.js';
import type {OutlineAdoptionSource,OutlineFormalIdentities,OutlineReviewerBinding,OutlineMappingDraft,OutlineMappingCollection} from './formal-contracts.js';
import {captureOutlineFormal,copyOutlineFormal,equalOutlineFormal} from './formal-data.js';
import {captureOutlineAdoptionProgress} from './formal-source.js';
import {projectOutlineFormal,readOutlineFormalProjection} from './formal-projection.js';
import type {OutlineFormalProjection,OutlineProjectionBinding} from './formal-projection.js';

const stable=StableId.refine(value=>value.length===26);
const Input=z.strictObject({progress:z.unknown(),source:OutlineAdoptionSourceSchema,identities:OutlineFormalIdentitiesSchema,reviewer:OutlineReviewerBindingSchema,head:z.unknown()});
const Final=z.strictObject({draft:OutlineMappingDraftSchema,changeSetId:stable,author:z.strictObject({kind:z.literal('user'),id:stable}),operationIds:z.array(z.strictObject({slot:z.string().min(1).max(160),id:stable})).max(OUTLINE_MAPPING_MAX_OPERATIONS)});
type Row=Record<string,unknown>&{id:string;version:number};
const groups={characters:'characters',episodes:'episodes',beats:'outline_beats',episodePlans:'outline_episode_plans',assets:'asset_plans',plotUnits:'outline_plot_units',decisions:'outline_adaptation_decisions'} as const;
const children=['outline_beats','outline_episode_plans','asset_plans','outline_plot_units','outline_adaptation_decisions'] as const;
function conflict(path:string):never{throw new OutlineError('CONFLICT','formal mapping',path);}
function unique(values:readonly unknown[],path:string):void{if(new Set(values).size!==values.length)conflict(path);}
function next(version:number):number{if(version>=Number.MAX_SAFE_INTEGER)throw new OutlineError('INPUT_LIMIT','formal revision','version');return version+1;}
function objects(head:StoryboardPackageV07|StoryboardPackageV08):Map<string,{collection:string;value:Row}>{
  const rows=new Map<string,{collection:string;value:Row}>();
  for(const [collection,values] of Object.entries(head))if(Array.isArray(values))for(const value of values)if(value&&typeof value==='object'&&'id' in value&&'version' in value)rows.set(value.id,{collection,value:value as Row});return rows;
}
function complete(rows:readonly {localId:string;id:string}[],expected:readonly {id:string}[],path:string):void{
  unique(rows.map(row=>row.localId),path);const ids=new Set(rows.map(row=>row.localId));if(ids.size!==expected.length||expected.some(row=>!ids.has(row.id)))conflict(path);
}
function projectedRows(projection:OutlineFormalProjection):[OutlineMappingCollection,Row][]{
  const rows:[OutlineMappingCollection,Row][]=[['adaptation_plans',projection.plan as unknown as Row]];
  for(const [key,collection] of Object.entries(groups) as [keyof typeof groups,typeof groups[keyof typeof groups]][])for(const row of projection[key])rows.push([collection,row as unknown as Row]);return rows;
}

/** Integrity-only preparation. A host must persist the identity bindings and fixed operation IDs, then authorize adoption with a current source guard. */
export function prepareOutlineMappingDraft(input:{progress:OutlineProgress;source:OutlineAdoptionSource;identities:OutlineFormalIdentities;reviewer:OutlineReviewerBinding;head:unknown}):OutlineMappingDraft{
  const raw=captureOutlineFormal(Input,input,'formal mapping input'),{source,identities,reviewer}=raw;
  const progress=captureOutlineAdoptionProgress(source,raw.progress),{run,review}=progress;
  if(identities.tenantId!==run.tenantId||identities.projectId!==run.projectId||identities.owner.runId!==run.runId||identities.owner.runDigest!==run.digest||reviewer.key!==review.actorId)conflict('source identities');
  const head=captureOutlineFormal(z.discriminatedUnion('schema_version',[StoryboardPackageV07,StoryboardPackageV08]),raw.head,'formal outline head');
  if(head.project.id!==identities.target.projectId||head.revision.status!=='adopted'||!validatePackage(head).valid)conflict('adopted head');
  const output=review.output;
  for(const key of ['characters','beats','assets','plotUnits'] as const)complete(identities[key],output[key],key);
  complete(identities.decisions,output.adaptation.decisions,'decisions');unique(identities.episodes.map(row=>row.number),'episode slots');
  const slots=new Map(identities.episodes.map(row=>[row.number,row]));
  if(identities.episodes.length<run.brief.episodeCount||identities.episodes.some((_,index)=>!slots.has(index+1))||output.episodes.some(row=>!slots.has(row.number)))conflict('complete episode slots');
  const mappedIds=[identities.planId,...['characters','beats','assets','plotUnits','decisions'].flatMap(key=>identities[key as 'characters'].map(row=>row.id)),...identities.episodes.flatMap(row=>[row.episodeId,row.planId])];
  unique(mappedIds,'global identities');
  const existing=objects(head),protectedIds=[head.package_id,head.project.id,...head.locations.flatMap(row=>row.spots.map(spot=>spot.id))];
  if(mappedIds.some(id=>protectedIds.includes(id)||id===reviewer.id))conflict('reserved identity');
  const bases=new Map<string,number>();
  const find=(collection:OutlineMappingCollection,id:string):Row|undefined=>{const old=existing.get(id);if(old&&old.collection!==collection)conflict('identity collection');if(old)bases.set(id,old.value.version);return old?.value;};
  const oldPlan=find('adaptation_plans',identities.planId);
  if(oldPlan){const owner=oldPlan['source'] as {tenant_key:string;project_key:string};if(owner.tenant_key!==run.tenantId||owner.project_key!==run.projectId)conflict('existing plan owner');}
  for(const slot of identities.episodes){find('episodes',slot.episodeId);const old=find('outline_episode_plans',slot.planId);if(old&&(old['adaptation_plan'] as {id:string}).id!==identities.planId)conflict('reserved episode plan owner');}
  const reference=(collection:OutlineMappingCollection,id:string)=>({id,version:find(collection,id)?.version??1});
  const map=(key:'characters'|'beats'|'assets'|'plotUnits'|'decisions',collection:OutlineMappingCollection)=>new Map(identities[key].map(row=>[row.localId,reference(collection,row.id)]));
  const metadata=new Map<string,{role:string;defaultVoiceRefId:string|null}>();
  for(const row of identities.characters){const old=find('characters',row.id);if(old)metadata.set(row.id,{role:old['role'] as string,defaultVoiceRefId:old['default_voice_ref_id'] as string|null});}
  let binding:OutlineProjectionBinding={plan:reference('adaptation_plans',identities.planId),characters:map('characters','characters'),beats:map('beats','outline_beats'),assets:map('assets','asset_plans'),plotUnits:map('plotUnits','outline_plot_units'),decisions:map('decisions','outline_adaptation_decisions'),episodes:new Map(output.episodes.map(row=>{const slot=slots.get(row.number)!;return [row.number,{episodeId:slot.episodeId,episodeVersion:find('episodes',slot.episodeId)?.version??1,plan:reference('outline_episode_plans',slot.planId)}];})),reviewer,characterMetadata:metadata};
  let projection=projectOutlineFormal(review,run.method,run,binding);
  // Characters and actual Episodes have independent revisions; planned objects form one mutually pinned revision epoch.
  const revised=(collection:OutlineMappingCollection,row:{id:string;version:number})=>{const old=find(collection,row.id);return old&&!equalOutlineFormal(old,row)?next(old.version):row.version;};
  binding={...binding,characters:new Map([...binding.characters].map(([local,ref])=>[local,{...ref,version:revised('characters',projection.characters.find(row=>row.id===ref.id)!)}])),episodes:new Map([...binding.episodes].map(([number,ref])=>[number,{...ref,episodeVersion:revised('episodes',projection.episodes.find(row=>row.id===ref.episodeId)!)}]))};
  projection=projectOutlineFormal(review,run.method,run,binding);
  const desiredIds=new Set(projectedRows(projection).map(([,row])=>row.id));
  const obsolete:[OutlineMappingCollection,Row][]=[];
  for(const collection of children)for(const row of head[collection])if(row.adaptation_plan.id===identities.planId&&!desiredIds.has(row.id)){find(collection,row.id);obsolete.push([collection,row as unknown as Row]);}
  for(const [collection,row] of projectedRows(projection))if((children as readonly string[]).includes(collection)){
    const old=find(collection,row.id);if(old&&(old['adaptation_plan'] as {id:string}).id!==identities.planId)conflict('existing child owner');
  }
  if(obsolete.length||projectedRows(projection).some(([collection,row])=>!equalOutlineFormal(find(collection,row.id)??null,row))){
    const advance=(collection:OutlineMappingCollection,ref:{id:string;version:number})=>({...ref,version:find(collection,ref.id)?next(ref.version):1});
    const advanceMap=(collection:OutlineMappingCollection,refs:ReadonlyMap<string,{id:string;version:number}>)=>new Map([...refs].map(([key,ref])=>[key,advance(collection,ref)]));
    binding={...binding,plan:advance('adaptation_plans',binding.plan),beats:advanceMap('outline_beats',binding.beats),assets:advanceMap('asset_plans',binding.assets),plotUnits:advanceMap('outline_plot_units',binding.plotUnits),decisions:advanceMap('outline_adaptation_decisions',binding.decisions),episodes:new Map([...binding.episodes].map(([number,row])=>[number,{...row,plan:advance('outline_episode_plans',row.plan)}]))};
    projection=projectOutlineFormal(review,run.method,run,binding);
  }
  if(!equalOutlineFormal(readOutlineFormalProjection(projection,binding),output))conflict('reviewed field preservation');
  const operations:OutlineMappingDraft['operations']=[];
  const preview=copyOutlineFormal(head),record=preview as unknown as Record<string,Row[]>;
  for(const [collection,row] of projectedRows(projection)){
    const old=find(collection,row.id);if(old&&equalOutlineFormal(old,row))continue;
    const op=old?{op:'replace' as const,collection,target:row.id,value:{...row,version:old.version}}:{op:'add' as const,collection,value:row};
    operations.push({slot:`${collection}:${row.id}:${op.op}`,op});record[collection]=[...record[collection]!.filter(value=>value.id!==row.id),row];
  }
  for(const [collection,row] of obsolete){operations.push({slot:`${collection}:${row.id}:remove`,op:{op:'remove',collection,target:row.id}});record[collection]=record[collection]!.filter(value=>value.id!==row.id);}
  // The versioning kernel derives these counters after operations; validate the same prospective state here.
  preview.project.scope.expected_episode_count=preview.episodes.length;
  preview.project.scope.expected_scene_count=preview.scenes.length;
  preview.project.scope.expected_required_beat_count=preview.beats.filter(row=>row.required).length;
  if(!validatePackage(preview).valid)conflict('prospective formal graph');
  // Keep the stored v07 draft byte-for-byte compatible; only v08 introduces a discriminator.
  return deepFreeze(captureOutlineFormal(OutlineMappingDraftSchema,{version:1,...(head.schema_version==='0.8.0-draft'?{schemaVersion:head.schema_version}:{}),target:identities.target,source,baseRevision:head.revision.number,baseRevisions:[...bases].sort(([a],[b])=>a.localeCompare(b)).map(([id,version])=>({id,version})),operations,reservedIds:[...new Set([...protectedIds,...existing.keys(),...mappedIds,reviewer.id,identities.target.tenantId])]},'formal mapping draft'));
}

/** Finalize a trusted prepared draft with application-intent IDs; this does not authorize a public request. */
export function finalizeOutlineChangeSet(input:{draft:OutlineMappingDraft;changeSetId:string;author:{kind:'user';id:string};operationIds:readonly {slot:string;id:string}[]}):ChangeSetV07|ChangeSetV08{
  const {draft,changeSetId,author,operationIds}=captureOutlineFormal(Final,input,'formal change finalization');
  if(!draft.operations.length)throw new OutlineError('INCOMPLETE','unchanged formal draft','operations');
  unique(draft.operations.map(row=>row.slot),'operation slots');unique(draft.baseRevisions.map(row=>row.id),'base revisions');unique(operationIds.map(row=>row.slot),'fixed slots');unique(operationIds.map(row=>row.id),'fixed identities');
  const fixed=new Map(operationIds.map(row=>[row.slot,row.id])),reserved=new Set(draft.reservedIds);
  if(fixed.size!==draft.operations.length||draft.operations.some(row=>!fixed.has(row.slot)))conflict('complete fixed identities');
  if(reserved.has(changeSetId)||changeSetId===author.id||operationIds.some(row=>reserved.has(row.id)||row.id===changeSetId||row.id===author.id))conflict('reserved change identity');
  const bases=new Map(draft.baseRevisions.map(row=>[row.id,row.version])),targets:string[]=[];
  const ops=draft.operations.map(({slot,op})=>{const id=captureOutlineFormal(stable,op.op==='add'?op.value['id']:op.target,'formal operation target',1024);targets.push(id);
    if(slot!==`${op.collection}:${id}:${op.op}`)conflict('operation slot binding');
    if(op.op==='add'?bases.has(id)||op.value['version']!==1:!bases.has(id)||op.op==='replace'&&(op.value['id']!==id||op.value['version']!==bases.get(id)))conflict('operation base');
    if(!reserved.has(id))conflict('unreserved operation target');return {...op,op_id:fixed.get(slot)!};
  });unique(targets,'operation targets');
  return deepFreeze(captureOutlineFormal(z.discriminatedUnion('schema_version',[ChangeSetV07,ChangeSetV08]),{schema_version:draft.schemaVersion??'0.7.0-draft',id:changeSetId,base_revision:draft.baseRevision,author,status:'candidate',base_revisions:draft.baseRevisions,ops},'formal outline ChangeSet',OUTLINE_MAPPING_CHANGE_BYTES));
}
