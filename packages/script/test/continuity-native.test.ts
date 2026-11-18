import {expect,it,vi} from 'vitest';
import {createVersionState,submitChangeSet,adoptChangeSet} from '@camery/versioning';
import {fixtureId as id,makePackage} from '../../ir/test/fixtures.js';
import {readAdoptedEpisodeHandoff,nativeEpisodeSnapshotPins} from '../src/continuity/node/handoff.js';

function fixture(){
  const baseline=structuredClone(makePackage());baseline.revision.number=1;let state=createVersionState(baseline);const target={tenantId:id('ct-tenant'),projectId:state.head.project.id};
  const store={read:vi.fn(async()=>({state,writeVersion:3}))};
  const snapshot={id:id('ct-snapshot'),version:1,episode_id:id('ep_1'),based_on:nativeEpisodeSnapshotPins(state.head,id('ep_1')),status:'adopted' as const,
    facts:['收到便签'],knowledge:[{character_id:id('char_lin'),fact:'收到便签',source:'已采用第一集便签事件'}],characters:[],plot_threads:[{setup_episode_id:id('ep_1'),payoff_episode_id:id('ep_2'),summary:'便签来历'}]};
  const request={schema_version:'0.5.0-draft',id:id('ct-change'),author:{kind:'user',id:id('ct-human')},status:'candidate',base_revision:1,base_revisions:[],ops:[{op:'add',op_id:id('ct-op'),collection:'episode_state_snapshots',value:snapshot}]};
  const prepare=()=>{const result=submitChangeSet(state,request);expect(result.issues).toEqual([]);expect(result.status).toBe('candidate');state=result.state;};
  const adopt=()=>{const result=adoptChangeSet(state,request.id,{actor:request.author as {kind:'user';id:string},scope:{kind:'project',id:target.projectId},at:'2026-11-18T12:45:00.000Z',authorize:()=>true});expect(result.issues).toEqual([]);expect(result.status).toBe('adopted');state=result.state;};
  return {target,store,snapshot,prepare,adopt,get state(){return state;},set state(value){state=value;}};
}
it('uses a real native adoption record to hand all four ledgers to exactly the next episode',async()=>{
  const f=fixture();f.prepare();await expect(readAdoptedEpisodeHandoff(f.store,f.target,{episodeId:id('ep_2')})).rejects.toMatchObject({code:'INCOMPLETE'});f.adopt();
  const result=await readAdoptedEpisodeHandoff(f.store,f.target,{episodeId:id('ep_2'),expectedRevision:2});expect(result).toMatchObject({kind:'ready',headRevision:2,snapshotAdoptedRevision:2,snapshot:f.snapshot});expect(result.adoption?.actor_id).toBe(id('ct-human'));expect(Object.isFrozen(result.snapshot?.facts)).toBe(true);
});
it('returns an empty first-episode boundary without using a future or candidate snapshot',async()=>{const f=fixture();const result=await readAdoptedEpisodeHandoff(f.store,f.target,{episodeId:id('ep_1')});expect(result).toMatchObject({kind:'first_episode',snapshot:null,adoption:null});});
it('does not trust an adopted status on an initialized row or accept an incomplete script baseline',async()=>{
  const f=fixture();const initial=structuredClone(f.state.head);initial.episode_state_snapshots.push(f.snapshot);f.state=createVersionState(initial);await expect(readAdoptedEpisodeHandoff(f.store,f.target,{episodeId:id('ep_2')})).rejects.toMatchObject({code:'UNADOPTED_SNAPSHOT'});
  const other=fixture();other.snapshot.based_on=[{id:id('ep_1'),version:1}];other.prepare();other.adopt();await expect(readAdoptedEpisodeHandoff(other.store,other.target,{episodeId:id('ep_2')})).rejects.toMatchObject({code:'INCOMPLETE'});
});
it('captures target and selector before awaiting storage and refuses a different project or revision',async()=>{
  const f=fixture();f.prepare();f.adopt();let release!:(value:Awaited<ReturnType<typeof f.store.read>>)=>void;const key={...f.target},selection={episodeId:id('ep_2'),expectedRevision:2};const read=vi.fn(()=>new Promise<Awaited<ReturnType<typeof f.store.read>>>(resolve=>{release=resolve;}));const pending=readAdoptedEpisodeHandoff({read},key,selection);key.projectId=id('other');selection.episodeId=id('ep_1');release({state:f.state,writeVersion:3});expect((await pending).kind).toBe('ready');expect(read).toHaveBeenCalledWith(f.target);
  await expect(readAdoptedEpisodeHandoff(f.store,{...f.target,projectId:id('other')},{episodeId:id('ep_2')})).rejects.toMatchObject({code:'CONFLICT'});await expect(readAdoptedEpisodeHandoff(f.store,f.target,{episodeId:id('ep_2'),expectedRevision:1})).rejects.toMatchObject({code:'CONFLICT'});
});
it('refuses missing storage, opaque failures, malformed state and unsafe selectors without exposing dependency diagnostics',async()=>{
  const f=fixture();await expect(readAdoptedEpisodeHandoff({read:async()=>null},f.target,{episodeId:id('ep_2')})).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(readAdoptedEpisodeHandoff({read:async()=>{throw new Error('private storage token');}},f.target,{episodeId:id('ep_2')})).rejects.toThrow('Continuity native handoff read failed (STORAGE_FAILED) at $');
  await expect(readAdoptedEpisodeHandoff({read:async()=>({state:null,writeVersion:1}) as never},f.target,{episodeId:id('ep_2')})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  let touched=false;const selector=Object.defineProperty({},'episodeId',{enumerable:true,get:()=>{touched=true;return id('ep_1');}});await expect(readAdoptedEpisodeHandoff(f.store,f.target,selector)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(touched).toBe(false);
  await expect(readAdoptedEpisodeHandoff(f.store,f.target,{episodeId:id('missing')})).rejects.toMatchObject({code:'NOT_FOUND'});expect(()=>nativeEpisodeSnapshotPins(f.state.head,id('missing'))).toThrow('NOT_FOUND');
});
it.each(['candidate-head','bad-write','bad-order','ambiguous','duplicate-pins','duplicate-facts','unknown-fact','duplicate-knowledge','empty-source','duplicate-state','future-setup','backward-payoff','history-version','history-value','missing-adoption','bad-actor','bad-scope','bad-adoption-step','missing-change'] as const)('refuses %s rather than silently falling back to another handoff',async kind=>{
  const f=fixture();f.prepare();f.adopt();const snapshot=f.state.head.episode_state_snapshots[0]!,change=f.state.changes[0]!,adoption=f.state.adoptions[0]!,history=f.state.revisions.find(row=>row.object_id===snapshot.id)!;
  if(kind==='candidate-head')f.state.head.revision.status='candidate';
  else if(kind==='bad-write'){f.store.read.mockImplementation(async()=>({state:f.state,writeVersion:0}));}
  else if(kind==='bad-order')f.state.head.episodes[1]!.order_key=f.state.head.episodes[0]!.order_key;
  else if(kind==='ambiguous')f.state.head.episode_state_snapshots.push({...structuredClone(snapshot),id:id('second-snapshot')});
  else if(kind==='duplicate-pins')snapshot.based_on.push({...snapshot.based_on[0]!});
  else if(kind==='duplicate-facts')snapshot.facts.push(snapshot.facts[0]!);
  else if(kind==='unknown-fact')snapshot.knowledge[0]!.fact='不在事实账中';
  else if(kind==='duplicate-knowledge')snapshot.knowledge.push({...snapshot.knowledge[0]!});
  else if(kind==='empty-source')snapshot.knowledge[0]!.source=' ';
  else if(kind==='duplicate-state'){const value={character_id:id('char_lin'),appearance_id:id('look_lin'),spot_id:id('spot_desk'),holding:[id('prop_note')]};snapshot.characters.push(value,structuredClone(value));snapshot.based_on=nativeEpisodeSnapshotPins(f.state.head,id('ep_1'),snapshot);}
  else if(kind==='future-setup')snapshot.plot_threads[0]!.setup_episode_id=id('ep_2');
  else if(kind==='backward-payoff'){snapshot.plot_threads[0]!.setup_episode_id=id('ep_2');snapshot.plot_threads[0]!.payoff_episode_id=id('ep_1');}
  else if(kind==='history-version')history.version++;
  else if(kind==='history-value')history.value=null;
  else if(kind==='missing-adoption')f.state.adoptions=[];
  else if(kind==='bad-actor')adoption.actor_id='invalid';
  else if(kind==='bad-scope')adoption.scope={kind:'scene',id:id('sc_1')};
  else if(kind==='bad-adoption-step')adoption.from_revision=adoption.to_revision;
  else change.status='candidate';
  await expect(readAdoptedEpisodeHandoff(f.store,f.target,{episodeId:id('ep_2')})).rejects.toMatchObject({name:'ContinuityError'});
});
it('supports an episode-scoped native adoption and retains source revision separately from later head changes',async()=>{
  const f=fixture();f.prepare();f.adopt();f.state.adoptions[0]!.scope={kind:'episode',id:id('ep_1')};f.state.head.revision.number=3;
  const result=await readAdoptedEpisodeHandoff(f.store,f.target,{episodeId:id('ep_2')});expect(result).toMatchObject({headRevision:3,snapshotAdoptedRevision:2});
});
it('keeps a previous handoff usable after unrelated later characters and props are actually adopted',async()=>{
  const f=fixture();f.prepare();f.adopt();const before=await readAdoptedEpisodeHandoff(f.store,f.target,{episodeId:id('ep_2')});
  const author={kind:'user' as const,id:id('ct-human')},change={schema_version:'0.5.0-draft',id:id('ct-later-change'),author,status:'candidate',base_revision:2,base_revisions:[],ops:[
    {op:'add',op_id:id('ct-later-op'),collection:'characters',value:{id:id('ct-later-character'),version:1,name:'后续人物',role:'后来出现',default_voice_ref_id:null}},
    {op:'add',op_id:id('ct-later-prop-op'),collection:'props',value:{id:id('ct-later-prop'),version:1,name:'后续道具',description:'与第一集无关'}},
  ]};const submitted=submitChangeSet(f.state,change);expect(submitted.issues).toEqual([]);const adopted=adoptChangeSet(submitted.state,change.id,{actor:author,scope:{kind:'project',id:f.target.projectId},at:'2026-11-18T13:05:00.000Z',authorize:()=>true});expect(adopted.status).toBe('adopted');f.state=adopted.state;
  const after=await readAdoptedEpisodeHandoff(f.store,f.target,{episodeId:id('ep_2')});expect(after.snapshot).toEqual(before.snapshot);expect(after).toMatchObject({headRevision:3,snapshotAdoptedRevision:2});
  const relevant=submitChangeSet(f.state,{...change,id:id('ct-relevant-change'),base_revision:3,base_revisions:[{id:id('char_lin'),version:1}],ops:[{op:'update',op_id:id('ct-relevant-op'),collection:'characters',target:id('char_lin'),set:{name:'改动前集相关人物'}}]});expect(relevant.issues.some(issue=>issue.code==='STALE_REFERENCE')).toBe(true);
});
it('captures physical state dependencies and rejects malformed or expanded adoption metadata',async()=>{
  const f=fixture(),snapshot={...f.snapshot,characters:[{character_id:id('char_lin'),appearance_id:id('look_lin'),spot_id:id('spot_desk'),holding:[id('prop_note')]}]};const refs=nativeEpisodeSnapshotPins(f.state.head,id('ep_1'),snapshot);expect(refs.map(ref=>ref.id)).toEqual(expect.arrayContaining([id('look_lin'),id('prop_note'),id('loc_shop')]));
  expect(()=>nativeEpisodeSnapshotPins(f.state.head,id('ep_2'),snapshot)).toThrow('CONFLICT');f.prepare();f.adopt();Object.assign(f.state.adoptions[0]!,{secret:'private'});await expect(readAdoptedEpisodeHandoff(f.store,f.target,{episodeId:id('ep_2')})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
