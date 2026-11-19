import type {PoolClient} from 'pg';
import {captureContinuity,freezeContinuity} from '../boundary.js';
import {ContinuityError} from '../contracts.js';
import {validateContinuityCandidate} from './candidate.js';
import {canonicalContinuity,continuityDigest} from './digest.js';
import {CONTINUITY_RECORD_BYTES,ContinuityKeySchema,ContinuityPreparationSchema} from './persistence-contracts.js';
import type {ContinuityKey,ContinuityPreparation,ContinuityPrepare,ContinuityProgress,ContinuityPrevious,ContinuityReview,ContinuityReviewDecision,ContinuityRejectDecision,ContinuitySource} from './persistence-contracts.js';
import {validateContinuityReview} from './review.js';
import type {ContinuitySourceView} from './source.js';

export const continuityCandidateFields='tenant_id,project_id,candidate_id,formal_tenant_id,formal_project_id,source_revision,episode_id,author_id,package_digest,context_digest,command_digest,digest,record,created_at';
export const continuityReviewFields='tenant_id,project_id,candidate_id,status,actor_id,request_digest,digest,record,created_at';
export const continuityKeyValues=(key:ContinuityKey)=>[key.tenantId,key.projectId,key.candidateId];
export function continuityPreparationDigest(command:ContinuityPrepare,authorId:string):string{return continuityDigest({...command,authorId},CONTINUITY_RECORD_BYTES);}
export function continuityReviewDigest(status:'reviewed'|'rejected',decision:ContinuityReviewDecision|ContinuityRejectDecision,actorId:string):string{return continuityDigest({status,...decision,actorId},CONTINUITY_RECORD_BYTES);}

type Row=Record<string,unknown>;
type HistoricalView=ContinuitySourceView&{current:boolean};
type SourceReader=(client:PoolClient,input:{source:ContinuitySource;previous:ContinuityPrevious|null})=>Promise<HistoricalView>;
function fail(operation:string):never{throw new ContinuityError('STORAGE_FAILED',operation,'storage');}
function safe(error:unknown):never{
  let known=false;try{known=error instanceof ContinuityError;}catch{/* Opaque driver objects cannot provide public diagnostics. */}
  if(known)throw error;return fail('stored history');
}
function timestamp(value:unknown):string{const text=value instanceof Date?value.toISOString():value;if(typeof text!=='string'||new Date(text).toISOString()!==text)fail('stored timestamp');return text;}
function bound(row:Row,key:ContinuityKey):void{if(row['tenant_id']!==key.tenantId||row['project_id']!==key.projectId||row['candidate_id']!==key.candidateId)fail('stored scope');}
function requestFor(review:ContinuityReview){return review.status==='reviewed'?{candidateDigest:review.candidateDigest,draft:review.output.draft,waivers:review.waivers}:{candidateDigest:review.candidateDigest,reason:review.reason};}

/** Validates immutable columns and both original request and record hashes; it grants no authority. */
export function captureStoredContinuityPreparation(row:Row,key:ContinuityKey):ContinuityPreparation{
  try{
    bound(row,key);const record=captureContinuity(ContinuityPreparationSchema,row['record'],'stored preparation',CONTINUITY_RECORD_BYTES),{digest,...body}=record;
    const command={key:record.key,target:record.source.target,expectedSnapshotRevision:record.source.snapshotRevision,expectedPackageDigest:record.source.packageDigest,draft:record.candidate.draft};
    if(canonicalContinuity(record.key,2048)!==canonicalContinuity(key,2048)||record.source.target.tenantId!==row['formal_tenant_id']||record.source.target.projectId!==row['formal_project_id']||record.source.snapshotRevision!==Number(row['source_revision'])||record.source.episodeId!==row['episode_id']||record.authorId!==row['author_id']||record.source.packageDigest!==row['package_digest']||record.source.contextDigest!==row['context_digest']||record.commandDigest!==row['command_digest']||record.digest!==row['digest']||record.createdAt!==timestamp(row['created_at'])||continuityDigest(body,CONTINUITY_RECORD_BYTES)!==digest||continuityPreparationDigest(command,record.authorId)!==record.commandDigest||record.candidate.scope.tenantId!==key.tenantId||record.candidate.scope.projectId!==key.projectId||record.candidate.draft.episodeId!==record.source.episodeId||record.candidate.contextDigest!==record.source.contextDigest||record.previous!==null&&(record.previous.scope.tenantId!==key.tenantId||record.previous.scope.projectId!==key.projectId))fail('preparation columns');
    return freezeContinuity(record);
  }catch{return fail('stored preparation');}
}

/** Historical integrity replay on the caller's client. The injected source reader owns provenance checks, never a second transaction. */
export async function readStoredContinuityProgress(client:PoolClient,input:ContinuityKey,readSource:SourceReader):Promise<{progress:ContinuityProgress;view:HistoricalView}>{
  const key=freezeContinuity(captureContinuity(ContinuityKeySchema,input,'history key',2048));
  try{
    const candidates=await client.query(`SELECT ${continuityCandidateFields} FROM camery_continuity.candidates WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3`,continuityKeyValues(key));
    if(candidates.rows.length>1)fail('candidate cardinality');const row=candidates.rows[0] as Row|undefined;
    if(!row)throw new ContinuityError('NOT_FOUND','continuity candidate','candidateId');bound(row,key);
    const preparation=captureStoredContinuityPreparation(row,key);let view:HistoricalView;
    try{view=await readSource(client,{source:preparation.source,previous:preparation.previous});validateContinuityCandidate(view.context,preparation.candidate,view.previous?.ledger??null);}catch{return fail('stored candidate source');}
    const reviews=await client.query(`SELECT ${continuityReviewFields} FROM camery_continuity.reviews WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3`,continuityKeyValues(key));
    if(reviews.rows.length>1)fail('review cardinality');let review:ContinuityReview|null=null;
    if(reviews.rows[0]){
      try{
        const audit=reviews.rows[0] as Row;bound(audit,key);review=validateContinuityReview(view.context,preparation.candidate,audit['record'],view.previous?.ledger??null);
        if(review.status!==audit['status']||review.actorId!==audit['actor_id']||review.digest!==audit['digest']||review.at!==timestamp(audit['created_at'])||continuityReviewDigest(review.status,requestFor(review),review.actorId)!==audit['request_digest'])fail('review columns');
      }catch{return fail('stored review');}
    }
    return {progress:freezeContinuity({preparation,review,current:view.current}),view};
  }catch(error){return safe(error);}
}
