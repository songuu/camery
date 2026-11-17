import { z } from 'zod';
import { BibleError,ClaimKind,EntityKind,EvidenceSchema,SourceIdentitySchema } from '@camery/bible';
import type { BibleStore } from '@camery/bible/node';
import { DevelopmentError,DevelopmentBriefSchema,EpisodeOutputSchema,FoundationOutputSchema,Hash,Id,Text } from '../../contracts.js';
import { validateBrief } from '../../brief.js';
import { validateFoundation } from '../../foundation.js';
import { validateEpisodes } from '../../episodes.js';
import { canonicalTime,validateReviewedEpisodes,validateReviewedFoundation } from '../../reviewed.js';
import type { DevelopmentStore } from '../../node/contracts.js';
import { capture,deepFreeze } from '../boundary.js';
import { OutlineError } from '../contracts.js';
import { OUTLINE_SOURCE_BYTES,OutlineSourceDescriptorSchema,OutlineSourceReferenceSchema } from '../generation-contracts.js';
import type { OutlineSourceDescriptor,OutlineSourceSnapshot } from '../generation-contracts.js';
import { copy,hash } from './data.js';

const DevelopmentMaterial=z.strictObject({brief:DevelopmentBriefSchema,foundation:FoundationOutputSchema,episodes:EpisodeOutputSchema});
const Evidence=z.array(EvidenceSchema).min(1).max(6);
const BibleMaterial=z.strictObject({source:SourceIdentitySchema,
  entities:z.array(z.strictObject({id:Id,kind:EntityKind,name:Text(120),aliases:z.array(Text(120)).max(8192),memberIds:z.array(Id).min(1).max(4096),
    descriptions:z.array(z.strictObject({text:Text(1000),evidence:Evidence})).min(1).max(4096)})).max(4096),
  relations:z.array(z.strictObject({id:Id,chunkId:Id,from:Id,to:Id,label:Text(300),evidence:Evidence})).max(8192),
  claims:z.array(z.strictObject({id:Id,chunkId:Id,kind:ClaimKind,text:Text(1000),entityIds:z.array(Id).max(32),evidence:Evidence})).max(8192),
});
const Snapshot=z.strictObject({version:z.literal(1),descriptor:OutlineSourceDescriptorSchema,material:z.unknown(),references:z.array(OutlineSourceReferenceSchema).max(2048),digest:Hash});
const Key=z.strictObject({tenantId:Id,projectId:Id,runId:Id,runDigest:Hash});
const DevelopmentProjection=z.strictObject({key:Key,brief:z.unknown(),foundationReview:z.unknown(),episodesReview:z.unknown(),foundationCandidateDigest:Hash,episodesCandidateDigest:Hash});
const BibleProjection=z.strictObject({key:Key,runSource:SourceIdentitySchema,candidateDigest:Hash,review:z.strictObject({version:z.literal(1),status:z.literal('confirmed'),source:SourceIdentitySchema,
  candidateDigest:Hash,actorId:Id,at:z.string().max(24),digest:Hash,entities:BibleMaterial.shape.entities,relations:BibleMaterial.shape.relations,claims:BibleMaterial.shape.claims})});
type Stores={readonly development?:Pick<DevelopmentStore,'read'|'isCurrent'>;readonly bible?:Pick<BibleStore,'read'|'isCurrent'>};
function failed(code:OutlineError['code'],path:string):never{throw new OutlineError(code,'source resolution',path);}
function own(input:unknown,key:string):unknown{
  try{
    if(!input||typeof input!=='object')return failed('STORAGE_FAILED',key);
    const field=Object.getOwnPropertyDescriptor(input,key);if(!field||!('value' in field))return failed('STORAGE_FAILED',key);return field.value;
  }catch(error){if(error instanceof OutlineError)throw error;return failed('STORAGE_FAILED',key);}
}
function identity(run:unknown){return {tenantId:own(run,'tenantId'),projectId:own(run,'projectId'),runId:own(run,'runId'),runDigest:own(run,'digest')};}
function matchKey(expected:OutlineSourceDescriptor,actual:z.infer<typeof Key>):void{
  if(actual.tenantId!==expected.tenantId||actual.projectId!==expected.projectId)failed('FORBIDDEN','descriptor.scope');
  if(actual.runId!==expected.runId||actual.runDigest!==expected.runDigest)failed('CONFLICT','descriptor.run');
}
function unique(values:readonly string[],path:string):void{if(new Set(values).size!==values.length)failed('INVALID_INPUT',path);}
function bibleMaterial(input:unknown,descriptor:Extract<OutlineSourceDescriptor,{kind:'bible'}>){
  const material=capture(BibleMaterial,input,'Bible source material',OUTLINE_SOURCE_BYTES);const source=material.source;
  if(source.tenantId!==descriptor.tenantId||source.projectId!==descriptor.projectId)failed('FORBIDDEN','material.source.scope');
  if(source.documentId!==descriptor.documentId||source.revision!==descriptor.revision||source.sourceDigest!==descriptor.sourceDigest)failed('CONFLICT','material.source');
  for(const field of ['entities','relations','claims'] as const)unique(material[field].map(item=>item.id),`material.${field}`);
  const entities=new Set(material.entities.map(entity=>entity.id));const members=new Set<string>();
  function evidence(values:z.infer<typeof Evidence>){for(const item of values)if(item.start>=item.end||item.end>source.totalCharacters||item.end-item.start!==item.quote.length)failed('INVALID_INPUT','material.evidence');}
  for(const entity of material.entities){
    unique(entity.aliases,'material.aliases');unique(entity.memberIds,'material.memberIds');
    for(const id of entity.memberIds){if(members.has(id))failed('INVALID_INPUT','material.memberIds');members.add(id);}
    for(const description of entity.descriptions)evidence(description.evidence);
  }
  for(const relation of material.relations){if(!entities.has(relation.from)||!entities.has(relation.to))failed('INVALID_INPUT','material.relations');evidence(relation.evidence);}
  for(const claim of material.claims){unique(claim.entityIds,'material.claims.entityIds');if(claim.entityIds.some(id=>!entities.has(id)))failed('INVALID_INPUT','material.claims');evidence(claim.evidence);}
  return material;
}
function normalizeMaterial(descriptor:OutlineSourceDescriptor,input:unknown){
  if(descriptor.kind==='bible')return bibleMaterial(input,descriptor);
  const material=capture(DevelopmentMaterial,input,'development source material',OUTLINE_SOURCE_BYTES);const brief=validateBrief(material.brief);
  if(brief.tenantId!==descriptor.tenantId||brief.projectId!==descriptor.projectId)failed('FORBIDDEN','material.brief.scope');
  if(brief.digest!==descriptor.briefDigest)failed('CONFLICT','material.brief.digest');
  const foundation=validateFoundation(material.foundation);return {brief,foundation,episodes:validateEpisodes(brief,foundation,material.episodes)};
}
function references(descriptor:OutlineSourceDescriptor,material:ReturnType<typeof normalizeMaterial>){
  const paths:string[]=[];
  if(descriptor.kind==='development'){
    const development=material as z.infer<typeof DevelopmentMaterial>;paths.push('/foundation/world');
    for(const [index] of development.foundation.world.rules.entries())paths.push(`/foundation/world/rules/${index}`);
    for(const field of ['characters','relationships'] as const)for(const [index] of development.foundation[field].entries())paths.push(`/foundation/${field}/${index}`);
    paths.push('/foundation/mainline');for(const [index] of development.foundation.openQuestions.entries())paths.push(`/foundation/openQuestions/${index}`);
    for(const [index] of development.episodes.episodes.entries())paths.push(`/episodes/episodes/${index}`);
  }else{
    const bible=material as z.infer<typeof BibleMaterial>;
    for(const field of ['entities','relations','claims'] as const)for(const [index] of bible[field].entries())paths.push(`/${field}/${index}`);
  }
  if(paths.length===0)failed('INCOMPLETE','references');if(paths.length>2048)failed('INPUT_LIMIT','references');
  return paths.map(path=>({id:'source:'+hash({path}),path}));
}
function build(descriptor:OutlineSourceDescriptor,input:unknown):OutlineSourceSnapshot{
  const material=normalizeMaterial(descriptor,input);const body={version:1 as const,descriptor,material,references:references(descriptor,material)};
  return deepFreeze(copy({...body,digest:hash(body)},OUTLINE_SOURCE_BYTES));
}
function translate(error:unknown):never{
  if(error instanceof OutlineError)throw error;
  if(error instanceof DevelopmentError||error instanceof BibleError){
    const code=error.code;
    if(code==='INVALID_REFERENCE'||code==='INVALID_EVIDENCE')return failed('INVALID_INPUT','material');
    if(code==='INVALID_INPUT'||code==='INPUT_LIMIT'||code==='CONFLICT'||code==='FORBIDDEN'||code==='INCOMPLETE'||code==='NOT_FOUND'||code==='STORAGE_FAILED')return failed(code,'store');
  }
  return failed('STORAGE_FAILED','store');
}
/** Integrity replay only. A JSON snapshot or unkeyed digest never grants source approval or current authorization. */
export function validateOutlineSourceSnapshot(input:unknown):OutlineSourceSnapshot{
  try{
    const snapshot=capture(Snapshot,input,'source snapshot',OUTLINE_SOURCE_BYTES);const actual=build(snapshot.descriptor,snapshot.material);
    if(snapshot.digest!==actual.digest||hash(snapshot.references)!==hash(actual.references))failed('CONFLICT','snapshot.binding');return actual;
  }catch(error){return translate(error);}
}
/**
 * Trusted store.read reconstructs the original candidate/review audit. Capture only complete writing material,
 * not the full original document, before awaiting currentness. OL-3 must recheck under source locks when writing;
 * these separate reads cannot prove atomic freshness or authorize a caller.
 */
export async function resolveOutlineSource(input:unknown,stores:Stores):Promise<OutlineSourceSnapshot>{
  const descriptor=deepFreeze(capture(OutlineSourceDescriptorSchema,input,'source descriptor',8192));
  const key=deepFreeze({tenantId:descriptor.tenantId,projectId:descriptor.projectId,runId:descriptor.runId});
  try{
    if(descriptor.kind==='development'){
      const store=stores.development;if(!store)failed('INCOMPLETE','development store');const read=store.read.bind(store),current=store.isCurrent.bind(store);
      const progress=await read(key);const run=own(progress,'run');const foundation=own(progress,'foundation'),episodes=own(progress,'episodes');
      const foundationReview=own(foundation,'review'),episodesReview=own(episodes,'review'),foundationCandidate=own(foundation,'candidate'),episodesCandidate=own(episodes,'candidate');
      if(!foundationReview||!episodesReview||!foundationCandidate||!episodesCandidate||own(foundationReview,'status')!=='reviewed'||own(episodesReview,'status')!=='reviewed')failed('INCOMPLETE','development reviews');
      const captured=capture(DevelopmentProjection,{key:identity(run),brief:own(run,'brief'),foundationReview,episodesReview,foundationCandidateDigest:own(foundationCandidate,'digest'),episodesCandidateDigest:own(episodesCandidate,'digest')},'development source projection',OUTLINE_SOURCE_BYTES);
      matchKey(descriptor,captured.key);const brief=validateBrief(captured.brief);const reviewedFoundation=validateReviewedFoundation(brief,captured.foundationReview),reviewedEpisodes=validateReviewedEpisodes(brief,reviewedFoundation,captured.episodesReview);
      if(brief.digest!==descriptor.briefDigest||reviewedFoundation.digest!==descriptor.foundationReviewDigest||reviewedEpisodes.digest!==descriptor.episodesReviewDigest||reviewedFoundation.candidateDigest!==captured.foundationCandidateDigest||reviewedEpisodes.candidateDigest!==captured.episodesCandidateDigest)failed('CONFLICT','development review binding');
      const snapshot=build(descriptor,{brief,foundation:reviewedFoundation.output,episodes:reviewedEpisodes.output});
      if(await current(key)!==true)failed('CONFLICT','current source');return snapshot;
    }
    const store=stores.bible;if(!store)failed('INCOMPLETE','bible store');const read=store.read.bind(store),current=store.isCurrent.bind(store);
    const progress=await read(key),run=own(progress,'run'),review=own(progress,'review'),candidate=own(progress,'candidate');
    if(!review||!candidate||own(review,'status')!=='confirmed')failed('INCOMPLETE','Bible confirmation');
    const fields=Object.fromEntries(['version','status','source','candidateDigest','actorId','at','digest','entities','relations','claims'].map(field=>[field,own(review,field)]));
    const captured=capture(BibleProjection,{key:identity(run),runSource:own(own(run,'source'),'source'),candidateDigest:own(candidate,'digest'),review:fields},'Bible source projection',OUTLINE_SOURCE_BYTES);
    matchKey(descriptor,captured.key);
    if(!canonicalTime(captured.review.at)||captured.review.digest!==descriptor.reviewDigest||captured.review.candidateDigest!==captured.candidateDigest||hash(captured.review.source)!==hash(captured.runSource))failed('CONFLICT','Bible review binding');
    const snapshot=build(descriptor,{source:captured.review.source,entities:captured.review.entities,relations:captured.review.relations,claims:captured.review.claims});
    if(await current(key)!==true)failed('CONFLICT','current source');return snapshot;
  }catch(error){return translate(error);}
}
