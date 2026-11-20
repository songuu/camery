import {z} from 'zod';
import {freeze} from '@camery/methods';
import {snapshotJson,JsonBoundaryError} from '@camery/methods/json';
import {CandidateReceiptSchema,CandidateReceiptPageSchema} from '@camery/ir/candidate-receipts';
import type {CandidateReceiptQuery} from '@camery/ir/candidate-receipts';
import type {WorkbenchActionReceipt} from '@camery/ir/workbench';
import {ProjectApplicationError} from './intent-contracts.js';
import {projectCommandDigest} from './project-command-data.js';
import {encodeReadCursor,decodeReadCursor} from './read-cursor.js';

export const CANDIDATE_ACTION_RESPONSE_BYTES=983040;
type SourceKind='outline'|'screenplay'|'workbench';
export interface CandidateReceiptAddress{scope:{tenantId:string;projectId:string};target:{tenantId:string;projectId:string};changeId:string}
export function candidateAcknowledgement(projectKey:string,candidateId:string,kind:'preparation'|'decision',requestId:string,receipt:WorkbenchActionReceipt,source:SourceKind){
  if(receipt.changeId!==candidateId)throw new ProjectApplicationError('STORAGE_FAILED',source+' receipt candidate');
  return freeze(CandidateReceiptSchema.parse({contractVersion:1,projectKey,candidateId,kind,requestId,status:receipt.status,snapshotRevision:receipt.snapshotRevision,writeVersion:receipt.writeVersion,issueCount:receipt.issues.length,warningCount:receipt.warnings.length,adoption:receipt.adoption,rejection:receipt.rejection}));
}
/** The complete immutable receipt owns the total; byte paging returns whole messages and the exact next offset. */
export function candidateReceiptPage(input:{source:SourceKind;subjectId:string;intent:CandidateReceiptAddress;receipt:WorkbenchActionReceipt;query:CandidateReceiptQuery}){
  const {source,intent,receipt,query}=input,rows=receipt[query.section];
  const binding={kind:source+'-receipt',subjectId:input.subjectId,scope:intent.scope,target:intent.target,candidateId:intent.changeId,receiptKind:query.kind,requestId:query.requestId,section:query.section,digest:projectCommandDigest(receipt,67108864)};
  const position=z.strictObject({offset:z.number().int().min(1).max(131072)}),offset=query.cursor?decodeReadCursor(binding,query.cursor,position).offset:0;
  if(offset>rows.length||offset===rows.length&&offset!==0)throw new ProjectApplicationError('INVALID_INPUT',source+' receipt cursor offset');
  const items=rows.slice(offset,offset+(query.limit??20));
  while(true){
    const next=offset+items.length,result=CandidateReceiptPageSchema.parse({contractVersion:1,projectKey:intent.scope.projectId,candidateId:intent.changeId,kind:query.kind,requestId:query.requestId,section:query.section,total:rows.length,items,nextCursor:next<rows.length?encodeReadCursor(binding,{offset:next}):null});
    // Reserve the actual transport envelope before accepting a complete page.
    try{snapshotJson(result,CANDIDATE_ACTION_RESPONSE_BYTES-256,65536);return freeze(result);}
    catch(error){if(!(error instanceof JsonBoundaryError)||error.code!=='INPUT_LIMIT')throw new ProjectApplicationError('STORAGE_FAILED',source+' receipt page');if(items.length<=1)throw new ProjectApplicationError('INPUT_LIMIT',source+' receipt message');items.pop();}
  }
}
