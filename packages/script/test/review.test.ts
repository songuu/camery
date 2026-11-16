import { expect,it,vi } from 'vitest';
import { generateFoundation,generateEpisodes,validateEpisodeCandidate } from '../src/development.js';
import { reviewFoundation,reviewEpisodes,rejectDevelopment } from '../src/review.js';
import { validateReviewedFoundation,validateReviewedEpisodes } from '../src/reviewed.js';
import { captureBrief } from '../src/brief.js';
import { developmentFixture } from './development-support.js';
async function fixture(){const f=developmentFixture();const candidate=await generateFoundation({...f,method:f.foundationMethod,context:f.context('foundation')});return {...f,candidate};}
it('requires explicit host approval, retains raw model output, and binds edited foundation to downstream',async()=>{
  const f=await fixture();const edited=structuredClone(f.foundation);edited.title='人工修改的标题';
  const authorize=vi.fn(()=>true);const reviewed=reviewFoundation(f.brief,f.candidate,{candidateDigest:f.candidate.digest,output:edited},{...f.host,authorize});
  expect(reviewed.status).toBe('reviewed');expect(reviewed.output.title).toBe(edited.title);expect(f.candidate.output.title).not.toBe(edited.title);expect(f.candidate.model.outputDigest).not.toBe(reviewed.digest);
  expect(authorize).toHaveBeenCalledWith({actorId:f.host.actor.id,brief:f.brief,stage:'foundation',action:'development:review'});expect(Object.isFrozen(reviewed.output.characters)).toBe(true);
  expect(validateReviewedFoundation(f.brief,JSON.parse(JSON.stringify(reviewed)))).toEqual(reviewed);
  const episodes=await generateEpisodes({...f,foundation:reviewed,method:f.episodeMethod,context:f.context('episodes')});
  expect(episodes.upstreamDigest).toBe(reviewed.digest);expect(episodes.output.episodes).toHaveLength(10);
  const decision={candidateDigest:episodes.digest,output:f.output};const result=reviewEpisodes(f.brief,reviewed,episodes,decision,f.host);
  expect(result.candidateDigest).toBe(episodes.digest);expect(validateReviewedEpisodes(f.brief,reviewed,JSON.parse(JSON.stringify(result)))).toEqual(result);
  const revised=reviewFoundation(f.brief,f.candidate,{candidateDigest:f.candidate.digest,output:{...edited,title:'另一版设定'}},f.host);
  expect(()=>validateEpisodeCandidate(f.brief,revised,episodes)).toThrow('CONFLICT');expect(()=>reviewEpisodes(f.brief,revised,episodes,decision,f.host)).toThrow('CONFLICT');
});
it('rejects stale briefs, optimistic candidate digests and invalid edits before authorization',async()=>{
  const f=await fixture();const authorize=vi.fn(()=>true);const host={...f.host,authorize};
  const {version:_version,digest:_digest,...fields}=f.brief;const changed=captureBrief({...fields,revision:2,idea:'新的故事前提'});
  expect(()=>reviewFoundation(changed,f.candidate,{candidateDigest:f.candidate.digest,output:f.foundation},host)).toThrow('CONFLICT');
  expect(()=>reviewFoundation(f.brief,f.candidate,{candidateDigest:'a'.repeat(64),output:f.foundation},host)).toThrow('CONFLICT');
  expect(()=>reviewFoundation(f.brief,f.candidate,{candidateDigest:f.candidate.digest,output:{...f.foundation,approved:true}},host)).toThrow('INVALID_INPUT');
  expect(authorize).not.toHaveBeenCalled();
});
it('rejects forged human gates, async truthy approvals and noncanonical audit timestamps',async()=>{
  const f=await fixture();const decision={candidateDigest:f.candidate.digest,output:f.foundation};
  for(const change of [{tenantId:'other'},{projectId:'other'},{actor:{kind:'agent',id:'fake'}},{at:'2026-11-16T12:00:00Z'},{at:'invalid'},{authorize:undefined},{authorize:()=>false},{authorize:()=>1},{authorize:()=>Promise.resolve(true)},{authorize:()=>{throw new Error('private');}}]){
    expect(()=>reviewFoundation(f.brief,f.candidate,decision,{...f.host,...change} as never)).toThrow();
  }
  let called=false;const host=Object.defineProperty({...f.host},'at',{enumerable:true,get(){called=true;throw new Error('private');}});
  expect(()=>reviewFoundation(f.brief,f.candidate,decision,host)).toThrow();expect(called).toBe(false);
});
it('refuses stale or tampered persisted review identities and invalid edited outputs on restore',async()=>{
  const f=await fixture();const reviewed=reviewFoundation(f.brief,f.candidate,{candidateDigest:f.candidate.digest,output:f.foundation},f.host);
  const {version:_version,digest:_digest,...fields}=f.brief;const changed=captureBrief({...fields,revision:2});
  for(const [change,code] of [
    [{stage:'episodes'},'CONFLICT'],[{upstreamDigest:'b'.repeat(64)},'CONFLICT'],[{brief:changed},'CONFLICT'],
    [{at:'invalid'},'INVALID_INPUT'],[{at:'2026-11-16T12:00:00Z'},'INVALID_INPUT'],[{digest:'b'.repeat(64)},'CONFLICT'],[{candidateDigest:'b'.repeat(64)},'CONFLICT'],
    [{output:{...f.foundation,mainline:{...f.foundation.mainline,characterIds:['missing']}}},'INVALID_REFERENCE'],
  ] as const)expect(()=>validateReviewedFoundation(f.brief,{...reviewed,...change})).toThrow(code);
  const episodes=await generateEpisodes({...f,foundation:reviewed,method:f.episodeMethod,context:f.context('episodes')});
  const result=reviewEpisodes(f.brief,reviewed,episodes,{candidateDigest:episodes.digest,output:f.output},f.host);
  for(const [change,code] of [
    [{stage:'foundation'},'CONFLICT'],[{upstreamDigest:'b'.repeat(64)},'CONFLICT'],[{brief:changed},'CONFLICT'],
    [{at:'invalid'},'INVALID_INPUT'],[{digest:'b'.repeat(64)},'CONFLICT'],[{candidateDigest:'b'.repeat(64)},'CONFLICT'],[{output:{episodes:[]}},'INVALID_INPUT'],
  ] as const)expect(()=>validateReviewedEpisodes(f.brief,reviewed,{...result,...change})).toThrow(code);
});
it('preserves explicit rejection and never treats it as a usable upstream',async()=>{
  const f=await fixture();const rejected=rejectDevelopment(f.brief,f.candidate,'设定需要重新讨论。',f.host);
  expect(rejected).toMatchObject({status:'rejected',candidateDigest:f.candidate.digest,actorId:f.host.actor.id,reason:'设定需要重新讨论。'});
  expect(()=>validateReviewedFoundation(f.brief,rejected)).toThrow();expect(()=>rejectDevelopment(f.brief,f.candidate,' ',f.host)).toThrow();
  const approved=reviewFoundation(f.brief,f.candidate,{candidateDigest:f.candidate.digest,output:f.foundation},f.host);
  const episodes=await generateEpisodes({...f,foundation:approved,method:f.episodeMethod,context:f.context('episodes')});
  expect(rejectDevelopment(f.brief,episodes,'重写分集',f.host,approved).stage).toBe('episodes');expect(()=>rejectDevelopment(f.brief,episodes,'重写',f.host)).toThrow('INCOMPLETE');
});
it('observes a rejected asynchronous authorization result while still refusing approval',async()=>{
  const f=await fixture();
  expect(()=>reviewFoundation(f.brief,f.candidate,{candidateDigest:f.candidate.digest,output:f.foundation},{...f.host,authorize:()=>Promise.reject(new Error('private permission failure'))} as never)).toThrow('FORBIDDEN');
  await new Promise<void>(resolve=>setImmediate(resolve));
});
it('rejects non-data candidates without invoking stage accessors or exposing arbitrary failures',async()=>{
  const f=await fixture();let invoked=false;
  const trapped=Object.defineProperty({...f.candidate},'stage',{enumerable:true,get(){invoked=true;throw new Error('private provider detail');}});
  expect(()=>rejectDevelopment(f.brief,trapped,'重写',f.host)).toThrow('INVALID_INPUT');expect(invoked).toBe(false);
  expect(()=>rejectDevelopment(f.brief,null as never,'重写',f.host)).toThrow('INVALID_INPUT');
});
