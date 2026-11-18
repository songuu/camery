import {z} from 'zod';
import {freeze} from '@camery/methods';
import {snapshotJson,JsonBoundaryError} from '@camery/methods/json';
import {OutlineReceiptSchema,OutlineReceiptPageSchema} from '@camery/ir/outline-adoption';
import type {OutlineReceiptQuery} from '@camery/ir/outline-adoption';
import type {OutlineCandidateIntent,OutlineActionReceipt} from './outline-intent-contracts.js';
import {outlineIntentDigest} from './outline-intent-data.js';
import {ProjectApplicationError} from './intent-contracts.js';
import {encodeReadCursor,decodeReadCursor} from './read-cursor.js';
export const OUTLINE_ADOPTION_RESPONSE_BYTES=983040;

export function outlineAcknowledgement(projectKey:string,candidateId:string,kind:'preparation'|'decision',requestId:string,receipt:OutlineActionReceipt){
  if(receipt.changeId!==candidateId)throw new ProjectApplicationError('STORAGE_FAILED','outline receipt candidate');
  return freeze(OutlineReceiptSchema.parse({contractVersion:1,projectKey,candidateId,kind,requestId,status:receipt.status,snapshotRevision:receipt.snapshotRevision,writeVersion:receipt.writeVersion,issueCount:receipt.issues.length,warningCount:receipt.warnings.length,adoption:receipt.adoption,rejection:receipt.rejection}));
}
/** An immutable digest pins the complete receipt. Byte paging never truncates individual messages or loses the next offset. */
export function outlineReceiptPage(input:{subjectId:string;intent:OutlineCandidateIntent;receipt:OutlineActionReceipt;query:OutlineReceiptQuery}){
  const {intent,receipt,query}=input,rows=receipt[query.section];
  const binding={kind:'outline-receipt',subjectId:input.subjectId,scope:intent.scope,target:intent.target,candidateId:intent.changeId,receiptKind:query.kind,requestId:query.requestId,section:query.section,digest:outlineIntentDigest(receipt)};
  const position=z.strictObject({offset:z.number().int().min(1).max(131072)}),offset=query.cursor?decodeReadCursor(binding,query.cursor,position).offset:0;
  if(offset>rows.length||offset===rows.length&&offset!==0)throw new ProjectApplicationError('INVALID_INPUT','outline receipt cursor offset');
  const items=rows.slice(offset,offset+(query.limit??20));
  while(true){
    const next=offset+items.length,result=OutlineReceiptPageSchema.parse({contractVersion:1,projectKey:intent.scope.projectId,candidateId:intent.changeId,kind:query.kind,requestId:query.requestId,section:query.section,total:rows.length,items,nextCursor:next<rows.length?encodeReadCursor(binding,{offset:next}):null});
    // The HTTP envelope adds a UUID request ID and its keys; preserve room before selecting the next offset.
    try{snapshotJson(result,OUTLINE_ADOPTION_RESPONSE_BYTES-256,65536);return freeze(result);}
    catch(error){if(!(error instanceof JsonBoundaryError)||error.code!=='INPUT_LIMIT')throw new ProjectApplicationError('STORAGE_FAILED','outline receipt page');if(items.length<=1)throw new ProjectApplicationError('INPUT_LIMIT','outline receipt message');items.pop();}
  }
}
