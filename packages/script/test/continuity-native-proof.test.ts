import {expect,it} from 'vitest';
import {readContinuitySource,readStoredContinuitySource,resolveContinuityNativePredecessor,readContinuityNativeAdoption} from '../src/continuity/node/source.js';
import {PostgresContinuityStore} from '../src/continuity/node/store.js';
import {reduceEpisodeContinuity} from '../src/continuity/reduce.js';
import {nativeContinuityFixture,id} from './continuity-native-support.js';
import {prepareContinuityNativeMapping} from '../src/continuity/node/native-mapping.js';
import type {ContinuityDraft} from '../src/continuity/contracts.js';

it('resolves the complete native typed ledger through actual human review and native history on the same client',async()=>{
  const f=await nativeContinuityFixture(),client=await f.pool.connect();try{
    const view=await readContinuitySource(client,f.selection,{previousFor:resolveContinuityNativePredecessor});expect(view.previous?.version).toBe(2);expect(view.previous?.ledger).toEqual(f.mapping.snapshot.ledger);
    expect(view.previous?.ledger.facts[0]!.text).toBe('已由人类核对的便签事实。');expect(view.previous?.ledger.characters).toHaveLength(1);expect(view.previous?.ledger.threads).toHaveLength(1);
    const next=reduceEpisodeContinuity(view.context,{version:1,episodeId:f.selection.episodeId,events:[]},view.previous!.ledger);expect(next.ledger.facts).toEqual(f.mapping.snapshot.ledger.facts);expect(next.ledger.knowledge).toEqual(f.mapping.snapshot.ledger.knowledge);
    const historical=await readStoredContinuitySource(client,{source:view.source,previous:view.previous});expect(historical.source).toEqual(view.source);expect(historical.previous).toEqual(view.previous);
  }finally{client.release();}
});
it('uses immutable historical reviews after adoption and unrelated later edits while later-episode prepare uses the production resolver',async()=>{
  const f=await nativeContinuityFixture();f.memory.advance();const store=new PostgresContinuityStore(f.pool,{previousFor:resolveContinuityNativePredecessor});
  expect((await store.read(f.command.key,f.memory.host)).current).toBe(false);
  const view=await store.describeSource(f.selection,f.memory.host),command={key:{...f.command.key,candidateId:'second'},target:f.memory.target,expectedSnapshotRevision:view.source.snapshotRevision,expectedPackageDigest:view.source.packageDigest,draft:{version:1 as const,episodeId:f.selection.episodeId,events:[]}};
  const prepared=await store.prepare(command,f.memory.host);expect(prepared.preparation.previous?.version).toBe(2);expect(prepared.preparation.candidate.ledger.facts).toEqual(f.mapping.snapshot.ledger.facts);
});
it.each(['native_bindings','native_adoptions'] as const)('refuses a native snapshot without its %s proof',async table=>{
  const f=await nativeContinuityFixture();f.tables[table]=[];const client=await f.pool.connect();try{await expect(readContinuitySource(client,f.selection,{previousFor:resolveContinuityNativePredecessor})).rejects.toMatchObject({code:'UNADOPTED_SNAPSHOT'});}finally{client.release();}
});
it('refuses stale scene pins even when the referenced beat and line are unchanged',async()=>{
  const f=await nativeContinuityFixture(),scene=f.memory.state.head.scenes.find(row=>row.id===f.memory.state.head.beats.find(row=>row.id===id('b_open'))!.scene_id)!;scene.version++;
  f.memory.snapshots.set(f.memory.state.head.revision.number,structuredClone(f.memory.state.head));const client=await f.pool.connect();try{await expect(readContinuitySource(client,f.selection,{previousFor:resolveContinuityNativePredecessor})).rejects.toMatchObject({code:'CONFLICT'});}finally{client.release();}
});
it('rejects modified human review bodies and native object history despite a structurally valid current ledger',async()=>{
  const f=await nativeContinuityFixture();f.memory.reviewRow()['record']={...f.reviewed.review,actorId:'forged'};const client=await f.pool.connect();try{await expect(readContinuitySource(client,f.selection,{previousFor:resolveContinuityNativePredecessor})).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{client.release();}
  const g=await nativeContinuityFixture(),object=g.memory.state.revisions.find(row=>row.object_id===g.mapping.snapshot.id)!;object.change_set_id=null;const next=await g.pool.connect();try{await expect(readContinuitySource(next,g.selection,{previousFor:resolveContinuityNativePredecessor})).rejects.toMatchObject({code:'UNADOPTED_SNAPSHOT'});}finally{next.release();}
});
it('invalidates a later ledger when an earlier human-reviewed native ledger changes, while preserving its historical adoption ACK',async()=>{
  const f=await nativeContinuityFixture(),store=new PostgresContinuityStore(f.pool,{previousFor:resolveContinuityNativePredecessor});
  async function adoptDraft(draft:ContinuityDraft,candidateId:string,snapshotId:string){
    const key={...f.command.key,candidateId},view=await store.describeSource({...f.selection,episodeId:draft.episodeId},f.memory.host);
    const prepared=await store.prepare({key,target:f.memory.target,expectedSnapshotRevision:view.source.snapshotRevision,expectedPackageDigest:view.source.packageDigest,draft},f.memory.host);
    const waivers=prepared.preparation.candidate.issues.filter(row=>row.severity==='warning').map(row=>({code:row.code,path:row.path,reason:'明确核对当前到期伏笔的演算结果。'}));
    const progress=await store.confirm(key,{candidateDigest:prepared.preparation.candidate.digest,draft,waivers},f.memory.host),mapping=prepareContinuityNativeMapping({head:f.memory.state.head,progress,changeId:id(candidateId+'-change'),snapshotId,operationId:id(candidateId+'-op'),author:f.mapping.binding.author});
    await f.commit(mapping);return mapping;
  }
  const second=await adoptDraft({version:1,episodeId:f.selection.episodeId,events:[]},'second-chain',id('second-chain-snapshot'));
  const edited=structuredClone(f.command.draft),fact=edited.events[0]!;if(fact.op!=='assert_fact')throw new Error('Expected fixture fact');fact.text='人工修订后的第一集事实。';
  await adoptDraft(edited,'first-revised',f.mapping.snapshot.id);const client=await f.pool.connect();try{
    const historical=await readContinuityNativeAdoption(client,{scope:f.memory.scope,target:f.memory.target,changeId:second.binding.changeId});expect(historical.ledger).toEqual(second.snapshot.ledger);
    await expect(resolveContinuityNativePredecessor(client,f.selection)).rejects.toMatchObject({code:'CONFLICT'});
  }finally{client.release();}
});
