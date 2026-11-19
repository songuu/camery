import {expect,it} from 'vitest';
import {ChangeSetV08} from '@camery/ir';
import {submitChangeSet,adoptChangeSet} from '@camery/versioning';
import {PostgresContinuityStore} from '../src/continuity/node/store.js';
import {nativeEpisodeSnapshotPins} from '../src/continuity/node/handoff.js';
import {continuityDigest} from '../src/continuity/node/digest.js';
import {CONTINUITY_PREVIOUS_BYTES} from '../src/continuity/node/persistence-contracts.js';
import {prepareContinuityNativeMapping} from '../src/continuity/node/native-mapping.js';
import {readContinuityNativeAdoption,resolveContinuityNativePredecessor} from '../src/continuity/node/source.js';
import {nativeContinuityFixture,id} from './continuity-native-support.js';

async function mixedChain(){
  const f=await nativeContinuityFixture(false);if(f.reviewed.review?.status!=='reviewed')throw new Error('Expected actual human review');
  const ledger=f.reviewed.review.output.ledger,legacy={id:id('mixed-legacy-first'),version:1,episode_id:ledger.episodeId,based_on:nativeEpisodeSnapshotPins(f.memory.state.head,ledger.episodeId),status:'adopted' as const,
    facts:ledger.facts.map(row=>row.text),knowledge:ledger.knowledge.map(row=>({character_id:row.characterId,fact:ledger.facts.find(fact=>fact.id===row.factId)!.text,source:row.learned.evidence.quote})),characters:[],plot_threads:[]};
  function adoptLegacy(ops:unknown[],suffix:string,bases:{id:string;version:number}[]=[]){
    const request=ChangeSetV08.parse({schema_version:'0.8.0-draft',id:id('mixed-legacy-'+suffix),base_revision:f.memory.state.head.revision.number,author:f.mapping.binding.author,status:'candidate',base_revisions:bases,ops});
    const pending=submitChangeSet(f.memory.state,request);expect(pending.status).toBe('candidate');
    const adopted=adoptChangeSet(pending.state,request.id,{actor:request.author,scope:{kind:'episode',id:legacy.episode_id},at:'2026-11-19T04:00:00.000Z',authorize:()=>true});expect(adopted.status).toBe('adopted');
    f.memory.state=adopted.state;f.memory.writeVersion+=2;f.memory.snapshots.set(adopted.state.head.revision.number,structuredClone(adopted.state.head));return request;
  }
  const native=adoptLegacy([{op:'add',op_id:id('mixed-legacy-add'),collection:'episode_state_snapshots',value:legacy}],'initial');
  const body={version:1 as const,id:'mixed-trusted-legacy',scope:f.memory.scope,target:f.memory.target,snapshot:{id:legacy.id,version:1},changeId:native.id,adoptedRevision:f.memory.state.head.revision.number,ledger};
  const previous={...body,digest:continuityDigest(body,CONTINUITY_PREVIOUS_BYTES)},store=new PostgresContinuityStore(f.pool,{previousFor:async()=>previous});
  const source=await store.describeSource(f.selection,f.memory.host),key={...f.command.key,candidateId:'mixed-typed-second'},draft={version:1 as const,episodeId:f.selection.episodeId,events:[]};
  const prepared=await store.prepare({key,target:f.memory.target,expectedSnapshotRevision:source.source.snapshotRevision,expectedPackageDigest:source.source.packageDigest,draft},f.memory.host);
  const waivers=prepared.preparation.candidate.issues.filter(row=>row.severity==='warning').map(row=>({code:row.code,path:row.path,reason:'人工确认本集到期但尚未回收的伏笔，保留警告。'}));
  const progress=await store.confirm(key,{candidateDigest:prepared.preparation.candidate.digest,draft,waivers},f.memory.host);
  const second=prepareContinuityNativeMapping({head:f.memory.state.head,progress,changeId:id('mixed-typed-second-change'),snapshotId:id('mixed-typed-second-snapshot'),operationId:id('mixed-typed-second-op'),author:f.mapping.binding.author});
  await f.commit(second);return {f,legacy,second,adoptLegacy};
}

it.each(['new-legacy-version','changed-body-at-same-version','typed-replacement','ambiguous-legacy-owner'] as const)('invalidates a typed successor after %s while preserving its historical native ACK',async kind=>{
  const {f,legacy,second,adoptLegacy}=await mixedChain();
  if(kind==='new-legacy-version')adoptLegacy([{op:'update',op_id:id('mixed-legacy-edit'),collection:'episode_state_snapshots',target:legacy.id,set:{facts:['人工正式修订了前集事实。']}}],'revised',[{id:legacy.id,version:1}]);
  else if(kind==='changed-body-at-same-version'){f.memory.state.head.episode_state_snapshots.find(row=>row.id===legacy.id)!.facts=['当前正文变化，ID 与版本均未变。'];f.memory.snapshots.set(f.memory.state.head.revision.number,structuredClone(f.memory.state.head));}
  else if(kind==='typed-replacement')adoptLegacy([{op:'add',op_id:id('mixed-new-typed-first'),collection:'continuity_snapshots',value:f.mapping.snapshot}],'typed-replacement');
  else adoptLegacy([{op:'add',op_id:id('mixed-second-legacy-first'),collection:'episode_state_snapshots',value:{...legacy,id:id('mixed-ambiguous-legacy-first')}}],'ambiguous-legacy');
  const client=await f.pool.connect();try{
    expect((await readContinuityNativeAdoption(client,{scope:f.memory.scope,target:f.memory.target,changeId:second.binding.changeId})).ledger).toEqual(second.snapshot.ledger);
    await expect(resolveContinuityNativePredecessor(client,f.selection)).rejects.toMatchObject({code:'CONFLICT'});
  }finally{client.release();}
});
