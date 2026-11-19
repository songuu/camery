import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {PostgresScreenplayStore} from '@camery/script/screenplay/node';
import type {PostgresOutlineStore} from '@camery/script/outline/node';
import {readScreenplayHandoff,readScreenplayNativeAdoption} from '@camery/script/screenplay/node';
import {StableId} from '@camery/ir';
import {ScreenplayDraftSchema,SCREENPLAY_DRAFT_BYTES,ScreenplayError} from '@camery/script/screenplay/contracts';
import {ComplianceError,Hash,Id,CorpusSchema,SpeakerNameSchema} from '../contracts.js';
import {capture,freeze} from '../boundary.js';
import {projectScreenplayCorpus} from '../corpus.js';
import {hash,equal} from './data.js';
export const SOURCE_BYTES=16777216;
export const ScreenplaySelectionSchema=z.strictObject({key:z.strictObject({tenantId:Id,projectId:Id,candidateId:Id}),variant:z.enum(['candidate','reviewed']),expectedPreparationDigest:Hash,expectedReviewDigest:Hash.nullable(),finalization:z.strictObject({target:z.strictObject({tenantId:StableId,projectId:StableId}),changeId:StableId,expectedReceiptDigest:Hash}).nullable()});
export type ScreenplaySelection=z.infer<typeof ScreenplaySelectionSchema>;
export const PrecheckSourceSchema=z.strictObject({version:z.literal(1),selection:ScreenplaySelectionSchema,draft:ScreenplayDraftSchema,speakers:z.array(SpeakerNameSchema).max(8192),corpus:CorpusSchema,digest:Hash});
export type PrecheckSource=z.infer<typeof PrecheckSourceSchema>;
export interface PrecheckSourceReaders{readonly scripts:Pick<PostgresScreenplayStore,'readHistorical'|'readCurrentForPrecheck'|'readForAdoption'>;readonly outline:Pick<PostgresOutlineStore,'readForAdoption'>}
function fail(code:ComplianceError['code'],path:string):never{throw new ComplianceError(code,'screenplay precheck source',path);}
function safe(error:unknown):never{let known=false,code:ComplianceError['code']|undefined;try{known=error instanceof ComplianceError;if(error instanceof ScreenplayError)code=error.code;}catch{/* Driver/prototype details never leave this boundary. */}if(known)throw error;throw new ComplianceError(code??'STORAGE_FAILED','screenplay precheck source','source');}
/** Stored source integrity only; actual authority always comes from the screenplay repository. */
export function validatePrecheckSource(input:unknown):PrecheckSource{
  const source=capture(PrecheckSourceSchema,input,'stored precheck source',SOURCE_BYTES),s=source.selection;if((s.variant==='candidate')!==(s.expectedReviewDigest===null)||s.variant==='candidate'&&s.finalization!==null)fail('INVALID_INPUT','review variant');const actual=new Set(source.draft.scenes.flatMap(scene=>scene.beats.flatMap(beat=>beat.lines.map(line=>line.speakerId))));if(source.speakers.length!==actual.size)fail('CONFLICT','complete rendered speakers');const {digest,...body}=source;if(hash(body,SOURCE_BYTES)!==digest||!equal(source.corpus,projectScreenplayCorpus(source.draft,source.speakers)))fail('CONFLICT','source content');return freeze(source);
}
async function read(client:PoolClient,selectionInput:unknown,readers:PrecheckSourceReaders,host:unknown,current:boolean):Promise<PrecheckSource>{
  const selection=freeze(capture(ScreenplaySelectionSchema,selectionInput,'screenplay precheck selection',4096));if((selection.variant==='candidate')!==(selection.expectedReviewDigest===null)||selection.variant==='candidate'&&selection.finalization!==null)fail('INVALID_INPUT','review variant');
  try{
    let progress;const f=selection.finalization,scripts=readers.scripts;
    if(f){const native={scope:{tenantId:selection.key.tenantId,projectId:selection.key.projectId},target:f.target,changeId:f.changeId},proof=await readScreenplayNativeAdoption(client,native,scripts,host);if(!equal(proof.binding.key,selection.key)||proof.receipt.digest!==f.expectedReceiptDigest)fail('CONFLICT','finalization');if(current)await readScreenplayHandoff(client,native,scripts,readers.outline,host);progress=proof.progress;}
    else progress=current?await scripts.readCurrentForPrecheck(client,selection.key,host):await scripts.readHistorical(client,selection.key,host);
    const p=progress.preparation;
    if(!equal(p.key,selection.key)||p.digest!==selection.expectedPreparationDigest)fail('CONFLICT','preparation');
    let candidate=p.candidate;if(selection.variant==='reviewed'){if(!progress.review||progress.review.digest!==selection.expectedReviewDigest)fail('CONFLICT','review');candidate=progress.review.output;}else if(current&&progress.review)fail('CONFLICT','superseded candidate');
    // An empty model finding list cannot stand in for omitted text: both body and full field projection are stored.
    const captured=capture(ScreenplayDraftSchema,candidate.draft,'actual precheck draft',SCREENPLAY_DRAFT_BYTES),speakers=candidate.lineBook.speakers.map(row=>({id:row.character.id,name:row.name})),body={version:1 as const,selection,draft:captured,speakers,corpus:projectScreenplayCorpus(captured,speakers)};return validatePrecheckSource({...body,digest:hash(body,SOURCE_BYTES)});
  }catch(error){return safe(error);}
}
export function readPrecheckSource(client:PoolClient,input:unknown,readers:PrecheckSourceReaders,host:unknown):Promise<PrecheckSource>{return read(client,input,readers,host,true);}
export async function readHistoricalPrecheckSource(client:PoolClient,input:unknown,readers:PrecheckSourceReaders,host:unknown):Promise<PrecheckSource>{const stored=validatePrecheckSource(input),actual=await read(client,stored.selection,readers,host,false);if(!equal(stored,actual))fail('CONFLICT','stored source');return actual;}
