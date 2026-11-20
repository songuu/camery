import {z} from 'zod';
import type {PoolClient} from 'pg';
import {ModelReceiptSchema,digest} from '@camery/methods';
import {StableId} from '@camery/ir';
import {Id,Hash} from '../../contracts.js';
import {OutlineError} from '../../outline/contracts.js';
import {outlineContext} from '../../outline/node/generation.js';
import {validateOutlineSourceSnapshot} from '../../outline/node/source.js';
import {captureOutlineAdoptionProgress} from '../../outline/node/formal-source.js';
import {OutlineKeySchema} from '../../outline/node/persistence-contracts.js';
import type {OutlineProgress} from '../../outline/node/persistence-contracts.js';
import type {PostgresOutlineStore} from '../../outline/node/store.js';
import {ScreenplayError} from '../../screenplay/contracts.js';
import {ScreenplayKeySchema,ScreenplayScopeSchema} from '../../screenplay/node/contracts.js';
import {readStoredScreenplaySource} from '../../screenplay/node/source.js';
import {readScreenplayNativeAdoption,readScreenplayHandoff} from '../../screenplay/node/handoff.js';
import type {PostgresScreenplayStore} from '../../screenplay/node/store.js';
import type {PostgresScreenplayGenerationStore} from '../../screenplay/node/generation-store.js';
import {ContinuityTargetSchema} from '../../continuity/node/persistence-contracts.js';
import {QualitySubjectSchema,QualityError,QualityNameSchema,QUALITY_MATERIAL_BYTES} from '../contracts.js';
import {QualitySourceReferenceSchema} from '../state.js';
import {captureQuality,freezeQuality} from '../boundary.js';
import {authorizeQualityHost} from './host.js';
import {qualityDigest,equalQualityData} from './data.js';
const Variant=z.enum(['candidate','reviewed']);
const outlineSelection=z.strictObject({kind:z.literal('outline'),key:OutlineKeySchema,variant:Variant,expectedRunDigest:Hash,expectedCandidateDigest:Hash,expectedReviewDigest:Hash.nullable()});
const scriptSelection=z.strictObject({kind:z.literal('screenplay'),key:ScreenplayKeySchema,variant:Variant,expectedPreparationDigest:Hash,expectedReviewDigest:Hash.nullable(),finalization:z.strictObject({target:ContinuityTargetSchema,changeId:StableId,expectedReceiptDigest:Hash}).nullable()});
export const QualitySourceSelectionSchema=z.discriminatedUnion('kind',[outlineSelection,scriptSelection]);
export type QualitySourceSelection=z.infer<typeof QualitySourceSelectionSchema>;
const NameMetadata=QualityNameSchema.pick({id:true,name:true,principal:true});
const Provenance=z.strictObject({humanAuthorIds:z.array(Id).max(64),models:z.array(z.strictObject({kind:z.enum(['outline','screenplay']),receipt:ModelReceiptSchema})).min(1).max(2)});
const GenerationLink=z.strictObject({key:OutlineKeySchema,runDigest:Hash,deliveryDigest:Hash,candidateDigest:Hash});
export const QualitySourceSchema=z.strictObject({version:z.literal(1),scope:ScreenplayScopeSchema,selection:QualitySourceSelectionSchema,outlineBriefId:Id,objectId:Id,subject:QualitySubjectSchema,names:z.array(NameMetadata).max(16384),unknownPrincipalIds:z.array(Id).max(16384),provenance:Provenance,upstream:z.unknown(),generation:GenerationLink.nullable(),digest:Hash});
export type QualitySource=z.infer<typeof QualitySourceSchema>;
export interface QualitySourceReaders{
  readonly outline:Pick<PostgresOutlineStore,'readCurrentForQuality'|'readHistoricalForQuality'|'readForAdoption'|'readHistoricalForAdoption'>;
  readonly scripts:Pick<PostgresScreenplayStore,'readCurrentForPrecheck'|'readHistorical'|'readForAdoption'>;
  readonly generations:Pick<PostgresScreenplayGenerationStore,'readHistoricalForQuality'>;
}
function fail(code:QualityError['code'],path:string):never{throw new QualityError(code,'quality material source',path);}
function safe(error:unknown):never{let own=false,code:QualityError['code']='STORAGE_FAILED';try{own=error instanceof QualityError;if(error instanceof OutlineError||error instanceof ScreenplayError)code=error.code==='INVALID_EVIDENCE'?'INVALID_REFERENCE':error.code;}catch{/* A repository's opaque diagnostics never become a public message. */}if(own)throw error;return fail(code,'source');}
function selectionFor(input:unknown){const s=captureQuality(QualitySourceSelectionSchema,input,'quality source selection',8192);if((s.variant==='candidate')!==(s.expectedReviewDigest===null)||s.kind==='screenplay'&&s.variant==='candidate'&&s.finalization!==null)fail('INVALID_INPUT','source variant');return freezeQuality(s);}
function outlineBody(progress:OutlineProgress,variant:'candidate'|'reviewed',expectedReviewDigest:string|null,current:boolean){
  if(!progress.candidate)fail('INCOMPLETE','outline candidate');if(variant==='reviewed'){if(progress.review?.status!=='reviewed'||progress.review.digest!==expectedReviewDigest)fail('CONFLICT','outline review');return progress.review.output;}if(current&&progress.review!==null)fail('CONFLICT','superseded outline candidate');return progress.candidate.output;
}
/** Integrity only. Actual authority/currentness always requires re-reading the source repositories on the caller connection. */
export function validateQualitySource(input:unknown):QualitySource{
  const raw=captureQuality(QualitySourceSchema,input,'stored quality material',QUALITY_MATERIAL_BYTES),s=selectionFor(raw.selection),{digest:stored,...body}=raw;
  if(raw.scope.tenantId!==s.key.tenantId||raw.scope.projectId!==s.key.projectId||raw.subject.kind!==s.kind||qualityDigest(body)!==stored)fail('CONFLICT','material binding');
  validateOutlineSourceSnapshot(raw.upstream);if(new Set(raw.names.map(row=>row.id)).size!==raw.names.length||new Set(raw.unknownPrincipalIds).size!==raw.unknownPrincipalIds.length||raw.unknownPrincipalIds.some(id=>!raw.names.some(row=>row.id===id&&!row.principal))||new Set(raw.provenance.humanAuthorIds).size!==raw.provenance.humanAuthorIds.length||new Set(raw.provenance.models.map(row=>row.kind)).size!==raw.provenance.models.length||!raw.provenance.models.some(row=>row.kind==='outline')||raw.provenance.models.some(row=>row.receipt.tenantId!==raw.scope.tenantId))fail('CONFLICT','material provenance');
  if(raw.subject.kind==='outline'){
    const expected=raw.subject.output.characters.map(row=>({id:row.id,name:row.name,principal:row.function!=='supporting'}));if(raw.objectId!=='outline-'+digest({...raw.scope,briefId:raw.outlineBriefId})||!equalQualityData(raw.names,expected)||raw.unknownPrincipalIds.length||raw.generation!==null||raw.provenance.models.length!==1)fail('CONFLICT','outline material directory');
  }else{
    const subject=raw.subject,ids=new Set(subject.draft.scenes.flatMap(scene=>[...scene.characterIds,...scene.beats.flatMap(beat=>beat.lines.map(line=>line.speakerId))]));if(raw.objectId!==subject.draft.episodeId||raw.names.length!==ids.size||raw.names.some(row=>!ids.has(row.id)||!subject.context.characters.some(character=>character.id===row.id&&character.name===row.name))||(raw.generation!==null)!==raw.provenance.models.some(row=>row.kind==='screenplay'))fail('CONFLICT','screenplay material directory');
  }
  return freezeQuality(raw);
}
export function qualitySourceReference(input:unknown){const source=validateQualitySource(input),models=source.provenance.models.map(row=>({modelIdentity:row.receipt.modelIdentity,modeDigest:row.receipt.modeDigest})),unique=[...new Map(models.map(row=>[JSON.stringify(row),row])).values()];return freezeQuality(captureQuality(QualitySourceReferenceSchema,{kind:source.subject.kind,objectId:source.objectId,digest:source.digest,humanAuthorIds:source.provenance.humanAuthorIds,producingModels:unique},'quality source reference',16384));}
async function read(client:PoolClient,input:unknown,readers:QualitySourceReaders,hostInput:unknown,current:boolean):Promise<QualitySource>{
  const selection=selectionFor(input),scope={tenantId:selection.key.tenantId,projectId:selection.key.projectId},host=authorizeQualityHost(hostInput,'quality:read',scope);authorizeQualityHost(host,'outline:read',scope);if(selection.kind==='screenplay')authorizeQualityHost(host,'screenplay:read',scope);
  try{
    if(selection.kind==='outline'){
      const original=readers.outline,reader=(current?original.readCurrentForQuality:original.readHistoricalForQuality).bind(original),p=await reader(client,selection.key);if(p.run.digest!==selection.expectedRunDigest||p.candidate?.digest!==selection.expectedCandidateDigest)fail('CONFLICT','actual outline identity');const output=outlineBody(p,selection.variant,selection.expectedReviewDigest,current),body={version:1 as const,scope,selection,outlineBriefId:p.run.brief.briefId,objectId:'outline-'+digest({...scope,briefId:p.run.brief.briefId}),subject:{kind:'outline' as const,context:outlineContext(p.run.brief,p.run.source),output},names:output.characters.map(row=>({id:row.id,name:row.name,principal:row.function!=='supporting'})),unknownPrincipalIds:[],provenance:{humanAuthorIds:selection.variant==='reviewed'&&p.review?.status==='reviewed'?[p.review.actorId]:[],models:[{kind:'outline' as const,receipt:p.candidate!.model}]},upstream:p.run.source,generation:null};return validateQualitySource({...body,digest:qualityDigest(body)});
    }
    const sourceScripts=readers.scripts,sourceOutline=readers.outline,sourceGenerations=readers.generations,scripts={readCurrentForPrecheck:sourceScripts.readCurrentForPrecheck.bind(sourceScripts),readHistorical:sourceScripts.readHistorical.bind(sourceScripts),readForAdoption:sourceScripts.readForAdoption.bind(sourceScripts)},outline={readForAdoption:sourceOutline.readForAdoption.bind(sourceOutline),readHistoricalForAdoption:sourceOutline.readHistoricalForAdoption.bind(sourceOutline)},generationReader=sourceGenerations.readHistoricalForQuality.bind(sourceGenerations);let progress;
    if(selection.finalization){const native={scope,target:selection.finalization.target,changeId:selection.finalization.changeId},proof=await readScreenplayNativeAdoption(client,native,scripts,host);if(!equalQualityData(proof.binding.key,selection.key)||proof.receipt.digest!==selection.finalization.expectedReceiptDigest)fail('CONFLICT','native screenplay receipt');if(current)await readScreenplayHandoff(client,native,scripts,outline,host);progress=proof.progress;}
    else progress=await (current?scripts.readCurrentForPrecheck:scripts.readHistorical)(client,selection.key,host);
    const preparation=progress.preparation;if(preparation.digest!==selection.expectedPreparationDigest||!equalQualityData(preparation.key,selection.key))fail('CONFLICT','actual screenplay identity');let candidate=preparation.candidate;
    if(selection.variant==='reviewed'){if(!progress.review||progress.review.digest!==selection.expectedReviewDigest)fail('CONFLICT','actual screenplay review');candidate=progress.review.output;}else if(current&&progress.review!==null)fail('CONFLICT','superseded screenplay candidate');
    const view=await readStoredScreenplaySource(client,{scope,source:preparation.source,context:preparation.context,previous:preparation.previous},outline);const head=view.head;if(head.schema_version!=='0.7.0-draft'&&head.schema_version!=='0.8.0-draft')fail('INCOMPLETE','native quality schema');const plan=head.adaptation_plans.find(row=>row.id===preparation.context.outline.plan.id&&row.version===preparation.context.outline.plan.version);if(!plan)fail('CONFLICT','actual adopted outline plan');const raw=plan.source,descriptor={tenantId:raw.tenant_key,projectId:raw.project_key,runId:raw.run_id,runDigest:raw.run_digest,briefDigest:raw.brief_digest,candidateDigest:raw.candidate_digest,reviewDigest:raw.review_digest,sourceDigest:raw.source_digest};if(descriptor.tenantId!==scope.tenantId||descriptor.projectId!==scope.projectId)fail('FORBIDDEN','outline scope');
    const parent=captureOutlineAdoptionProgress(descriptor,await (current?outline.readForAdoption:outline.readHistoricalForAdoption)(client,descriptor)),ids=new Set(candidate.draft.scenes.flatMap(scene=>[...scene.characterIds,...scene.beats.flatMap(beat=>beat.lines.map(line=>line.speakerId))])),unknownPrincipalIds:string[]=[],names=preparation.context.characters.filter(row=>ids.has(row.id)).map(row=>{const actual=head.characters.find(character=>character.id===row.id&&character.version===row.version);if(!actual||actual.name!==row.name)fail('CONFLICT','actual scene character');const role=actual.development?.function??(['protagonist','antagonist','supporting'].includes(actual.role)?actual.role:null);if(role===null)unknownPrincipalIds.push(row.id);return {id:row.id,name:row.name,principal:role==='protagonist'||role==='antagonist'};});
    const humanAuthorIds=[preparation.authorId,...(selection.variant==='reviewed'&&progress.review?[progress.review.actorId]:[])],models:z.infer<typeof Provenance>['models']=[{kind:'outline',receipt:parent.candidate.model}];let generation:z.infer<typeof GenerationLink>|null=null;
    const installed=await client.query("SELECT pg_catalog.to_regclass('camery_screenplay.generation_deliveries') IS NOT NULL AS installed");if(installed.rows.length!==1||typeof installed.rows[0]?.installed!=='boolean')fail('STORAGE_FAILED','generation schema');
    if(installed.rows[0].installed){
      const owner=await client.query('SELECT run_id FROM camery_screenplay.generation_runs WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3',[scope.tenantId,scope.projectId,selection.key.candidateId]),links=await client.query('SELECT run_id FROM camery_screenplay.generation_deliveries WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3',[scope.tenantId,scope.projectId,selection.key.candidateId]);
      if(owner.rows.length>1||links.rows.length>1)fail('STORAGE_FAILED','generation linkage cardinality');
      // A generation started before manual preparation may later attach its delivery. Do not freeze that pending origin as human-only.
      if(owner.rows.length===1&&links.rows.length===0)fail('INCOMPLETE','pending generation provenance');if(links.rows.length===1&&(owner.rows.length!==1||owner.rows[0].run_id!==links.rows[0].run_id))fail('CONFLICT','generation owner binding');
      if(links.rows.length===1){const key={...scope,runId:captureQuality(Id,links.rows[0].run_id,'actual generation run',256)},generated=await generationReader(client,key,host);if(!generated.delivery||!generated.candidate||generated.delivery.preparationDigest!==preparation.digest||!equalQualityData(generated.delivery.candidateKey,selection.key))fail('CONFLICT','actual delivered generation');generation={key,runDigest:generated.run.digest,deliveryDigest:generated.delivery.digest,candidateDigest:generated.candidate.digest};models.push({kind:'screenplay',receipt:generated.candidate.model});}
    }
    const body={version:1 as const,scope,selection,outlineBriefId:parent.run.brief.briefId,objectId:candidate.draft.episodeId,subject:{kind:'screenplay' as const,context:preparation.context,draft:candidate.draft,outline:{context:outlineContext(parent.run.brief,parent.run.source),output:parent.review.output}},names,unknownPrincipalIds,provenance:{humanAuthorIds:[...new Set(humanAuthorIds)],models},upstream:parent.run.source,generation};return validateQualitySource({...body,digest:qualityDigest(body)});
  }catch(error){return safe(error);}
}
export function readQualitySource(client:PoolClient,input:unknown,readers:QualitySourceReaders,host:unknown){return read(client,input,readers,host,true);}
export async function readHistoricalQualitySource(client:PoolClient,input:unknown,readers:QualitySourceReaders,host:unknown){const stored=validateQualitySource(input),actual=await read(client,stored.selection,readers,host,false);if(!equalQualityData(actual,stored))fail('CONFLICT','actual historical source');return actual;}
