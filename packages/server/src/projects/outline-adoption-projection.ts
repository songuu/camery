import type {OutlineReceiptQuery} from '@camery/ir/outline-adoption';
import type {OutlineCandidateIntent,OutlineActionReceipt} from './outline-intent-contracts.js';
import {CANDIDATE_ACTION_RESPONSE_BYTES,candidateAcknowledgement,candidateReceiptPage} from './candidate-action-projection.js';
export const OUTLINE_ADOPTION_RESPONSE_BYTES=CANDIDATE_ACTION_RESPONSE_BYTES;

export function outlineAcknowledgement(projectKey:string,candidateId:string,kind:'preparation'|'decision',requestId:string,receipt:OutlineActionReceipt){
  return candidateAcknowledgement(projectKey,candidateId,kind,requestId,receipt,'outline');
}
/** Legacy Outline cursors retain their original namespace, fields, digest profile and byte budget. */
export function outlineReceiptPage(input:{subjectId:string;intent:OutlineCandidateIntent;receipt:OutlineActionReceipt;query:OutlineReceiptQuery}){
  return candidateReceiptPage({...input,source:'outline'});
}
