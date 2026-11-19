import {screenplayFormalFixture} from './screenplay-formal-support.js';
import {createScreenplayCandidate,reviewScreenplayCandidate} from '../src/screenplay/node/review.js';
import {prepareScreenplayNativeMapping,screenplayNativeSlots} from '../src/screenplay/node/native-mapping.js';
import {continuityDigest} from '../src/continuity/node/digest.js';
import {SCREENPLAY_CONTEXT_BYTES} from '../src/screenplay/contracts.js';
export async function screenplayNativeFixture(){
  const f=await screenplayFormalFixture(),key={...f.scope,candidateId:'screenplay-native'},candidate=createScreenplayCandidate(f.scope,f.context,f.draft),host={scope:f.scope,actor:{kind:'human' as const,id:'editor'},at:'2026-11-19T05:00:00.000Z',authorize:()=>true};
  const review=reviewScreenplayCandidate(f.context,candidate,{candidateDigest:candidate.digest,draft:f.draft,waivers:candidate.issues.filter(row=>row.severity==='warning').map(row=>({issueId:row.id,reason:'人工逐项核对。'}))},host);
  const ids=screenplayNativeSlots(f.draft).map(slot=>({slot,id:f.id('script-native-'+slot)})),author={kind:'user' as const,id:f.id('script-native-author')},mapping=prepareScreenplayNativeMapping({head:f.head,context:f.context,candidate,review,target:f.target,changeId:f.id('script-native-change'),author,ids});
  const native={version:1 as const,target:f.target,packageId:f.head.package_id,snapshotRevision:f.head.revision.number,episodeId:f.context.episode.id,packageDigest:continuityDigest(f.head,SCREENPLAY_CONTEXT_BYTES),contextDigest:continuityDigest(f.context.nativeContext,SCREENPLAY_CONTEXT_BYTES),previousDigest:null};
  const source={version:1 as const,native,contextDigest:candidate.contextDigest},command={key,target:f.target,expectedSnapshotRevision:native.snapshotRevision,expectedPackageDigest:native.packageDigest,rules:f.context.rules,draft:f.draft,authorId:host.actor.id};
  const body={version:1 as const,key,source,context:f.context,previous:null,candidate,authorId:host.actor.id,createdAt:host.at,commandDigest:continuityDigest(command,SCREENPLAY_CONTEXT_BYTES)},preparation={...body,digest:continuityDigest(body,SCREENPLAY_CONTEXT_BYTES)};
  const progress={preparation,review,current:true};
  return {...f,key,candidate,review,host,ids,author,mapping,progress};
}
