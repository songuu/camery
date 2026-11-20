import {expect,it} from 'vitest';
import {ScreenplayPrepareCommandSchema,ScreenplayAdoptCommandSchema,ScreenplayRejectCommandSchema,ScreenplayCandidateSchema,ScreenplayHandoffSchema,type ScreenplayPrepareCommand,type ScreenplayAdoptCommand,type ScreenplayRejectCommand,type ScreenplayCandidate,type ScreenplayHandoff} from '@camery/ir/screenplay-adoption';
import {fixtureId as id} from './fixtures';

const base:ScreenplayAdoptCommand={expectedSnapshotRevision:3,expectedWriteVersion:5};
const prepare:ScreenplayPrepareCommand={...base,applicationId:'sc-application',sourceCandidateId:'sc-source',preparationDigest:'a'.repeat(64),reviewDigest:'b'.repeat(64)};
const reject:ScreenplayRejectCommand={...base,reason:'核对整集后重新提交。'};
const receipt={contractVersion:1 as const,projectKey:'project',candidateId:id('sc-candidate'),kind:'preparation' as const,requestId:prepare.applicationId,status:'candidate' as const,snapshotRevision:3,writeVersion:5,issueCount:0,warningCount:32768,adoption:null,rejection:null};
const candidate:ScreenplayCandidate={contractVersion:1,projectKey:'project',candidateId:receipt.candidateId,applicationId:prepare.applicationId,sourceCandidateId:prepare.sourceCandidateId,episodeId:id('episode'),authorId:id('finalizer'),status:'candidate',snapshotRevision:3,writeVersion:5,baseRevision:3,operationCount:18560,sourceState:'current',canReview:true,canAdopt:true,canReject:true,scope:{kind:'episode',id:id('episode')},blockingReasons:[],preparation:receipt};

it('accepts source addresses, fixed digests and CAS bases without source text',()=>{
  expect(ScreenplayPrepareCommandSchema.parse(prepare)).toEqual(prepare);
  expect(ScreenplayAdoptCommandSchema.parse(base)).toEqual(base);
  expect(ScreenplayRejectCommandSchema.parse(reject)).toEqual(reject);
  for(const field of Object.keys(prepare)){
    const missing:Record<string,unknown>={...prepare};delete missing[field];expect(ScreenplayPrepareCommandSchema.safeParse(missing).success).toBe(false);
  }
});
it.each(['actor','actorId','tenantId','source','draft','request','scope','episodeId','body'])('rejects caller-authored %s at every command boundary',field=>{
  expect(ScreenplayPrepareCommandSchema.safeParse({...prepare,[field]:'untrusted'}).success).toBe(false);
  expect(ScreenplayAdoptCommandSchema.safeParse({...base,[field]:'untrusted'}).success).toBe(false);
  expect(ScreenplayRejectCommandSchema.safeParse({...reject,[field]:'untrusted'}).success).toBe(false);
});
it('checks identities, digests, safe revisions and deliberate rejection reasons',()=>{
  for(const field of ['applicationId','sourceCandidateId'])for(const value of ['',' ','bad\n','x'.repeat(129)])expect(ScreenplayPrepareCommandSchema.safeParse({...prepare,[field]:value}).success).toBe(false);
  for(const field of ['preparationDigest','reviewDigest'])for(const value of ['a'.repeat(63),'A'.repeat(64),'a'.repeat(65),'a'.repeat(64)+'\n'])expect(ScreenplayPrepareCommandSchema.safeParse({...prepare,[field]:value}).success).toBe(false);
  for(const field of Object.keys(base))for(const value of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1,'3',null,true])expect(ScreenplayPrepareCommandSchema.safeParse({...prepare,[field]:value}).success).toBe(false);
  expect(ScreenplayRejectCommandSchema.parse({...reject,reason:'x'.repeat(500)}).reason).toHaveLength(500);
  for(const reason of ['',' ','\0','\ud800','x'.repeat(501),null])expect(ScreenplayRejectCommandSchema.safeParse({...reject,reason}).success).toBe(false);
});
it('supports complete episode candidates above the ordinary Workbench operation budget',()=>{
  expect(ScreenplayCandidateSchema.parse(candidate)).toEqual(candidate);
  for(const operationCount of [0,501,18560])expect(ScreenplayCandidateSchema.parse({...candidate,operationCount}).operationCount).toBe(operationCount);
  for(const operationCount of [-1,18561,1.5,Infinity,'501',true,null])expect(ScreenplayCandidateSchema.safeParse({...candidate,operationCount}).success).toBe(false);
  for(const status of ['prepared','candidate','adopted','rejected','conflicted','unchanged'])expect(ScreenplayCandidateSchema.parse({...candidate,status,canAdopt:false,canReject:false,preparation:null}).status).toBe(status);
  for(const sourceState of ['current','stale','unavailable'])expect(ScreenplayCandidateSchema.parse({...candidate,sourceState,canAdopt:false}).sourceState).toBe(sourceState);
});
it('expresses a prepared candidate and a different reviewer who can reject without adopting',()=>{
  const prepared={...candidate,status:'prepared',canAdopt:false,canReject:false,preparation:null};
  expect(ScreenplayCandidateSchema.parse(prepared)).toEqual(prepared);
  const otherReviewer={...candidate,canAdopt:false,canReject:true};
  expect(ScreenplayCandidateSchema.parse(otherReviewer)).toEqual(otherReviewer);
  expect(ScreenplayCandidateSchema.parse({...otherReviewer,sourceState:'stale'}).canReject).toBe(true);
});
it('requires a canonical author and explicit boolean decision capabilities',()=>{
  for(const field of ['authorId','canAdopt','canReject']){
    const missing:Record<string,unknown>={...candidate};delete missing[field];expect(ScreenplayCandidateSchema.safeParse(missing).success).toBe(false);
  }
  for(const authorId of ['bad',id('author')+'0',id('author').toLowerCase(),null])expect(ScreenplayCandidateSchema.safeParse({...candidate,authorId}).success).toBe(false);
  for(const field of ['canAdopt','canReject'])for(const value of ['true',1,null])expect(ScreenplayCandidateSchema.safeParse({...candidate,[field]:value}).success).toBe(false);
});
it('allows decision capabilities only with review permission and an eligible candidate state',()=>{
  expect(ScreenplayCandidateSchema.parse({...candidate,canReview:false,canAdopt:false,canReject:false}).canReview).toBe(false);
  for(const capability of ['canAdopt','canReject'])expect(ScreenplayCandidateSchema.safeParse({...candidate,canReview:false,canAdopt:false,canReject:false,[capability]:true}).success).toBe(false);
  for(const status of ['prepared','adopted','rejected','conflicted','unchanged']){
    expect(ScreenplayCandidateSchema.safeParse({...candidate,status,canReject:false}).success).toBe(false);
    expect(ScreenplayCandidateSchema.safeParse({...candidate,status,canAdopt:false}).success).toBe(false);
  }
  for(const sourceState of ['stale','unavailable'])expect(ScreenplayCandidateSchema.safeParse({...candidate,sourceState}).success).toBe(false);
});
it('reads legacy native-bound candidates without inventing a host application or preparation',()=>{
  const legacy={...candidate,applicationId:null,preparation:null};
  expect(ScreenplayCandidateSchema.parse(legacy)).toEqual(legacy);
  expect(ScreenplayCandidateSchema.safeParse({...legacy,preparation:receipt}).success).toBe(false);
  expect(ScreenplayCandidateSchema.safeParse({...legacy,preparation:{...receipt,requestId:null}}).success).toBe(false);
  expect(ScreenplayPrepareCommandSchema.safeParse({...prepare,applicationId:null}).success).toBe(false);
});
it('binds scope to the exact complete episode',()=>{
  for(const scope of [{kind:'project',id:candidate.episodeId},{kind:'scene',id:candidate.episodeId},{kind:'episode',id:id('other')}])expect(ScreenplayCandidateSchema.safeParse({...candidate,scope}).success).toBe(false);
  for(const field of ['candidateId','episodeId'])for(const value of ['bad',id('candidate')+'0',id('candidate').toLowerCase()])expect(ScreenplayCandidateSchema.safeParse({...candidate,[field]:value}).success).toBe(false);
});
it.each(['projectKey','candidateId','requestId','kind'])('binds preparation %s to the candidate and application',field=>{
  const value=field==='candidateId'?id('other'):field==='kind'?'decision':'different';
  expect(ScreenplayCandidateSchema.safeParse({...candidate,preparation:{...receipt,[field]:value}}).success).toBe(false);
});
it('keeps candidate metadata bounded and refuses embedded source bodies or full message arrays',()=>{
  expect(ScreenplayCandidateSchema.parse({...candidate,blockingReasons:Array.from({length:32},()=>'x'.repeat(128))}).blockingReasons).toHaveLength(32);
  for(const blockingReasons of [Array.from({length:33},()=>'reason'),['x'.repeat(129)]])expect(ScreenplayCandidateSchema.safeParse({...candidate,blockingReasons}).success).toBe(false);
  for(const field of ['snapshotRevision','writeVersion','baseRevision'])for(const value of [0,1.5,Number.MAX_SAFE_INTEGER+1,null,true])expect(ScreenplayCandidateSchema.safeParse({...candidate,[field]:value}).success).toBe(false);
  for(const extra of [{draft:{}},{source:{}},{actorId:id('actor')},{tenantId:'tenant'},{issues:[]},{warnings:[]}])expect(ScreenplayCandidateSchema.safeParse({...candidate,...extra}).success).toBe(false);
  expect(ScreenplayCandidateSchema.safeParse({...candidate,preparation:{...receipt,warnings:[]}}).success).toBe(false);
});

const ledger={changeId:id('ledger-change'),proofDigest:'c'.repeat(64),snapshot:{id:id('ledger-snapshot'),version:1},adoptedRevision:6};
const handoff:ScreenplayHandoff={contractVersion:1,projectKey:candidate.projectKey,candidateId:candidate.candidateId,episodeId:candidate.episodeId,state:'ledger_pending',script:{changeId:candidate.candidateId,digest:'d'.repeat(64),fromRevision:3,toRevision:4},ledger:null,lineCount:8192,warningCount:65536};

it('projects verified script and ledger proofs as compact pending or ready handoff metadata',()=>{
  expect(ScreenplayHandoffSchema.parse(handoff)).toEqual(handoff);
  const ready={...handoff,state:'handoff_ready',ledger};
  expect(ScreenplayHandoffSchema.parse(ready)).toEqual(ready);
  expect(ScreenplayHandoffSchema.parse({...ready,ledger:{...ledger,adoptedRevision:4},lineCount:0,warningCount:0}).ledger?.adoptedRevision).toBe(4);
});
it('refuses readiness without a ledger proof or a ledger proof hidden under pending state',()=>{
  expect(ScreenplayHandoffSchema.safeParse({...handoff,state:'handoff_ready'}).success).toBe(false);
  expect(ScreenplayHandoffSchema.safeParse({...handoff,ledger}).success).toBe(false);
  const missingProof:Record<string,unknown>={...ledger};delete missingProof['proofDigest'];
  expect(ScreenplayHandoffSchema.safeParse({...handoff,state:'handoff_ready',ledger:missingProof}).success).toBe(false);
  expect(ScreenplayHandoffSchema.safeParse({...handoff,state:'handoff_ready',ledger:{...ledger,proofDigest:null}}).success).toBe(false);
});
it('binds the script candidate and consecutive revision to the ledger adoption order',()=>{
  expect(ScreenplayHandoffSchema.safeParse({...handoff,script:{...handoff.script,changeId:id('foreign-script')}}).success).toBe(false);
  for(const toRevision of [2,3,5])expect(ScreenplayHandoffSchema.safeParse({...handoff,script:{...handoff.script,toRevision}}).success).toBe(false);
  expect(ScreenplayHandoffSchema.safeParse({...handoff,state:'handoff_ready',ledger:{...ledger,adoptedRevision:3}}).success).toBe(false);
});
it('requires canonical handoff identities, hashes and positive safe revision evidence',()=>{
  for(const field of ['candidateId','episodeId'])for(const value of ['bad',id('other')+'0',id('other').toLowerCase()])expect(ScreenplayHandoffSchema.safeParse({...handoff,[field]:value}).success).toBe(false);
  for(const value of ['','bad\n','p'.repeat(129)])expect(ScreenplayHandoffSchema.safeParse({...handoff,projectKey:value}).success).toBe(false);
  for(const digest of ['a'.repeat(63),'A'.repeat(64),'a'.repeat(64)+'\n']){
    expect(ScreenplayHandoffSchema.safeParse({...handoff,script:{...handoff.script,digest}}).success).toBe(false);
    expect(ScreenplayHandoffSchema.safeParse({...handoff,state:'handoff_ready',ledger:{...ledger,proofDigest:digest}}).success).toBe(false);
  }
  for(const value of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1,'4',null,true]){
    for(const field of ['fromRevision','toRevision'])expect(ScreenplayHandoffSchema.safeParse({...handoff,script:{...handoff.script,[field]:value}}).success).toBe(false);
    expect(ScreenplayHandoffSchema.safeParse({...handoff,state:'handoff_ready',ledger:{...ledger,adoptedRevision:value}}).success).toBe(false);
    expect(ScreenplayHandoffSchema.safeParse({...handoff,state:'handoff_ready',ledger:{...ledger,snapshot:{...ledger.snapshot,version:value}}}).success).toBe(false);
  }
});
it('keeps handoff counts bounded without transporting script or ledger bodies',()=>{
  for(const field of ['lineCount','warningCount'])for(const value of [-1,1.5,Infinity,'1',null,true])expect(ScreenplayHandoffSchema.safeParse({...handoff,[field]:value}).success).toBe(false);
  expect(ScreenplayHandoffSchema.safeParse({...handoff,lineCount:8193}).success).toBe(false);
  expect(ScreenplayHandoffSchema.safeParse({...handoff,warningCount:65537}).success).toBe(false);
  for(const extra of [{body:{}},{draft:{}},{actorId:id('actor')},{acknowledged:true},{warnings:[]}])expect(ScreenplayHandoffSchema.safeParse({...handoff,...extra}).success).toBe(false);
  expect(ScreenplayHandoffSchema.safeParse({...handoff,script:{...handoff.script,body:'script text'}}).success).toBe(false);
  expect(ScreenplayHandoffSchema.safeParse({...handoff,state:'handoff_ready',ledger:{...ledger,body:{}}}).success).toBe(false);
  expect(ScreenplayHandoffSchema.safeParse({...handoff,state:'handoff_ready',ledger:{...ledger,snapshot:{...ledger.snapshot,body:{}}}}).success).toBe(false);
});
