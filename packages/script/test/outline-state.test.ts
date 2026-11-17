import { expect,it } from 'vitest';
import { captureOutlineProgress } from '../src/outline/node/state.js';
import { outlineModelFixture } from './outline-model-support.js';
import { outlineMemory } from './outline-store-memory.js';

it('captures each outline progress envelope without promoting a client JSON snapshot into approval',async()=>{
  const f=await outlineModelFixture(),db=outlineMemory(f.source);const {version:_v,digest:_d,profiles:_p,revision:_r,...input}=f.brief;
  const brief=(await db.store.putBrief({...input,expectedRevision:0,actorId:f.host.actor.id})).brief;
  const key={tenantId:brief.tenantId,projectId:brief.projectId,runId:'state'};
  const run=await db.store.start({...key,briefId:brief.briefId,expectedRevision:1,expectedBriefDigest:brief.digest,source:f.source.descriptor,execution:{connectionId:f.session.profile.connectionId,modeDigest:f.session.profile.modeDigest,modelIdentity:f.session.profile.modelIdentity,evidence:'synthetic_replay',modelTier:'balanced',currency:'CNY',reservation:{tokens:300,costMicros:0},limits:{steps:1,tokens:300,costMicros:0}}});
  expect(captureOutlineProgress(key,{run,candidate:null,review:null})).toEqual({run,candidate:null,review:null});
  expect(()=>captureOutlineProgress({...key,tenantId:'foreign'},{run,candidate:null,review:null})).toThrow('CONFLICT');
});
