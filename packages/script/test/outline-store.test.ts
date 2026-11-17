import { describe,expect,it,vi } from 'vitest';
import { createOutlineCandidate,generateOutline } from '../src/outline/node/generation.js';
import { outlineCallId,outlineRunDigest } from '../src/outline/node/persistence-contracts.js';
import { captureOutlineBrief } from '../src/outline/node/brief.js';
import type { OutlineCandidate,OutlineReviewHost } from '../src/outline/generation-contracts.js';
import { hash } from '../src/outline/node/data.js';
import { OutlineError } from '../src/outline/contracts.js';
import { outlineModelFixture } from './outline-model-support.js';
import { outlineMemory } from './outline-store-memory.js';

it('rejects a consistently rehashed run brief that is not its actual historical parent row',async()=>{
  const f=await storedOutlineFixture();const {version:_v,digest:_d,profiles:_p,...input}=f.run.brief;
  const brief=captureOutlineBrief({...input,notes:'不存在于真实父行的另一个同版本简报。'});const {createdAt:_at,digest:_digest,...old}=f.run;
  const body={...old,brief},digest=outlineRunDigest(body),row=f.data.runs[0]!;row.record={...body,digest};row.digest=digest;row.brief_digest=brief.digest;
  row.request_digest=hash({briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest,source:f.source.descriptor,execution:f.run.execution,method:f.run.method});
  await expect(f.store.read(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
/** Includes an explicit live-model protocol branch with an in-memory transport; it proves no real inference or bill. */
export async function storedOutlineFixture(evidence:'synthetic_replay'|'live_model'='synthetic_replay'){
  const f=await outlineModelFixture(evidence);const db=outlineMemory(f.source);const {version:_v,digest:_d,profiles:_p,revision:_r,...fields}=f.brief;
  const put={...fields,expectedRevision:0,actorId:f.host.actor.id};const brief=(await db.store.putBrief(put)).brief;
  const key={tenantId:brief.tenantId,projectId:brief.projectId,runId:'outline-one'};
  const costMicros=evidence==='live_model'?100:0;
  const execution={connectionId:f.session.profile.connectionId,modeDigest:f.session.profile.modeDigest,modelIdentity:f.session.profile.modelIdentity,evidence:f.session.profile.evidence,modelTier:'balanced',currency:'CNY',reservation:{tokens:300,costMicros},limits:{steps:1,tokens:300,costMicros},...(evidence==='live_model'?{pricing:{inputMicrosPerMillionTokens:100000,outputMicrosPerMillionTokens:50000}}:{})};
  const command={...key,briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest,source:f.source.descriptor,execution};const run=await db.store.start(command);
  const candidate=await generateOutline({...f,brief:run.brief,source:run.source,context:{...f.context,idempotencyKey:outlineCallId(key)}});
  const decision={candidateDigest:candidate.digest,output:candidate.output,ablations:[{genre:'suspense',judgment:'participates',reason:'测试宿主明确核对查证改变反击。'}],waivers:[]};
  return {...f,...db,put,command,key,run,candidate,decision};
}
it('persists a complete run/candidate/review once and reconstructs independent immutable snapshots',async()=>{
  const f=await storedOutlineFixture();expect(await f.store.start(f.command)).toEqual(f.run);expect(await f.store.saveCandidate(f.key,f.candidate)).toEqual(f.candidate);expect(await f.store.saveCandidate(f.key,f.candidate)).toEqual(f.candidate);
  const reviewed=await f.store.review(f.key,f.decision,f.host);expect(await f.store.review(f.key,f.decision,{...f.host,at:'2026-11-17T12:00:00.000Z'})).toEqual(reviewed);
  expect((await f.store.read(f.key)).review).toEqual(reviewed);expect(await f.store.isCurrent(f.key)).toBe(true);expect(f.data.candidates).toHaveLength(1);expect(f.data.reviews).toHaveLength(1);
});
it('retains historical results and exact authorized ACKs while refusing first stale reviews',async()=>{
  const f=await storedOutlineFixture();f.state.current=false;await f.store.saveCandidate(f.key,f.candidate);expect(await f.store.isCurrent(f.key)).toBe(false);
  await expect(f.store.review(f.key,f.decision,f.host)).rejects.toMatchObject({code:'CONFLICT'});expect(f.data.reviews).toEqual([]);
  const g=await storedOutlineFixture();await g.store.saveCandidate(g.key,g.candidate);const reviewed=await g.store.review(g.key,g.decision,g.host);g.state.current=false;
  await g.store.putBrief({...g.put,expectedRevision:1,notes:'已经修订的目标。'});expect(await g.store.review(g.key,g.decision,g.host)).toEqual(reviewed);
  await expect(g.store.review(g.key,g.decision,{...g.host,authorize:()=>false})).rejects.toMatchObject({code:'FORBIDDEN'});
});

const briefKey=(f:Awaited<ReturnType<typeof storedOutlineFixture>>)=>({tenantId:f.key.tenantId,projectId:f.key.projectId,briefId:f.run.brief.briefId});
function gate(){let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});return {wait,release};}
function changedCandidate(candidate:OutlineCandidate,change:(copy:OutlineCandidate)=>void){const copy=structuredClone(candidate);change(copy);const {digest:_digest,...body}=copy;return {...body,digest:hash(body)};}

describe('outline brief and run identity',()=>{
  it('replays exact historical brief writes while rejecting changed actors, content and revision gaps',async()=>{
    const f=await storedOutlineFixture();const first=await f.store.getBrief(briefKey(f));
    expect(await f.store.putBrief({...f.put})).toEqual(first);expect(f.data.briefs).toHaveLength(1);
    await expect(f.store.putBrief({...f.put,actorId:'other-editor'})).rejects.toMatchObject({code:'CONFLICT'});
    await expect(f.store.putBrief({...f.put,notes:'changed at revision one'})).rejects.toMatchObject({code:'CONFLICT'});
    await expect(f.store.putBrief({...f.put,expectedRevision:4})).rejects.toMatchObject({code:'CONFLICT'});
    const second=await f.store.putBrief({...f.put,expectedRevision:1,notes:'new revision'});
    expect(second.brief.revision).toBe(2);expect(await f.store.getBrief(briefKey(f))).toEqual(second);
    expect(await f.store.getBrief({...briefKey(f),revision:1})).toEqual(first);expect(await f.store.putBrief(f.put)).toEqual(first);
    await expect(f.store.getBrief({...briefKey(f),revision:3})).rejects.toMatchObject({code:'NOT_FOUND'});expect(f.data.briefs).toHaveLength(2);
  });
  it('acknowledges an exact historical start without resolving a now-stale source again',async()=>{
    const f=await storedOutlineFixture();f.state.current=false;await f.store.putBrief({...f.put,expectedRevision:1,notes:'new goal'});const reads=f.sourceReader.mock.calls.length;
    expect(await f.store.start(f.command)).toEqual(f.run);expect(f.sourceReader).toHaveBeenCalledTimes(reads);expect(f.data.runs).toHaveLength(1);
    await expect(f.store.start({...f.command,execution:{...f.command.execution,connectionId:'other'}})).rejects.toMatchObject({code:'CONFLICT'});
    await expect(f.store.start({...f.command,expectedBriefDigest:'b'.repeat(64)})).rejects.toMatchObject({code:'CONFLICT'});
  });
  it('requires the exact current brief for a new start and rejects source scope before opening SQL',async()=>{
    const f=await storedOutlineFixture();const command={...f.command,runId:'new-run'};
    await expect(f.store.start({...command,expectedRevision:2})).rejects.toMatchObject({code:'CONFLICT'});
    await expect(f.store.start({...command,briefId:'absent'})).rejects.toMatchObject({code:'CONFLICT'});
    const connects=f.connect.mock.calls.length;
    await expect(f.store.start({...command,source:{...command.source,tenantId:'foreign'}})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(f.connect).toHaveBeenCalledTimes(connects);expect(f.data.runs).toHaveLength(1);
  });
  it('rejects a mismatched trusted source reader response and rolls its new run back',async()=>{
    const f=await storedOutlineFixture();f.sourceReader.mockResolvedValue({...f.source,descriptor:{...f.source.descriptor,runDigest:'b'.repeat(64)}});
    await expect(f.store.start({...f.command,runId:'new-run'})).rejects.toMatchObject({code:'CONFLICT'});expect(f.data.runs).toHaveLength(1);
  });
  it.each(['CONFLICT','INCOMPLETE','NOT_FOUND'] as const)('treats source %s as noncurrent while preserving historical reads',async code=>{
    const f=await storedOutlineFixture();f.sourceReader.mockRejectedValue(new OutlineError(code,'fixture source','source'));
    expect(await f.store.isCurrent(f.key)).toBe(false);expect((await f.store.read(f.key)).run).toEqual(f.run);
  });
  it.each(['FORBIDDEN','STORAGE_FAILED'] as const)('does not turn source %s into an ordinary stale result',async code=>{
    const f=await storedOutlineFixture();f.sourceReader.mockRejectedValue(new OutlineError(code,'fixture source','source'));
    await expect(f.store.isCurrent(f.key)).rejects.toMatchObject({code});
  });
  it('returns false for a changed outline brief without consulting source currentness',async()=>{
    const f=await storedOutlineFixture();await f.store.putBrief({...f.put,expectedRevision:1,notes:'new notes'});const reads=f.sourceReader.mock.calls.length;
    expect(await f.store.isCurrent(f.key)).toBe(false);expect(f.sourceReader).toHaveBeenCalledTimes(reads);
  });
});

describe('outline candidate and human decisions',()=>{
  it('retains an old live-model protocol result after source staleness without another model call or new source resolution',async()=>{
    const f=await storedOutlineFixture('live_model');f.state.current=false;const reads=f.sourceReader.mock.calls.length;
    expect(f.candidate.model.evidence).toBe('live_model');expect(f.run.execution.evidence).toBe(f.session.profile.evidence);
    expect(await f.store.saveCandidate(f.key,f.candidate)).toEqual(f.candidate);expect(f.exchange).toHaveBeenCalledOnce();expect(f.sourceReader).toHaveBeenCalledTimes(reads);
    expect((await f.store.read(f.key)).candidate).toEqual(f.candidate);await expect(f.store.review(f.key,f.decision,f.host)).rejects.toMatchObject({code:'CONFLICT'});
  });
  it.each(['callId','connectionId','modeDigest','modelIdentity','evidence'] as const)('rejects a candidate whose %s differs from the frozen execution',async field=>{
    const f=await storedOutlineFixture();const candidate=changedCandidate(f.candidate,value=>Object.assign(value.model,{[field]:field==='modeDigest'?'b'.repeat(64):field==='evidence'?'live_model':'other-model-binding'}));
    await expect(f.store.saveCandidate(f.key,candidate)).rejects.toMatchObject({code:'INVALID_EVIDENCE'});expect(f.data.candidates).toEqual([]);
  });
  it('rejects a different valid receipt for the same candidate identity and preserves the original bytes',async()=>{
    const f=await storedOutlineFixture();await f.store.saveCandidate(f.key,f.candidate);
    const changed=createOutlineCandidate(f.run.brief,f.run.source,f.candidate.output,{...f.candidate.model,providerRequestId:'other-reply'});
    await expect(f.store.saveCandidate(f.key,changed)).rejects.toMatchObject({code:'CONFLICT'});expect((await f.store.read(f.key)).candidate).toEqual(f.candidate);expect(f.data.candidates).toHaveLength(1);
  });
  it('requires a candidate for both decisions and never manufactures approval from a missing candidate',async()=>{
    const f=await storedOutlineFixture();await expect(f.store.review(f.key,f.decision,f.host)).rejects.toMatchObject({code:'INCOMPLETE'});
    await expect(f.store.reject(f.key,'insufficient plot cause',f.host)).rejects.toMatchObject({code:'INCOMPLETE'});expect(f.data.reviews).toEqual([]);
  });
  it('allows an authorized historical rejection and exact retry, while conflicting with changes or a later approval',async()=>{
    const f=await storedOutlineFixture();await f.store.saveCandidate(f.key,f.candidate);f.state.current=false;
    const rejected=await f.store.reject(f.key,'needs a different final choice',f.host);
    expect(await f.store.reject(f.key,'needs a different final choice',{...f.host,at:'2026-11-17T12:30:00.000Z'})).toEqual(rejected);
    expect((await f.store.read(f.key)).review).toEqual(rejected);expect(f.data.reviews).toHaveLength(1);
    await expect(f.store.reject(f.key,'different rejection',f.host)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(f.store.review(f.key,f.decision,f.host)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(f.store.reject(f.key,'needs a different final choice',{...f.host,authorize:()=>false})).rejects.toMatchObject({code:'FORBIDDEN'});
  });
  it('checks current authorization again for review ACKs and never replaces the first audit time or actor',async()=>{
    const f=await storedOutlineFixture();await f.store.saveCandidate(f.key,f.candidate);const first=await f.store.review(f.key,f.decision,f.host);f.state.current=false;
    const authorize=vi.fn(()=>true);const reads=f.sourceReader.mock.calls.length;
    expect(await f.store.review(f.key,f.decision,{...f.host,at:'2026-11-17T12:30:00.000Z',authorize})).toEqual(first);expect(authorize).toHaveBeenCalledOnce();expect(f.sourceReader).toHaveBeenCalledTimes(reads);
    await expect(f.store.review(f.key,f.decision,{...f.host,actor:{kind:'human',id:'other-editor'}})).rejects.toMatchObject({code:'CONFLICT'});
    await expect(f.store.review(f.key,{...f.decision,output:{...f.candidate.output,adaptation:{...f.candidate.output.adaptation,title:'another title'}}},f.host)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(f.store.reject(f.key,'reject after approval',f.host)).rejects.toMatchObject({code:'CONFLICT'});expect(f.data.reviews).toHaveLength(1);
  });
});

describe('stored outline record verification',()=>{
  const columns={briefs:['tenant_id','project_id','brief_id','revision','actor_id','digest','request_digest','record','created_at'],runs:['tenant_id','project_id','run_id','brief_id','brief_revision','brief_digest','source_digest','digest','request_digest','record','created_at'],candidates:['tenant_id','project_id','run_id','digest','record'],reviews:['tenant_id','project_id','run_id','status','digest','request_digest','record']} as const;
  for(const table of ['briefs','runs','candidates','reviews'] as const){
    it.each(columns[table])(`rejects corrupt ${table} column %s without exposing stored content`,async column=>{
      const f=await storedOutlineFixture();await f.store.saveCandidate(f.key,f.candidate);await f.store.review(f.key,f.decision,f.host);
      const row=structuredClone(f.data[table][0]!);row[column]=column==='record'?{private:'stored-secret'}:column==='created_at'?'not-a-date':column==='revision'||column==='brief_revision'?2:'corrupt';f.state.selectOverrides[table]=[row];
      const action=()=>table==='briefs'?f.store.getBrief(briefKey(f)):f.store.read(f.key);
      await expect(action()).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(action()).rejects.not.toThrow('stored-secret');
    });
    it(`rejects multiple ${table} rows instead of choosing one`,async()=>{
      const f=await storedOutlineFixture();await f.store.saveCandidate(f.key,f.candidate);await f.store.review(f.key,f.decision,f.host);
      f.state.selectOverrides[table]=[f.data[table][0]!,f.data[table][0]!];
      await expect(table==='briefs'?f.store.getBrief(briefKey(f)):f.store.read(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    });
  }
  it('rejects a review whose referenced candidate vanished, and corrupt rejected audit bodies',async()=>{
    const f=await storedOutlineFixture();await f.store.saveCandidate(f.key,f.candidate);await f.store.review(f.key,f.decision,f.host);f.state.selectOverrides.candidates=[];
    await expect(f.store.read(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    const g=await storedOutlineFixture();await g.store.saveCandidate(g.key,g.candidate);await g.store.reject(g.key,'needs revisions',g.host);
    Object.assign(g.data.reviews[0]!.record as object,{reason:'stored-secret altered audit'});await expect(g.store.read(g.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
  it('verifies the model execution again when reading stored candidate rows',async()=>{
    const f=await storedOutlineFixture();await f.store.saveCandidate(f.key,f.candidate);const changed=changedCandidate(f.candidate,value=>{value.model.connectionId='wrong-model';});
    Object.assign(f.data.candidates[0]!,{record:changed,digest:changed.digest});await expect(f.store.read(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
  it('isolates every query by tenant/project and ordinary run or brief identity without parsing decoy records',async()=>{
    const f=await storedOutlineFixture();await f.store.saveCandidate(f.key,f.candidate);await f.store.review(f.key,f.decision,f.host);
    for(const table of ['briefs','runs','candidates','reviews'] as const)f.data[table].push({...structuredClone(f.data[table][0]!),tenant_id:'foreign-tenant',record:'unparsed-secret'});
    expect((await f.store.read(f.key)).candidate).toEqual(f.candidate);expect((await f.store.getBrief(briefKey(f))).brief.digest).toBe(f.run.brief.digest);
    for(const [sql,values] of f.query.mock.calls)if(sql.startsWith('SELECT')&&sql.includes('FROM camery_outline.')){
      expect(sql).toContain('tenant_id=$1 AND project_id=$2');expect(values?.[0]).toBe(f.key.tenantId);expect(values?.[1]).toBe(f.key.projectId);
    }
    await expect(f.store.read({...f.key,runId:'missing'})).rejects.toMatchObject({code:'NOT_FOUND'});await expect(f.store.isCurrent({...f.key,runId:'missing'})).rejects.toMatchObject({code:'NOT_FOUND'});
  });
  it('checks the pretransaction brief lookup for cardinality, malformed values and driver failure',async()=>{
    const f=await storedOutlineFixture();f.state.selectOverrides.runs=[f.data.runs[0]!,f.data.runs[0]!];await expect(f.store.isCurrent(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    f.state.selectOverrides.runs=[{brief_id:'bad/key'}];await expect(f.store.isCurrent(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    delete f.state.selectOverrides.runs;f.state.failOnce.push('SELECT brief_id');await expect(f.store.isCurrent(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
  it('accepts canonical driver timestamp strings and keeps already returned values independent from row storage',async()=>{
    const f=await storedOutlineFixture();await f.store.saveCandidate(f.key,f.candidate);f.data.briefs[0]!.created_at=f.run.createdAt;f.data.runs[0]!.created_at=f.run.createdAt;
    expect((await f.store.getBrief(briefKey(f))).createdAt).toBe(f.run.createdAt);const progress=await f.store.read(f.key);expect(progress.run).toEqual(f.run);
    expect(Object.isFrozen(progress.run.source.references[0])).toBe(true);expect(Object.isFrozen(progress.candidate!.model)).toBe(true);
    Object.assign(f.data.candidates[0]!.record as object,{digest:'b'.repeat(64)});expect(progress.candidate).toEqual(f.candidate);await expect(f.store.read(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
});

describe('storage waits and failure boundaries',()=>{
  it('captures brief/start/candidate inputs before a connection wait',async()=>{
    const f=await storedOutlineFixture();const held=gate();f.state.connectGate=held.wait;
    const put=structuredClone({...f.put,expectedRevision:1,notes:'captured note'});const writing=f.store.putBrief(put);put.notes='late note';put.actorId='late actor';held.release();
    expect((await writing).brief.notes).toBe('captured note');f.state.connectGate=null;
    const g=await storedOutlineFixture();const second=gate();g.state.connectGate=second.wait;const command=structuredClone({...g.command,runId:'captured-run'});const starting=g.store.start(command);command.runId='late-run';command.execution.connectionId='late-connection';Object.assign(command.source,{runDigest:'b'.repeat(64)});second.release();
    const run=await starting;expect(run.runId).toBe('captured-run');expect(run.execution.connectionId).toBe(g.command.execution.connectionId);g.state.connectGate=null;
    const third=gate();g.state.connectGate=third.wait;const candidate=structuredClone(g.candidate);const key={...g.key};const saving=g.store.saveCandidate(key,candidate);key.runId='late-run';candidate.output.adaptation.title='late title';third.release();
    expect(await saving).toEqual(g.candidate);expect((await g.store.read(g.key)).candidate).toEqual(g.candidate);
  });
  it('captures the human host and edited decision before the initial brief-lookup wait',async()=>{
    const f=await storedOutlineFixture();await f.store.saveCandidate(f.key,f.candidate);const held=gate();f.state.queryGate={prefix:'SELECT brief_id',wait:held.wait};
    const original=vi.fn(()=>true);const host:OutlineReviewHost={...f.host,actor:{...f.host.actor},authorize:original};const decision=structuredClone(f.decision);const key={...f.key};const pending=f.store.review(key,decision,host);
    Object.assign(host.actor,{id:'late-actor'});Object.assign(host,{at:'bad-date',authorize:()=>false});decision.output.adaptation.title='late title';key.runId='late-run';held.release();
    const reviewed=await pending;expect(reviewed.actorId).toBe(f.host.actor.id);expect(reviewed.output).toEqual(f.candidate.output);expect(original).toHaveBeenCalledOnce();
  });
  it('captures rejection host and run key before a connection wait',async()=>{
    const f=await storedOutlineFixture();await f.store.saveCandidate(f.key,f.candidate);const held=gate();f.state.connectGate=held.wait;
    const authorize=vi.fn(()=>true);const host:OutlineReviewHost={...f.host,actor:{...f.host.actor},authorize};const key={...f.key};const pending=f.store.reject(key,'captured rejection',host);
    Object.assign(host.actor,{id:'late-actor'});Object.assign(host,{at:'bad-date',authorize:()=>false});key.runId='late-run';held.release();
    const rejected=await pending;expect(rejected.actorId).toBe(f.host.actor.id);expect(rejected.at).toBe(f.host.at);expect(rejected.reason).toBe('captured rejection');expect(authorize).toHaveBeenCalledOnce();expect(authorize.mock.calls[0]).toEqual([expect.objectContaining({action:'outline:reject'})]);
  });
  it('captures read identities before waits and rejects malformed commands before requesting a connection',async()=>{
    const f=await storedOutlineFixture();const first=gate();f.state.connectGate=first.wait;const brief={...briefKey(f)};const reading=f.store.getBrief(brief);brief.projectId='late-project';first.release();expect((await reading).brief).toEqual(f.run.brief);
    const second=gate();f.state.connectGate=second.wait;const key={...f.key};const progress=f.store.read(key);key.runId='late-run';second.release();expect((await progress).run).toEqual(f.run);f.state.connectGate=null;
    const connects=f.connect.mock.calls.length;await expect(f.store.read({...f.key,unexpected:true} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
    await expect(f.store.getBrief({...briefKey(f),revision:0})).rejects.toMatchObject({code:'INVALID_INPUT'});await expect(f.store.putBrief({...f.put,approved:true})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(f.connect).toHaveBeenCalledTimes(connects);
  });
  it.each(['connect','sync connect','BEGIN','COMMIT','ROLLBACK','release'] as const)('sanitizes %s failures and releases or destroys the acquired client',async kind=>{
    const f=await storedOutlineFixture();const releases=f.release.mock.calls.length;
    if(kind==='connect')f.state.connectFailure=true;if(kind==='sync connect')f.state.syncConnectFailure=true;if(kind==='BEGIN'||kind==='COMMIT')f.state.failOnce.push(kind);
    if(kind==='ROLLBACK'){f.state.failOnce.push('ROLLBACK');f.state.failOnce.push('SELECT tenant_id');}if(kind==='release')f.state.releaseFailure=true;
    const pending=f.store.read(f.key);await expect(pending).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(pending).rejects.not.toThrow('private');
    expect(f.release).toHaveBeenCalledTimes(releases+(kind==='connect'||kind==='sync connect'?0:1));if(kind==='ROLLBACK')expect(f.state.released.at(-1)).toBe(true);
  });
  it('keeps committed writes recoverable after a release failure and rolls back a failed COMMIT in this protocol fixture',async()=>{
    const f=await storedOutlineFixture();f.state.releaseFailure=true;await expect(f.store.saveCandidate(f.key,f.candidate)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.data.candidates).toHaveLength(1);f.state.releaseFailure=false;
    expect(await f.store.saveCandidate(f.key,f.candidate)).toEqual(f.candidate);expect(f.data.candidates).toHaveLength(1);
    const g=await storedOutlineFixture();g.state.failOnce.push('COMMIT');await expect(g.store.saveCandidate(g.key,g.candidate)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(g.data.candidates).toEqual([]);
  });
  it('rejects empty INSERT RETURNING rows and rolls back their provisional brief/run rows',async()=>{
    const f=await storedOutlineFixture();f.state.emptyInsert=true;
    await expect(f.store.putBrief({...f.put,expectedRevision:1,notes:'unacknowledged'})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.data.briefs).toHaveLength(1);
    await expect(f.store.start({...f.command,runId:'empty-run'})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.data.runs).toHaveLength(1);
  });
  it('sanitizes driver write failures and unknown source failures while preserving the original state',async()=>{
    const f=await storedOutlineFixture();f.state.failOnce.push('INSERT INTO camery_outline.candidates');await expect(f.store.saveCandidate(f.key,f.candidate)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.data.candidates).toEqual([]);
    await f.store.saveCandidate(f.key,f.candidate);f.state.failOnce.push('INSERT INTO camery_outline.reviews');await expect(f.store.review(f.key,f.decision,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.data.reviews).toEqual([]);
    f.sourceReader.mockRejectedValue(new Error('private source driver'));await expect(f.store.isCurrent(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
});
