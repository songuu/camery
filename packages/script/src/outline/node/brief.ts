import { OutlineError } from '../contracts.js';
import { capture,deepFreeze } from '../boundary.js';
import { assertOutlineSelection } from '../selection.js';
import { captureRuleThresholds,getGenreProfile } from '../profiles.js';
import { OutlineBriefInputSchema,OutlineBriefSchema } from '../generation-contracts.js';
import type { OutlineBrief } from '../generation-contracts.js';
import { hash } from './data.js';

export function captureOutlineBrief(input:unknown):OutlineBrief{
  const raw=capture(OutlineBriefInputSchema,input,'brief',16384);
  assertOutlineSelection(raw);
  const profiles=[raw.mainGenre,...raw.auxiliaryGenres].map(id=>{const profile=getGenreProfile(id);return {id,version:profile.version,digest:hash(profile)};});
  const body={version:1 as const,...raw,thresholds:captureRuleThresholds(raw.thresholds),profiles};
  return deepFreeze({...body,digest:hash(body)});
}
export function validateOutlineBrief(input:unknown):OutlineBrief{
  const raw=capture(OutlineBriefSchema,input,'brief snapshot',16384);
  const {version:_version,profiles,digest,...original}=raw;const actual=captureOutlineBrief(original);
  if(actual.digest!==digest||hash(actual.profiles)!==hash(profiles))throw new OutlineError('CONFLICT','brief binding','brief');
  return actual;
}
