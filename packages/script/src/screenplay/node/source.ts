import {z} from 'zod';
import type {PoolClient} from 'pg';
import {StoryboardPackage,outlineDependencyIssues} from '@camery/ir';
import type {StoryboardPackage as Package} from '@camery/ir';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {SCREENPLAY_CONTEXT_BYTES,ScreenplayError,ScreenplayRulesSchema,ScreenplayContextSchema} from '../contracts.js';
import type {ScreenplayContext,ScreenplayReference} from '../contracts.js';
import {validateScreenplayContext} from '../context.js';
import {OutlineError} from '../../outline/contracts.js';
import {ContinuityError} from '../../continuity/contracts.js';
import {ContinuitySourceSelectionSchema,ContinuitySourceSchema,ContinuityPreviousSchema,ContinuityScopeSchema} from '../../continuity/node/persistence-contracts.js';
import type {ContinuityPrevious} from '../../continuity/node/persistence-contracts.js';
import {readContinuitySource,readStoredContinuitySource,resolveContinuityNativePredecessor} from '../../continuity/node/source.js';
import type {ContinuitySourceView} from '../../continuity/node/source.js';
import {continuityDigest,canonicalContinuity} from '../../continuity/node/digest.js';
import type {PostgresOutlineStore} from '../../outline/node/store.js';
import {captureOutlineAdoptionProgress} from '../../outline/node/formal-source.js';
import {validateOutlineSourceSnapshot} from '../../outline/node/source.js';
import type {OutlineSourceSnapshot} from '../../outline/generation-contracts.js';

const Selection=ContinuitySourceSelectionSchema.extend({rules:ScreenplayRulesSchema});
export const ScreenplaySourceSchema=z.strictObject({version:z.literal(1),native:ContinuitySourceSchema,contextDigest:z.string().regex(/^[a-f0-9]{64}$/)});
export type ScreenplaySource=z.infer<typeof ScreenplaySourceSchema>;
export interface ScreenplaySourceView{readonly source:ScreenplaySource;readonly context:ScreenplayContext;readonly head:Package;readonly previous:ContinuityPrevious|null}
function refuse(path:string):never{throw new ScreenplayError('CONFLICT','adopted screenplay source',path);}
function safe(error:unknown,operation:string):never{
  let known=false,code:ScreenplayError['code']|undefined;
  try{known=error instanceof ScreenplayError;if(error instanceof OutlineError||error instanceof ContinuityError){const value=error.code;if(['INVALID_INPUT','INPUT_LIMIT','INVALID_REFERENCE','INCOMPLETE','CONFLICT','FORBIDDEN','NOT_FOUND','STORAGE_FAILED'].includes(value))code=value as ScreenplayError['code'];else if(value==='UNADOPTED_SNAPSHOT')code='INCOMPLETE';}}catch{/* Dependency prototype traps cannot become public diagnostics. */}
  if(known)throw error;throw new ScreenplayError(code??'STORAGE_FAILED',operation,'storage');
}

function strings(value:unknown,quotesOnly:boolean):string[]{
  const result:string[]=[];
  function visit(current:unknown,key=''):void{
    if(typeof current==='string'){if(quotesOnly?key==='quote':!['id','kind','source_ref_ids'].includes(key))result.push(current);}
    else if(Array.isArray(current))for(const item of current)visit(item,key);
    else if(current&&typeof current==='object')for(const [name,item] of Object.entries(current))visit(item,name);
  }
  visit(value);return [...new Set(result)].filter(text=>text.trim().length>0&&text.length<=2000);
}
/** Catalog paths were reconstructed by the immutable Outline source validator, never supplied by a model. */
export function projectScreenplayReferences(input:unknown):ScreenplayReference[]{
  const snapshot=validateOutlineSourceSnapshot(input);
  return snapshot.references.map(reference=>{
    let value:unknown=snapshot.material;
    for(const key of reference.path.slice(1).split('/')){
      if(!value||typeof value!=='object'||!Object.hasOwn(value,key))refuse('source reference path');
      value=(value as Record<string,unknown>)[key];
    }
    return {...reference,kind:snapshot.descriptor.kind==='bible'?'reviewed_bible':'original_development',text:JSON.stringify(value),quotes:strings(value,snapshot.descriptor.kind==='bible')};
  });
}
function sourceDescriptor(source:{tenant_key:string;project_key:string;run_id:string;run_digest:string;brief_digest:string;candidate_digest:string;review_digest:string;source_digest:string}){
  return {tenantId:source.tenant_key,projectId:source.project_key,runId:source.run_id,runDigest:source.run_digest,briefDigest:source.brief_digest,candidateDigest:source.candidate_digest,reviewDigest:source.review_digest,sourceDigest:source.source_digest};
}
async function assemble(client:PoolClient,selection:z.infer<typeof Selection>,view:ContinuitySourceView,readOutline:(client:PoolClient,descriptor:unknown)=>ReturnType<PostgresOutlineStore['readForAdoption']>):Promise<ScreenplaySourceView>{
    const rows=await client.query('SELECT package FROM camery_versioning.snapshots WHERE tenant_id=$1 AND project_id=$2 AND revision=$3',[selection.target.tenantId,selection.target.projectId,view.source.snapshotRevision]);
    if(rows.rows.length!==1)refuse('snapshot cardinality');
    const head=captureScreenplay(StoryboardPackage,rows.rows[0].package,'screenplay native source',SCREENPLAY_CONTEXT_BYTES);
    if(head.schema_version!=='0.7.0-draft'&&head.schema_version!=='0.8.0-draft')throw new ScreenplayError('INCOMPLETE','formal screenplay source','schemaVersion');
    if(continuityDigest(head,SCREENPLAY_CONTEXT_BYTES)!==view.source.packageDigest)refuse('snapshot digest');
    const plans=head.outline_episode_plans.filter(row=>row.episode_id===selection.episodeId);if(plans.length!==1)refuse('unique episode plan');const episodePlan=plans[0]!;
    const plan=head.adaptation_plans.find(row=>row.id===episodePlan.adaptation_plan.id&&row.version===episodePlan.adaptation_plan.version);if(!plan)refuse('adopted plan');
    const dependencies=outlineDependencyIssues(head);const selectedIds=new Set([plan.id,episodePlan.id,...episodePlan.beats.map(row=>row.id)]);
    if(dependencies.some(row=>selectedIds.has(row.objectId)))refuse('outline freshness');
    const descriptor=sourceDescriptor(plan.source);
    if(descriptor.tenantId!==selection.scope.tenantId||descriptor.projectId!==selection.scope.projectId)throw new ScreenplayError('FORBIDDEN','outline source scope','scope');
    const progress=captureOutlineAdoptionProgress(descriptor,await readOutline(client,descriptor));
    const material:OutlineSourceSnapshot=validateOutlineSourceSnapshot(progress.run.source);
    if(material.digest!==plan.source.source_digest)refuse('original source');
    const episode=view.context.episodes.find(row=>row.id===selection.episodeId)!,nativeEpisode=head.episodes.find(row=>row.id===episode.id)!;
    const beats=episodePlan.beats.map(ref=>{const row=head.outline_beats.find(value=>value.id===ref.id&&value.version===ref.version);if(!row)refuse('outline beat version');return row;}).sort((a,b)=>a.order-b.order);
    const previous=view.previous;
    const context=validateScreenplayContext({version:1,schemaVersion:head.schema_version,projectId:head.project.id,packageId:head.package_id,snapshotRevision:head.revision.number,episode:{...episode,title:nativeEpisode.title,targetSeconds:nativeEpisode.target_seconds},
      outline:{plan:{id:plan.id,version:plan.version},episodePlan:{id:episodePlan.id,version:episodePlan.version},sourceDigest:material.digest,synopsis:episodePlan.synopsis,openingHook:{type:episodePlan.opening_hook.type,text:episodePlan.opening_hook.text,beat:episodePlan.opening_hook.beat},cliffhanger:{type:episodePlan.cliffhanger.type,text:episodePlan.cliffhanger.text,beat:episodePlan.cliffhanger.beat},beats:beats.map(row=>({ref:{id:row.id,version:row.version},order:row.order,characters:row.characters,goal:row.goal,conflict:row.conflict,turn:row.turn,consequence:row.consequence,referenceIds:row.origin.source_ref_ids}))},
      characters:head.characters.map(row=>({id:row.id,version:row.version,name:row.name,role:row.role})),locations:head.locations.map(row=>({id:row.id,version:row.version,name:row.name,description:row.description})),references:projectScreenplayReferences(material),nativeContext:view.context,rules:selection.rules,
      previous:previous?{episode:view.context.episodes[episode.number-2]!,snapshot:previous.snapshot,adoptedRevision:previous.adoptedRevision,proofDigest:previous.digest,ledger:previous.ledger}:null});
    return freezeScreenplay({head,context,previous:view.previous,source:{version:1,native:view.source,contextDigest:continuityDigest(context,SCREENPLAY_CONTEXT_BYTES)}});
}
/** Caller owns a READ COMMITTED transaction. Outline/upstream locks precede the native project lock. */
export async function readScreenplaySource(client:PoolClient,input:unknown,outline:Pick<PostgresOutlineStore,'readForAdoption'>):Promise<ScreenplaySourceView>{
  const selection=freezeScreenplay(captureScreenplay(Selection,input,'screenplay source selection',32768));
  try{
    // Reused source stores predate qualified advisory calls. A caller-owned transaction may not expose
    // public overloads while checking their locks; LOCAL leaves the pool's session configuration intact.
    await client.query('SET LOCAL search_path = pg_catalog');
    const nativeSelection={scope:selection.scope,target:selection.target,episodeId:selection.episodeId};
    const view=await readContinuitySource(client,nativeSelection,{previousFor:resolveContinuityNativePredecessor});
    const assembled=await assemble(client,selection,view,outline.readForAdoption.bind(outline));
    const locked=await readContinuitySource(client,nativeSelection,{lock:true,previousFor:resolveContinuityNativePredecessor});
    if(canonicalContinuity(locked.source,32768)!==canonicalContinuity(view.source,32768))refuse('source changed during locking');
    return assembled;
  }catch(error){
    return safe(error,'adopted screenplay source');
  }
}
const Stored=z.strictObject({scope:ContinuityScopeSchema,source:ScreenplaySourceSchema,context:ScreenplayContextSchema,previous:ContinuityPreviousSchema.nullable()});
/** Historical integrity for audit/recovery. It never grants freshness or initiates a new publication. */
export async function readStoredScreenplaySource(client:PoolClient,input:unknown,outline:Pick<PostgresOutlineStore,'readHistoricalForAdoption'>):Promise<ScreenplaySourceView>{
  const stored=freezeScreenplay(captureScreenplay(Stored,input,'stored screenplay source',SCREENPLAY_CONTEXT_BYTES));
  try{
    const view=await readStoredContinuitySource(client,{source:stored.source.native,previous:stored.previous});
    const selection={scope:stored.scope,target:stored.source.native.target,episodeId:stored.source.native.episodeId,rules:stored.context.rules};
    const actual=await assemble(client,selection,view,outline.readHistoricalForAdoption.bind(outline));
    if(actual.source.contextDigest!==stored.source.contextDigest||continuityDigest(stored.context,SCREENPLAY_CONTEXT_BYTES)!==actual.source.contextDigest)refuse('stored screenplay context');
    return actual;
  }catch(error){return safe(error,'historical screenplay source');}
}
