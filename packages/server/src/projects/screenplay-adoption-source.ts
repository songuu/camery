import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import {StoryboardPackage} from '@camery/ir';
import {Id} from '@camery/script/contracts';
import {PostgresScreenplayGenerationStore,prepareScreenplayNativeMapping,screenplayNativeSlots,readScreenplayNativeIntent,readScreenplayNativeIntentForChange,readScreenplayNativeAdoption,readScreenplayHandoff} from '@camery/script/screenplay/node';
import type {PostgresScreenplayStore,ScreenplayHost,ScreenplayProgress} from '@camery/script/screenplay/node';
import type {PostgresOutlineStore} from '@camery/script/outline/node';
import {ProjectApplicationError} from './intent-contracts.js';
import {captureProjectCommand,projectCommandDigest} from './project-command-data.js';
import {projectCommandTransaction} from './project-command-transaction.js';
import {ScreenplayProjectIntentBodySchema,ScreenplayProjectTargetSchema} from './screenplay-intent-contracts.js';
import type {ScreenplayProjectIntent} from './screenplay-intent-contracts.js';
import {captureScreenplayProjectIntent} from './screenplay-intent-codec.js';
import {captureScreenplayExecution} from './screenplay-intent-receipts.js';

type Scripts=Pick<PostgresScreenplayStore,'readHistorical'|'readCurrentForPrecheck'|'readForAdoption'>;
type Outline=Pick<PostgresOutlineStore,'readForAdoption'|'readHistoricalForAdoption'>;
type Generations=Pick<PostgresScreenplayGenerationStore,'readHistoricalForQuality'>;
const SOURCE_BYTES=67108864,EXECUTION_BYTES=8388608;
const SourceSelection=z.strictObject({key:ScreenplayProjectIntentBodySchema.shape.sourceKey,target:ScreenplayProjectTargetSchema});
const NativeSelection=z.strictObject({scope:ScreenplayProjectIntentBodySchema.shape.scope,target:ScreenplayProjectTargetSchema,changeId:ScreenplayProjectIntentBodySchema.shape.changeId});
type SourceSelection=z.infer<typeof SourceSelection>;
const same=(a:unknown,b:unknown)=>projectCommandDigest(a,SOURCE_BYTES)===projectCommandDigest(b,SOURCE_BYTES);
function failed(operation:string):never{throw new ProjectApplicationError('STORAGE_FAILED',operation);}
export type ScreenplayProducer={kind:'manual'}|{kind:'pending_generation';runId:string}|{kind:'generation';runId:string;runDigest:string;candidateDigest:string;deliveryDigest:string};
export interface ScreenplayAdoptionSourceOptions{pool:Pool;scripts:Scripts;outline:Outline;generations?:Generations}

/** Actual source/proof reader. Queries never infer a human origin merely from a missing generation delivery. */
export class PostgresScreenplayAdoptionSource{
  private readonly generations:Generations;
  constructor(private readonly options:ScreenplayAdoptionSourceOptions){this.generations=options.generations??new PostgresScreenplayGenerationStore(options.pool,options.outline);}
  private async producer(client:PoolClient,progress:ScreenplayProgress,host:ScreenplayHost):Promise<ScreenplayProducer>{
    const key=progress.preparation.key;
    const installed=await client.query<{runs:boolean;candidates:boolean;deliveries:boolean}>("SELECT to_regclass('camery_screenplay.generation_runs') IS NOT NULL AS runs,to_regclass('camery_screenplay.generation_candidates') IS NOT NULL AS candidates,to_regclass('camery_screenplay.generation_deliveries') IS NOT NULL AS deliveries");
    const schema=installed.rows[0];if(installed.rows.length!==1||!schema||![schema.runs,schema.candidates,schema.deliveries].every(value=>typeof value==='boolean'))failed('screenplay generation installation');
    if(!schema.runs&&!schema.candidates&&!schema.deliveries)return {kind:'manual'};
    if(!schema.runs||!schema.candidates||!schema.deliveries)failed('screenplay partial generation installation');
    const owner=await client.query<{run_id:string}>('SELECT run_id FROM camery_screenplay.generation_runs WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3',[key.tenantId,key.projectId,key.candidateId]);
    const links=await client.query<{run_id:string}>('SELECT run_id FROM camery_screenplay.generation_deliveries WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3',[key.tenantId,key.projectId,key.candidateId]);
    if(owner.rows.length>1||links.rows.length>1)failed('screenplay generation owner cardinality');
    if(owner.rows.length===1&&links.rows.length===0){if(!Id.safeParse(owner.rows[0]!.run_id).success)failed('screenplay pending generation identity');return {kind:'pending_generation',runId:owner.rows[0]!.run_id};}
    if(!owner.rows.length&&!links.rows.length)return {kind:'manual'};
    if(owner.rows.length!==1||links.rows.length!==1||owner.rows[0]!.run_id!==links.rows[0]!.run_id||!Id.safeParse(owner.rows[0]!.run_id).success)failed('screenplay generation owner binding');
    const runId=owner.rows[0]!.run_id,generated=await this.generations.readHistoricalForQuality(client,{tenantId:key.tenantId,projectId:key.projectId,runId},host),run=generated.run,delivery=generated.delivery,candidate=generated.candidate;
    if(!delivery||!candidate||run.tenantId!==key.tenantId||run.projectId!==key.projectId||run.runId!==runId||run.candidateId!==key.candidateId||delivery.preparationDigest!==progress.preparation.digest||!same(delivery.candidateKey,key)||delivery.runDigest!==run.digest||delivery.generatedDigest!==candidate.digest||!same(candidate.candidate,progress.preparation.candidate))failed('screenplay actual generation delivery');
    return {kind:'generation',runId,runDigest:run.digest,candidateDigest:candidate.digest,deliveryDigest:delivery.digest};
  }
  private async load(client:PoolClient,selection:SourceSelection,host:ScreenplayHost,current:boolean){
    const raw=await (current?this.options.scripts.readCurrentForPrecheck:this.options.scripts.readHistorical).call(this.options.scripts,client,selection.key,host),p=raw.preparation;
    if(!same(p.key,selection.key)||!same(p.source.native.target,selection.target))failed('screenplay source project binding');
    if(!raw.review)throw new ProjectApplicationError('CONFLICT','screenplay source requires human review');
    if(current&&raw.current!==true)throw new ProjectApplicationError('CONFLICT','screenplay source no longer current');
    const snapshots=await client.query('SELECT package FROM camery_versioning.snapshots WHERE tenant_id=$1 AND project_id=$2 AND revision=$3',[selection.target.tenantId,selection.target.projectId,p.source.native.snapshotRevision]);
    if(snapshots.rows.length!==1)failed('screenplay original native snapshot');
    const head=captureProjectCommand(StoryboardPackage,snapshots.rows[0].package,'screenplay original source snapshot',SOURCE_BYTES);
    if(head.project.id!==selection.target.projectId||head.package_id!==p.context.packageId||head.revision.number!==p.source.native.snapshotRevision||head.revision.status!=='adopted')failed('screenplay original snapshot identity');
    const producer=await this.producer(client,raw,host),progress={...raw,current};return {head,progress,producer};
  }
  async readReviewed(input:unknown,host:ScreenplayHost){const selection=captureProjectCommand(SourceSelection,input,'screenplay reviewed source selector',4096);return projectCommandTransaction(this.options.pool,'screenplay reviewed source',client=>this.load(client,selection,host,true));}
  async materialize(input:ScreenplayProjectIntent,host:ScreenplayHost){
    const intent=captureScreenplayProjectIntent(input);
    return projectCommandTransaction(this.options.pool,'screenplay original mapping',async client=>{
      const source=await this.load(client,{key:intent.sourceKey,target:intent.target},host,false),p=source.progress.preparation,review=source.progress.review!;
      const slots=screenplayNativeSlots(review.output.draft);
      if(p.digest!==intent.preparationDigest||review.digest!==intent.reviewDigest||p.source.native.packageDigest!==intent.packageDigest||p.source.contextDigest!==intent.contextDigest||p.source.native.snapshotRevision!==intent.expectation.expectedSnapshotRevision||p.context.episode.id!==intent.episodeId||slots.length!==intent.ids.length||projectCommandDigest(slots,EXECUTION_BYTES)!==intent.slotsDigest)failed('screenplay immutable source and identities');
      const ids=slots.map((slot,index)=>({slot,id:intent.ids[index]!})),mapping=prepareScreenplayNativeMapping({head:source.head,context:p.context,candidate:p.candidate,review,target:intent.target,changeId:intent.changeId,author:{kind:'user',id:intent.actor.id},ids});
      if(mapping.packageDigest!==intent.packageDigest||mapping.contextDigest!==intent.contextDigest||mapping.reviewDigest!==intent.reviewDigest)failed('screenplay original source mapping pins');
      const original=await readScreenplayNativeIntentForChange(client,{scope:intent.scope,target:intent.target,changeId:intent.changeId},host);
      if(original&&(!same(original.mapping,mapping)||!same(original.ids,ids)||!same(original.key,intent.sourceKey)))failed('screenplay original committed mapping');
      return {...source,binding:original,execution:captureScreenplayExecution({key:intent.sourceKey,mapping,ids,expectation:intent.expectation})};
    });
  }
  async nativeCandidate(input:unknown,host:ScreenplayHost){
    const selection=captureProjectCommand(NativeSelection,input,'screenplay native source selector',4096);
    return projectCommandTransaction(this.options.pool,'screenplay native candidate source',async client=>{
      const binding=await readScreenplayNativeIntentForChange(client,selection,host);if(!binding)return null;
      const source=await this.load(client,{key:binding.key,target:selection.target},host,false),p=source.progress.preparation;
      const mapping=prepareScreenplayNativeMapping({head:source.head,context:p.context,candidate:p.candidate,review:source.progress.review!,target:selection.target,changeId:selection.changeId,author:binding.mapping.request.author as {kind:'user';id:string},ids:binding.ids});
      if(!same(mapping,binding.mapping))failed('screenplay complete reviewed native binding');return {...source,binding};
    });
  }
  async sourceBinding(input:unknown,host:ScreenplayHost){
    const selection=captureProjectCommand(SourceSelection,input,'screenplay original intention selector',4096);
    return projectCommandTransaction(this.options.pool,'screenplay original source intention',async client=>{const binding=await readScreenplayNativeIntent(client,selection.key,host);if(binding&&!same(binding.mapping.target,selection.target))failed('screenplay original intention target');return binding;});
  }
  async handoff(input:unknown,host:ScreenplayHost){const selection=captureProjectCommand(NativeSelection,input,'screenplay handoff selector',4096);return projectCommandTransaction(this.options.pool,'screenplay actual ledger handoff',client=>readScreenplayHandoff(client,selection,this.options.scripts,this.options.outline,host));}
  async adoptionProof(input:unknown,host:ScreenplayHost){const selection=captureProjectCommand(NativeSelection,input,'screenplay actual adoption selector',4096);return projectCommandTransaction(this.options.pool,'screenplay original adoption proof',client=>readScreenplayNativeAdoption(client,selection,this.options.scripts,host));}
}
