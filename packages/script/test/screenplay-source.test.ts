import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {adoptChangeSet,createVersionState,submitChangeSet} from '@camery/versioning';
import {captureContinuityContext} from '../src/continuity/context.js';
import {continuityDigest} from '../src/continuity/node/digest.js';
import {SCREENPLAY_CONTEXT_BYTES} from '../src/screenplay/contracts.js';
import {readScreenplaySource,readStoredScreenplaySource,projectScreenplayReferences} from '../src/screenplay/node/source.js';
import {outlineFormalMappingFixture,outlineMappingInput} from './outline-formal-mapping-support.js';
import {prepareOutlineMappingDraft,finalizeOutlineChangeSet} from '../src/outline/node/formal-mapping.js';
import {screenplayFixture} from './screenplay-support.js';
const mocks=vi.hoisted(()=>({read:vi.fn(),history:vi.fn()}));
vi.mock('../src/continuity/node/source.js',()=>({readContinuitySource:mocks.read,readStoredContinuitySource:mocks.history,resolveContinuityNativePredecessor:()=>null}));
beforeEach(()=>vi.clearAllMocks());
async function fixture(){
  const f=await outlineFormalMappingFixture(),draft=prepareOutlineMappingDraft(outlineMappingInput(f));
  const request=finalizeOutlineChangeSet({draft,changeSetId:screenplayFixture().id('screenplay-outline-change'),author:{kind:'user',id:f.reviewer.id},operationIds:draft.operations.map((row,index)=>({slot:row.slot,id:screenplayFixture().id('screenplay-outline-op-'+index)}))});
  const result=adoptChangeSet(submitChangeSet(createVersionState(f.head),request).state,request.id,{actor:{kind:'user',id:f.reviewer.id},scope:{kind:'project',id:f.head.project.id},at:f.host.at,authorize:()=>true});expect(result.status).toBe('adopted');
  const head=result.state.head,context=captureContinuityContext(head),episodeId=context.episodes[0]!.id;
  const selection={scope:{tenantId:f.key.tenantId,projectId:f.key.projectId},target:f.identities.target,episodeId,rules:screenplayFixture().context.rules};
  const source={version:1,target:selection.target,packageId:head.package_id,snapshotRevision:head.revision.number,episodeId,packageDigest:continuityDigest(head,SCREENPLAY_CONTEXT_BYTES),contextDigest:continuityDigest(context,SCREENPLAY_CONTEXT_BYTES),previousDigest:null};
  mocks.read.mockResolvedValue({source,context,previous:null});
  const query=vi.fn(async()=>({rows:[{package:head}]})),client={query} as unknown as PoolClient,readForAdoption=vi.fn(async()=>f.progress),outline={readForAdoption};
  return {f,head,source,context,selection,client,query,outline,refresh:()=>{source.packageDigest=continuityDigest(head,SCREENPLAY_CONTEXT_BYTES);}};
}
it('reads the adopted complete episode and immutable original material on the same client, without owning a transaction',async()=>{
  const f=await fixture(),view=await readScreenplaySource(f.client,f.selection,f.outline);
  if(f.head.schema_version!=='0.7.0-draft')throw new Error('fixture version');
  expect(view.context.outline.beats).toHaveLength(f.head.outline_episode_plans[0]!.beats.length);
  expect(view.context.references).toEqual(projectScreenplayReferences(f.f.run.source));
  expect(view.context.references.every(row=>row.quotes.every(quote=>row.text.includes(quote)))).toBe(true);
  expect(f.outline.readForAdoption).toHaveBeenCalledWith(f.client,f.f.source);
  expect(mocks.read).toHaveBeenCalledWith(f.client,expect.objectContaining({episodeId:f.selection.episodeId}),expect.objectContaining({lock:true,previousFor:expect.any(Function)}));
  expect(f.query.mock.calls).toHaveLength(2);expect(f.query).toHaveBeenCalledWith('SET LOCAL search_path = pg_catalog');expect(Object.isFrozen(view.context.references)).toBe(true);
  expect(view.context.previous).toBeNull();expect(view.source.contextDigest).toMatch(/^[a-f0-9]{64}$/);
});
it.each(['cardinality','digest','uniquePlan','stale','scope','missingPlan','beatVersion'] as const)('refuses %s before granting writing-source authority',async mode=>{
  const f=await fixture();if(f.head.schema_version!=='0.7.0-draft')throw new Error('fixture version');
  if(mode==='cardinality')f.query.mockResolvedValue({rows:[]});
  if(mode==='digest')f.source.packageDigest='a'.repeat(64);
  if(mode==='uniquePlan')f.head.outline_episode_plans.push(structuredClone(f.head.outline_episode_plans[0]!));
  if(mode==='stale')f.head.characters[0]!.version++;
  if(mode==='scope')f.selection.scope.tenantId='wrong-tenant';
  if(mode==='missingPlan')f.head.adaptation_plans=[];
  if(mode==='beatVersion')f.head.outline_beats[0]!.version++;
  if(!['cardinality','digest','scope'].includes(mode))f.refresh();
  await expect(readScreenplaySource(f.client,f.selection,f.outline)).rejects.toMatchObject({code:mode==='scope'?'FORBIDDEN':'CONFLICT'});
});
it('refuses immutable progress substitution and sanitizes opaque storage failures',async()=>{
  const f=await fixture();f.outline.readForAdoption.mockRejectedValue(new Error('secret://do-not-render'));
  await expect(readScreenplaySource(f.client,f.selection,f.outline)).rejects.toMatchObject({code:'STORAGE_FAILED',message:expect.not.stringContaining('secret')});
  f.outline.readForAdoption.mockResolvedValue({...f.f.progress,review:null});
  await expect(readScreenplaySource(f.client,f.selection,f.outline)).rejects.toMatchObject({code:'INCOMPLETE'});
});
it.each(['query','outline'] as const)('normalizes a throwing dependency prototype at %s',async mode=>{
  const f=await fixture(),opaque=new Proxy({},{getPrototypeOf(){throw new Error('secret://driver-prototype');}});
  if(mode==='query')f.query.mockRejectedValue(opaque);else f.outline.readForAdoption.mockRejectedValue(opaque);
  await expect(readScreenplaySource(f.client,f.selection,f.outline)).rejects.toMatchObject({code:'STORAGE_FAILED',message:expect.not.stringContaining('secret')});
});
it('refuses a source change between unlocked discovery and the final project lock',async()=>{const f=await fixture();mocks.read.mockResolvedValueOnce({source:f.source,context:f.context,previous:null}).mockResolvedValueOnce({source:{...f.source,contextDigest:'b'.repeat(64)},context:f.context,previous:null});await expect(readScreenplaySource(f.client,f.selection,f.outline)).rejects.toMatchObject({code:'CONFLICT',path:'source changed during locking'});});
it.each(['valid','context','digest','scope','opaque'] as const)('replays historical material without asking for current approval: %s',async mode=>{
  const f=await fixture(),current=await readScreenplaySource(f.client,f.selection,f.outline),stored={scope:f.selection.scope,source:structuredClone(current.source),context:structuredClone(current.context),previous:null},readHistoricalForAdoption=vi.fn(async()=>f.f.progress);
  mocks.history.mockResolvedValue({source:f.source,context:f.context,previous:null,current:false});
  if(mode==='context')stored.context.episode.title+='更改';if(mode==='digest')stored.source.contextDigest='b'.repeat(64);if(mode==='scope')stored.scope={...stored.scope,tenantId:'wrong-scope'};
  if(mode==='opaque')readHistoricalForAdoption.mockRejectedValue(new Proxy({},{getPrototypeOf(){throw new Error('private://prototype');}}));
  const reads=mocks.read.mock.calls.length,result=readStoredScreenplaySource(f.client,stored,{readHistoricalForAdoption});
  if(mode==='valid'){expect((await result).context).toEqual(current.context);expect(readHistoricalForAdoption).toHaveBeenCalledWith(f.client,f.f.source);}else await expect(result).rejects.toThrow();
  expect(mocks.read).toHaveBeenCalledTimes(reads);
});
