import { z } from 'zod';
import { capture,deepFreeze } from '../boundary.js';
import { OutlineError } from '../contracts.js';
import { OUTLINE_ENVELOPE_BYTES } from '../generation-contracts.js';
import type { OutlineProgress,OutlineRunKey } from './persistence-contracts.js';
import { validateOutlineRun,validateOutlineRunCandidate } from './persistence-contracts.js';
import { validateReviewedOutline,validateRejectedOutline } from './review.js';

const Progress=z.strictObject({run:z.unknown(),candidate:z.unknown().nullable(),review:z.unknown().nullable()});
/** Three independently bounded envelopes; progress is internal data, never an Agent request or Worker journal payload. */
export function captureOutlineProgress(key:OutlineRunKey,input:unknown):OutlineProgress{
  const raw=capture(Progress,input,'workflow progress',3*OUTLINE_ENVELOPE_BYTES),run=validateOutlineRun(key,raw.run);
  const candidate=raw.candidate===null?null:validateOutlineRunCandidate(run,raw.candidate);let review:OutlineProgress['review']=null;
  if(raw.review!==null){
    if(!candidate)throw new OutlineError('INCOMPLETE','review candidate missing','review');
    const status=capture(z.object({status:z.enum(['reviewed','rejected'])}),raw.review,'review status',OUTLINE_ENVELOPE_BYTES).status;
    review=status==='reviewed'?validateReviewedOutline(run.brief,run.source,candidate,raw.review):validateRejectedOutline(run.brief,run.source,candidate,raw.review);
  }
  return deepFreeze({run,candidate,review});
}
