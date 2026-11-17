import { describe,expect,it,vi } from 'vitest';
import { BibleError,captureSource,confirmBible } from '@camery/bible';
import { bibleRunDigest } from '@camery/bible/node';
import type { BibleProgress,BibleStore } from '@camery/bible/node';
import { DevelopmentError } from '../src/contracts.js';
import { generateEpisodes,generateFoundation } from '../src/development.js';
import { reviewEpisodes,reviewFoundation } from '../src/review.js';
import { OutlineError } from '../src/outline/contracts.js';
import type { OutlineSourceDescriptor,OutlineSourceSnapshot } from '../src/outline/generation-contracts.js';
import { hash } from '../src/outline/node/data.js';
import { resolveOutlineSource,validateOutlineSourceSnapshot } from '../src/outline/node/source.js';
import { workflowFixture } from './workflow-support.js';
import { reviewFixture } from '../../bible/test/review-support.js';

async function development(){
  const f=workflowFixture();const foundation=await generateFoundation({...f,method:f.foundationMethod,context:f.context('outline-foundation')});
  const foundationReview=reviewFoundation(f.brief,foundation,{candidateDigest:foundation.digest,output:foundation.output},f.host);
  const episodes=await generateEpisodes({...f,foundation:foundationReview,method:f.episodeMethod,context:f.context('outline-episodes')});
  const episodesReview=reviewEpisodes(f.brief,foundationReview,episodes,{candidateDigest:episodes.digest,output:episodes.output},f.host);
  Object.assign(f.progress.foundation,{candidate:foundation,review:foundationReview});Object.assign(f.progress.episodes,{candidate:episodes,review:episodesReview});
  const descriptor:OutlineSourceDescriptor={kind:'development',...f.key,runDigest:f.run.digest,briefDigest:f.brief.digest,foundationReviewDigest:foundationReview.digest,episodesReviewDigest:episodesReview.digest};
  return {...f,descriptor};
}
function bible(){
  const f=reviewFixture();const review=confirmBible(f.source,f.candidate,f.decision,f.host);
  const execution={connectionId:'fixture',modeDigest:hash('mode'),modelIdentity:'fixture/model',evidence:'synthetic_replay' as const,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:f.plan.chunks.length,tokens:100*f.plan.chunks.length,costMicros:0}};
  const run={tenantId:f.source.tenantId,projectId:f.source.projectId,runId:'bible-run',source:captureSource(f.source),plan:f.plan,method:f.candidate.method,execution,digest:bibleRunDigest(f.plan,f.candidate.method,execution),createdAt:'2026-11-16T10:00:00.000Z'};
  const progress:BibleProgress={run,records:f.candidate.records,candidate:f.candidate,review};
  const store:Pick<BibleStore,'read'|'isCurrent'>={read:vi.fn(async()=>progress),isCurrent:vi.fn(async()=>true)};
  const descriptor:OutlineSourceDescriptor={kind:'bible',tenantId:run.tenantId,projectId:run.projectId,runId:run.runId,runDigest:run.digest,documentId:review.source.documentId,revision:review.source.revision,sourceDigest:review.source.sourceDigest,reviewDigest:review.digest};
  return {...f,run,progress,store,descriptor};
}
function rehash(snapshot:OutlineSourceSnapshot):OutlineSourceSnapshot{const {digest:_digest,...body}=snapshot;return {...body,digest:hash(body)};}

describe('trusted reviewed outline sources',()=>{
  it('loads complete development review outputs and derives exact immutable citation paths',async()=>{
    const f=await development();const source=await resolveOutlineSource(f.descriptor,{development:f.store});
    expect(source.material).toEqual({brief:f.brief,foundation:f.foundation,episodes:f.output});
    expect(source.references.map(ref=>ref.path)).toEqual(['/foundation/world','/foundation/world/rules/0','/foundation/world/rules/1','/foundation/characters/0','/foundation/characters/1','/foundation/characters/2','/foundation/relationships/0','/foundation/relationships/1','/foundation/mainline','/foundation/openQuestions/0',...Array.from({length:10},(_,i)=>`/episodes/episodes/${i}`)]);
    for(const ref of source.references)expect(ref.id).toBe('source:'+hash({path:ref.path}));
    expect(Object.isFrozen(source.material)).toBe(true);expect(Object.isFrozen(source.references[0])).toBe(true);expect(validateOutlineSourceSnapshot(JSON.parse(JSON.stringify(source)))).toEqual(source);
    expect(f.store.isCurrent).toHaveBeenCalledWith(f.key);expect(source).not.toHaveProperty('approved');expect(source.material).not.toHaveProperty('model');
  });
  it('loads only confirmed Bible knowledge, preserving evidence and original IDs without full source text',async()=>{
    const f=bible();const source=await resolveOutlineSource(f.descriptor,{bible:f.store});
    expect(source.material).toEqual({source:f.progress.review!.source,entities:f.progress.review!.status==='confirmed'?f.progress.review!.entities:[],relations:f.progress.review!.status==='confirmed'?f.progress.review!.relations:[],claims:f.progress.review!.status==='confirmed'?f.progress.review!.claims:[]});
    expect(source.references[0]!.path).toBe('/entities/0');expect(source.references.at(-1)!.path).toBe(`/claims/${f.candidate.claims.length-1}`);
    expect(source.material).not.toHaveProperty('document');expect(source.material).not.toHaveProperty('candidate');expect(validateOutlineSourceSnapshot(source)).toEqual(source);
  });
  it.each(['development','bible'] as const)('rejects missing %s store or malformed descriptor before any source read',async kind=>{
    const f=kind==='development'?await development():bible();await expect(resolveOutlineSource(f.descriptor,{})).rejects.toMatchObject({code:'INCOMPLETE'});
    await expect(resolveOutlineSource({...f.descriptor,approval:true},{[kind]:f.store})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(f.store.read).not.toHaveBeenCalled();
  });
  it.each(['development','bible'] as const)('rejects stale %s sources and non-boolean currentness',async kind=>{
    const f=kind==='development'?await development():bible();vi.mocked(f.store.isCurrent).mockResolvedValue(false);
    await expect(resolveOutlineSource(f.descriptor,{[kind]:f.store})).rejects.toMatchObject({code:'CONFLICT'});
    vi.mocked(f.store.isCurrent).mockResolvedValue('true' as never);await expect(resolveOutlineSource(f.descriptor,{[kind]:f.store})).rejects.toMatchObject({code:'CONFLICT'});
  });
  it.each(['tenantId','projectId','runId','runDigest','briefDigest','foundationReviewDigest','episodesReviewDigest'] as const)('rejects mismatched development %s',async field=>{
    const f=await development();const descriptor={...f.descriptor,[field]:field.endsWith('Digest')?'b'.repeat(64):'other'};
    await expect(resolveOutlineSource(descriptor,{development:f.store})).rejects.toBeInstanceOf(OutlineError);expect(f.store.isCurrent).not.toHaveBeenCalled();
  });
  it.each(['tenantId','projectId','runId','runDigest','documentId','revision','sourceDigest','reviewDigest'] as const)('rejects mismatched Bible %s',async field=>{
    const f=bible();const descriptor={...f.descriptor,[field]:field.endsWith('Digest')?'b'.repeat(64):field==='revision'?2:'other'};
    await expect(resolveOutlineSource(descriptor,{bible:f.store})).rejects.toBeInstanceOf(OutlineError);expect(f.store.isCurrent).not.toHaveBeenCalled();
  });
  it.each(['foundation','episodes'] as const)('requires reviewed %s and its original candidate identity',async stage=>{
    const f=await development();Object.assign(f.progress[stage],{review:null});await expect(resolveOutlineSource(f.descriptor,{development:f.store})).rejects.toMatchObject({code:'INCOMPLETE'});
    const g=await development();Object.assign(g.progress[stage],{candidate:null});await expect(resolveOutlineSource(g.descriptor,{development:g.store})).rejects.toMatchObject({code:'INCOMPLETE'});
  });
  it('rejects rejected/unconfirmed Bible and mismatched original candidate identities',async()=>{
    const f=bible();Object.assign(f.progress,{review:{...f.progress.review,status:'rejected'}});await expect(resolveOutlineSource(f.descriptor,{bible:f.store})).rejects.toMatchObject({code:'INCOMPLETE'});
    const g=bible();Object.assign(g.progress,{candidate:{...g.progress.candidate,digest:'b'.repeat(64)}});await expect(resolveOutlineSource(g.descriptor,{bible:g.store})).rejects.toMatchObject({code:'CONFLICT'});
    const h=await development();Object.assign(h.progress.foundation,{candidate:{...h.progress.foundation.candidate,digest:'b'.repeat(64)}});await expect(resolveOutlineSource(h.descriptor,{development:h.store})).rejects.toMatchObject({code:'CONFLICT'});
  });
  it('captures descriptor and returned material before waiting on currentness',async()=>{
    const f=await development();const mutable=structuredClone(f.progress);vi.mocked(f.store.read).mockResolvedValue(mutable);
    let release!:(value:boolean)=>void;let started!:()=>void;const gate=new Promise<boolean>(resolve=>{release=resolve;});const begun=new Promise<void>(resolve=>{started=resolve;});
    vi.mocked(f.store.isCurrent).mockImplementation(async()=>{started();return gate;});const descriptor={...f.descriptor};
    const pending=resolveOutlineSource(descriptor,{development:f.store});await begun;descriptor.runDigest='b'.repeat(64);const review=mutable.foundation.review;if(review?.status!=='reviewed')throw new Error('fixture review missing');review.output.title='late mutation';release(true);
    const snapshot=await pending;expect(snapshot.descriptor.runDigest).toBe(f.run.digest);expect((snapshot.material as {foundation:{title:string}}).foundation.title).toBe(f.foundation.title);
  });
  it('captures complete Bible material before a currentness wait and never traverses the original document',async()=>{
    const f=bible();const mutable=structuredClone(f.progress);vi.mocked(f.store.read).mockResolvedValue(mutable);let documentRead=false;
    Object.defineProperty(mutable.run.source,'document',{enumerable:true,get(){documentRead=true;throw new Error('full original document is outside this projection');}});
    let release!:(value:boolean)=>void;let started!:()=>void;const gate=new Promise<boolean>(resolve=>{release=resolve;});const begun=new Promise<void>(resolve=>{started=resolve;});
    vi.mocked(f.store.isCurrent).mockImplementation(async()=>{started();return gate;});const pending=resolveOutlineSource(f.descriptor,{bible:f.store});await begun;
    if(mutable.review?.status!=='confirmed')throw new Error('fixture confirmation missing');Object.assign(mutable.review.entities[0]!,{name:'late mutation'});release(true);
    const snapshot=await pending;expect((snapshot.material as {entities:{name:string}[]}).entities[0]!.name).toBe('小林');expect(documentRead).toBe(false);
  });
  it.each(['NOT_FOUND','FORBIDDEN','CONFLICT','INPUT_LIMIT','INCOMPLETE','STORAGE_FAILED'] as const)('retains semantic storage error %s without original messages',async code=>{
    const f=bible();vi.mocked(f.store.read).mockRejectedValue(new BibleError(code,'secret source text'));await expect(resolveOutlineSource(f.descriptor,{bible:f.store})).rejects.toMatchObject({code});
    const g=await development();vi.mocked(g.store.isCurrent).mockRejectedValue(new DevelopmentError(code,'secret source text'));await expect(resolveOutlineSource(g.descriptor,{development:g.store})).rejects.toMatchObject({code});
  });
  it('reports unknown storage failures without leaking source text or treating them as staleness',async()=>{
    const f=bible();vi.mocked(f.store.read).mockRejectedValue(new Error('secret source text'));
    await expect(resolveOutlineSource(f.descriptor,{bible:f.store})).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(resolveOutlineSource(f.descriptor,{bible:f.store})).rejects.not.toThrow('secret source text');
  });
  it('rederives citation directories, checks digest/material binding and refuses extra fields',async()=>{
    const f=bible();const snapshot=await resolveOutlineSource(f.descriptor,{bible:f.store});
    const wrong=structuredClone(snapshot);Object.assign(wrong.references[0]!,{id:'source:forged'});expect(()=>validateOutlineSourceSnapshot(rehash(wrong))).toThrow('CONFLICT');
    const path=structuredClone(snapshot);Object.assign(path.references[0]!,{path:'/source'});expect(()=>validateOutlineSourceSnapshot(rehash(path))).toThrow('CONFLICT');
    expect(()=>validateOutlineSourceSnapshot({...snapshot,digest:'b'.repeat(64)})).toThrow('CONFLICT');expect(()=>validateOutlineSourceSnapshot({...snapshot,approved:true})).toThrow('INVALID_INPUT');
  });
  it('refuses an empty knowledge source or directory larger than 2048 rather than dropping entries',async()=>{
    const f=bible();const snapshot=await resolveOutlineSource(f.descriptor,{bible:f.store});const material=structuredClone(snapshot.material) as unknown as {entities:unknown[];relations:unknown[];claims:unknown[]};
    material.entities=[];material.relations=[];material.claims=[];
    expect(()=>validateOutlineSourceSnapshot(rehash({...snapshot,material:material as never,references:[]}))).toThrow('INCOMPLETE');
    material.entities=Array.from({length:2049},(_,i)=>({id:`e${i}`,kind:'concept',name:'项',aliases:[],memberIds:[`m${i}`],descriptions:[{text:'项',evidence:[{start:0,end:1,quote:'第'}]}]}));
    expect(()=>validateOutlineSourceSnapshot(rehash({...snapshot,material:material as never,references:[]}))).toThrow('INPUT_LIMIT');
  });
  it('enforces aggregate source bytes including the directory without retaining partial material',async()=>{
    const f=bible();const mutable=structuredClone(f.progress);vi.mocked(f.store.read).mockResolvedValue(mutable);
    if(mutable.review?.status!=='confirmed')throw new Error('fixture confirmation missing');
    Object.assign(mutable.review.entities[0]!,{aliases:Array.from({length:6000},(_,i)=>`${i}:${'a'.repeat(115)}`)});
    await expect(resolveOutlineSource(f.descriptor,{bible:f.store})).rejects.toMatchObject({code:'INPUT_LIMIT'});expect(f.store.isCurrent).not.toHaveBeenCalled();
  });
  it('does not evaluate source getters or expose projection exceptions',async()=>{
    const f=await development();let called=false;const mutable=structuredClone(f.progress);
    Object.defineProperty(mutable.run,'brief',{enumerable:true,get(){called=true;throw new Error('secret source text');}});vi.mocked(f.store.read).mockResolvedValue(mutable);
    await expect(resolveOutlineSource(f.descriptor,{development:f.store})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(called).toBe(false);
    const g=bible();vi.mocked(g.store.read).mockResolvedValue(new Proxy(g.progress,{getOwnPropertyDescriptor(){throw new Error('secret source text');}}));
    await expect(resolveOutlineSource(g.descriptor,{bible:g.store})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
  it('checks material scope and source identity again when replaying an integrity snapshot',async()=>{
    const f=bible();const snapshot=await resolveOutlineSource(f.descriptor,{bible:f.store});
    expect(()=>validateOutlineSourceSnapshot(rehash({...snapshot,descriptor:{...f.descriptor,tenantId:'foreign'}}))).toThrow('FORBIDDEN');
    expect(()=>validateOutlineSourceSnapshot(rehash({...snapshot,descriptor:{...f.descriptor,sourceDigest:'b'.repeat(64)} as OutlineSourceDescriptor}))).toThrow('CONFLICT');
    const g=await development();const original=await resolveOutlineSource(g.descriptor,{development:g.store});
    expect(()=>validateOutlineSourceSnapshot(rehash({...original,descriptor:{...g.descriptor,projectId:'foreign'}}))).toThrow('FORBIDDEN');
    expect(()=>validateOutlineSourceSnapshot(rehash({...original,descriptor:{...g.descriptor,briefDigest:'b'.repeat(64)} as OutlineSourceDescriptor}))).toThrow('CONFLICT');
  });
  it.each(['duplicate entity','shared member','foreign relation','foreign claim','duplicate claim reference','bad evidence span','duplicate alias'] as const)('validates confirmed material shape and graph (%s)',async kind=>{
    const f=bible();const snapshot=await resolveOutlineSource(f.descriptor,{bible:f.store});const material=structuredClone(snapshot.material) as unknown as {entities:{id:string;memberIds:string[];aliases:string[];descriptions:{evidence:{start:number;end:number;quote:string}[]}[]}[];relations:{from:string}[];claims:{entityIds:string[]}[]};
    if(kind==='duplicate entity')material.entities[1]!.id=material.entities[0]!.id;
    if(kind==='shared member')material.entities[1]!.memberIds=material.entities[0]!.memberIds;
    if(kind==='foreign relation')material.relations[0]!.from='absent';
    if(kind==='foreign claim')material.claims[0]!.entityIds=['absent'];
    if(kind==='duplicate claim reference')material.claims[0]!.entityIds.push(material.claims[0]!.entityIds[0]!);
    if(kind==='bad evidence span')material.entities[0]!.descriptions[0]!.evidence[0]!.end++;
    if(kind==='duplicate alias')material.entities[0]!.aliases=['duplicate','duplicate'];
    expect(()=>validateOutlineSourceSnapshot(rehash({...snapshot,material:material as never}))).toThrow('INVALID_INPUT');
  });
});
