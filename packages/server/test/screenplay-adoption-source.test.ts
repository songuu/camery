import {EventEmitter} from 'node:events';
import type {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {adoptChangeSet,createVersionState,submitChangeSet} from '@camery/versioning';
import {screenplayNativeFixture} from '../../script/test/screenplay-native-support.js';
import {continuityDigest} from '../../script/src/continuity/node/digest.js';
import {PostgresScreenplayAdoptionSource} from '../src/projects/screenplay-adoption-source.js';
import {createScreenplayProjectHost} from '../src/projects/screenplay-project-host.js';
import {projectCommandDigest} from '../src/projects/project-command-data.js';
import type {ScreenplayProjectIntent} from '../src/projects/screenplay-intent-contracts.js';
import {screenplayCandidateBusiness,screenplayJournalDigest} from '../src/projects/screenplay-intent-codec.js';
import {screenplayNativeAdoptionFacts} from '../../script/src/screenplay/node/native-adoption.js';

async function fixture(){
  const f=await screenplayNativeFixture(),body={version:1 as const,key:f.key,mapping:f.mapping,ids:f.ids},binding={...body,digest:continuityDigest(body,8388608)};
  const row={tenant_id:f.scope.tenantId,project_id:f.scope.projectId,candidate_id:f.key.candidateId,formal_tenant_id:f.target.tenantId,formal_project_id:f.target.projectId,change_id:f.mapping.request.id,source_revision:String(f.mapping.sourceRevision),mapping_digest:f.mapping.digest,review_digest:f.mapping.reviewDigest,digest:binding.digest,record:binding};
  const state={installed:false,installation:undefined as unknown[]|undefined,owners:[] as {run_id:string}[],deliveries:[] as {run_id:string}[],bindings:[row],snapshots:[{package:f.head}],isolation:'read committed',receipts:[] as Record<string,unknown>[],changes:[] as Record<string,unknown>[],adoptions:[] as Record<string,unknown>[],objects:[] as Record<string,unknown>[]};
  const query=vi.fn(async(sql:string,_values:unknown[]=[])=>{
    if(sql.includes('to_regclass'))return {rows:state.installation??[{runs:state.installed,candidates:state.installed,deliveries:state.installed}]};
    if(sql==='SHOW transaction_isolation')return {rows:[{transaction_isolation:state.isolation}]};
    if(sql.startsWith('SELECT formal_tenant_id,formal_project_id,change_id FROM'))return {rows:state.bindings.map(binding=>({formal_tenant_id:binding.formal_tenant_id,formal_project_id:binding.formal_project_id,change_id:binding.change_id}))};
    if(sql.includes('FROM camery_screenplay.native_bindings'))return {rows:state.bindings};if(sql.includes('FROM camery_screenplay.native_adoptions'))return {rows:state.receipts};if(sql.includes('FROM camery_versioning.snapshots'))return {rows:state.snapshots};
    if(sql.includes('FROM camery_versioning.changes'))return {rows:state.changes};if(sql.includes('FROM camery_versioning.adoptions'))return {rows:state.adoptions};if(sql.includes('FROM camery_versioning.object_revisions'))return {rows:state.objects};
    if(sql.includes('FROM camery_screenplay.generation_runs'))return {rows:state.owners};if(sql.includes('FROM camery_screenplay.generation_deliveries'))return {rows:state.deliveries};return {rows:[]};
  });
  const release=vi.fn(),client=Object.assign(new EventEmitter(),{query,release}),pool={connect:vi.fn(async()=>client)} as unknown as Pool;
  const scripts={readHistorical:vi.fn(async()=>f.progress),readCurrentForPrecheck:vi.fn(async()=>f.progress),readForAdoption:vi.fn(async()=>f.progress)},outline={readForAdoption:vi.fn(),readHistoricalForAdoption:vi.fn()},generations={readHistoricalForQuality:vi.fn()};
  const source=new PostgresScreenplayAdoptionSource({pool,scripts,outline,generations}),subject={tenantId:f.scope.tenantId,userId:'operator',sessionId:'source-session',grants:[{projectId:f.scope.projectId,role:'reviewer' as const}]},host=createScreenplayProjectHost(subject,f.scope.tenantId,f.scope.projectId,'2026-11-20T09:00:00.000Z',true);
  const command={version:1 as const,scope:f.scope,applicationId:'source-journal',actor:{...f.author,key:subject.userId},target:f.target,sourceKey:f.key,preparationDigest:f.progress.preparation.digest,reviewDigest:f.review.digest,packageDigest:f.mapping.packageDigest,contextDigest:f.mapping.contextDigest,episodeId:f.context.episode.id,expectation:{expectedSnapshotRevision:f.mapping.sourceRevision,expectedWriteVersion:1},commandDigest:'a'.repeat(64),changeId:f.mapping.request.id,slotsDigest:projectCommandDigest(f.ids.map(id=>id.slot),8388608),ids:f.ids.map(id=>id.id)};
  const intent:ScreenplayProjectIntent={...command,digest:screenplayJournalDigest(command),businessDigest:screenplayCandidateBusiness(command),createdAt:'2026-11-20T09:00:00.000Z'};
  return {...f,state,query,release,source,scripts,generations,host,intent,pool,client,outline,binding};
}
it('materializes the full reviewed source with frozen journal identities, preserving complete native reads and locks',async()=>{
  const f=await fixture(),result=await f.source.materialize(f.intent,f.host);expect(result.execution).toEqual({key:f.key,mapping:f.mapping,ids:f.ids,expectation:f.intent.expectation});expect(result.producer).toEqual({kind:'manual'});expect(result.progress.current).toBe(false);expect(f.scripts.readHistorical).toHaveBeenCalledWith(expect.anything(),f.key,f.host);expect(f.release).toHaveBeenCalledWith(false);
  expect(f.query.mock.calls.some(([sql])=>/INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
});
it('discovers the actual native candidate through authorized binding parsing and replays its complete reviewed mapping',async()=>{
  const f=await fixture(),result=await f.source.nativeCandidate({scope:f.scope,target:f.target,changeId:f.mapping.request.id},f.host);expect(result?.binding.mapping).toEqual(f.mapping);expect(result?.progress.review?.digest).toBe(f.review.digest);
  f.state.bindings=[];expect(await f.source.nativeCandidate({scope:f.scope,target:f.target,changeId:f.mapping.request.id},f.host)).toBeNull();
});
it.each(['review','scope','target','identities','slots','snapshot','native-body'] as const)('refuses a substituted %s rather than recompiling a different source on retry',async kind=>{
  const f=await fixture(),intent=structuredClone(f.intent);
  if(kind==='review')intent.reviewDigest='c'.repeat(64);if(kind==='scope')intent.sourceKey.projectId='other';if(kind==='target')intent.target.projectId=f.id('other-target');if(kind==='identities')intent.ids[0]=f.id('other-id');if(kind==='slots')intent.slotsDigest='c'.repeat(64);if(kind==='snapshot')f.state.snapshots=[];
  if(kind==='native-body'){const head=structuredClone(f.head);head.project.scope.label='修改了实际基线';f.state.snapshots=[{package:head}];}
  if(kind!=='scope'){const {digest:_digest,businessDigest:_business,createdAt:_at,...body}=intent;intent.digest=screenplayJournalDigest(body);intent.businessDigest=screenplayCandidateBusiness(body);}
  await expect(f.source.materialize(intent,f.host)).rejects.toBeDefined();expect(f.query.mock.calls.some(([sql])=>/INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
});
it('never treats a pending generation owner as manual, and verifies delivered generation against the actual preparation',async()=>{
  const f=await fixture();f.state.installed=true;f.state.owners=[{run_id:'generation'}];
  expect((await f.source.materialize(f.intent,f.host)).producer).toEqual({kind:'pending_generation',runId:'generation'});expect(f.generations.readHistoricalForQuality).not.toHaveBeenCalled();f.state.deliveries=[{run_id:'generation'}];
  f.generations.readHistoricalForQuality.mockResolvedValue({run:{...f.scope,runId:'generation',candidateId:f.key.candidateId,digest:'a'.repeat(64)},candidate:{digest:'b'.repeat(64),candidate:f.progress.preparation.candidate},delivery:{digest:'c'.repeat(64),runDigest:'a'.repeat(64),generatedDigest:'b'.repeat(64),preparationDigest:f.progress.preparation.digest,candidateKey:f.key}} as never);
  expect((await f.source.materialize(f.intent,f.host)).producer).toEqual({kind:'generation',runId:'generation',runDigest:'a'.repeat(64),candidateDigest:'b'.repeat(64),deliveryDigest:'c'.repeat(64)});
  f.generations.readHistoricalForQuality.mockResolvedValue({run:{digest:'a'.repeat(64)},candidate:{digest:'b'.repeat(64)},delivery:{digest:'c'.repeat(64),preparationDigest:'d'.repeat(64),candidateKey:f.key}} as never);await expect(f.source.materialize(f.intent,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});

type Fixture=Awaited<ReturnType<typeof fixture>>;
const selection=(f:Fixture)=>({scope:f.scope,target:f.target,changeId:f.mapping.request.id});
function resign(intent:ScreenplayProjectIntent){const {digest:_digest,businessDigest:_business,createdAt:_at,...body}=intent;return {...intent,digest:screenplayJournalDigest(body),businessDigest:screenplayCandidateBusiness(body)};}
function resignBinding(f:Fixture){const row=f.state.bindings[0]!,{digest:_digest,...body}=row.record;row.record={...body,digest:continuityDigest(body,8388608)};row.digest=row.record.digest;row.mapping_digest=row.record.mapping.digest;row.review_digest=row.record.mapping.reviewDigest;row.candidate_id=row.record.key.candidateId;}
function generated(f:Fixture){return {run:{...f.scope,runId:'generation',candidateId:f.key.candidateId,digest:'a'.repeat(64)},candidate:{digest:'b'.repeat(64),candidate:structuredClone(f.progress.preparation.candidate)},delivery:{digest:'c'.repeat(64),runDigest:'a'.repeat(64),generatedDigest:'b'.repeat(64),preparationDigest:f.progress.preparation.digest,candidateKey:{...f.key}}};}

it('reads the current reviewed source and allows manual origin only after an installed generation registry has no owner or delivery',async()=>{
  const f=await fixture();f.state.installed=true;
  const source=new PostgresScreenplayAdoptionSource({pool:f.pool,scripts:f.scripts,outline:f.outline}),result=await source.readReviewed({key:f.key,target:f.target},f.host);
  expect(result.producer).toEqual({kind:'manual'});expect(result.progress.current).toBe(true);expect(f.scripts.readCurrentForPrecheck).toHaveBeenCalledWith(f.client,f.key,f.host);expect(f.scripts.readHistorical).not.toHaveBeenCalled();
  expect(f.query.mock.calls.filter(([sql])=>sql.includes('candidate_id=$3')).map(([,values])=>values)).toEqual([[f.scope.tenantId,f.scope.projectId,f.key.candidateId],[f.scope.tenantId,f.scope.projectId,f.key.candidateId]]);
  expect(f.query.mock.calls.at(-1)![0]).toBe('COMMIT');expect(f.release).toHaveBeenCalledWith(false);
});
it.each(['missing-review','stale-current','foreign-candidate','foreign-target'] as const)('refuses %s from the actual reviewed-source authority',async kind=>{
  const f=await fixture(),progress=structuredClone(f.progress);
  if(kind==='stale-current')progress.current=false;if(kind==='foreign-candidate')progress.preparation.key.candidateId='another-candidate';if(kind==='foreign-target')progress.preparation.source.native.target.projectId=f.id('foreign-source-target');
  f.scripts.readCurrentForPrecheck.mockResolvedValue(kind==='missing-review'?{...progress,review:null} as never:progress);
  await expect(f.source.readReviewed({key:f.key,target:f.target},f.host)).rejects.toMatchObject({code:kind==='missing-review'||kind==='stale-current'?'CONFLICT':'STORAGE_FAILED'});
  expect(f.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');expect(f.query.mock.calls.some(([sql])=>sql.includes('FROM camery_versioning.snapshots'))).toBe(false);
});
it.each(['project','package','revision','status'] as const)('rejects a valid snapshot whose actual %s does not belong to the source pin',async kind=>{
  const f=await fixture(),head=structuredClone(f.head);if(kind==='project')head.project.id=f.id('different-snapshot-project');if(kind==='package')head.package_id=f.id('different-snapshot-package');if(kind==='revision')head.revision.number++;if(kind==='status')head.revision.status='candidate';f.state.snapshots=[{package:head}];
  await expect(f.source.readReviewed({key:f.key,target:f.target},f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
});

it.each([{rows:[]},{rows:[null]},{rows:[{runs:true,candidates:true,deliveries:'true'}]},{rows:[{runs:false,candidates:false,deliveries:false},{runs:false,candidates:false,deliveries:false}]}])('refuses malformed generation installation evidence $rows',async({rows})=>{
  const f=await fixture();f.state.installation=rows;await expect(f.source.materialize(f.intent,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.generations.readHistoricalForQuality).not.toHaveBeenCalled();
});
it.each(['runs','candidates','deliveries'] as const)('refuses partial generation installation missing %s without inferring a manual producer',async missing=>{
  const f=await fixture();f.state.installation=[{runs:true,candidates:true,deliveries:true,[missing]:false}];await expect(f.source.materialize(f.intent,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  expect(f.query.mock.calls.some(([sql])=>sql.includes('FROM camery_screenplay.generation_runs'))).toBe(false);
});
it.each(['multiple-owners','multiple-deliveries','orphan-delivery','different-run','invalid-pending-run','invalid-delivered-run'] as const)('refuses ambiguous generation provenance: %s',async kind=>{
  const f=await fixture();f.state.installed=true;f.state.owners=[{run_id:'generation'}];f.state.deliveries=[{run_id:'generation'}];
  if(kind==='multiple-owners')f.state.owners.push({run_id:'another-run'});if(kind==='multiple-deliveries')f.state.deliveries.push({run_id:'another-run'});if(kind==='orphan-delivery')f.state.owners=[];if(kind==='different-run')f.state.deliveries=[{run_id:'another-run'}];
  if(kind==='invalid-pending-run'){f.state.owners=[{run_id:'invalid run'}];f.state.deliveries=[];}if(kind==='invalid-delivered-run'){f.state.owners=[{run_id:'invalid run'}];f.state.deliveries=[{run_id:'invalid run'}];}
  await expect(f.source.materialize(f.intent,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.generations.readHistoricalForQuality).not.toHaveBeenCalled();expect(f.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
});
it.each(['missing-delivery','missing-candidate','tenant','project','run','candidate-key','preparation','delivery-key','run-digest','candidate-digest','candidate-body'] as const)('requires actual delivered generation evidence to match its %s',async kind=>{
  const f=await fixture(),value=generated(f);f.state.installed=true;f.state.owners=[{run_id:'generation'}];f.state.deliveries=[{run_id:'generation'}];
  if(kind==='tenant')value.run.tenantId='another-tenant';if(kind==='project')value.run.projectId='another-project';if(kind==='run')value.run.runId='another-run';if(kind==='candidate-key')value.run.candidateId='another-candidate';if(kind==='preparation')value.delivery.preparationDigest='d'.repeat(64);if(kind==='delivery-key')value.delivery.candidateKey.candidateId='another-candidate';if(kind==='run-digest')value.delivery.runDigest='d'.repeat(64);if(kind==='candidate-digest')value.delivery.generatedDigest='d'.repeat(64);if(kind==='candidate-body')value.candidate.candidate.contextDigest='d'.repeat(64);
  f.generations.readHistoricalForQuality.mockResolvedValue((kind==='missing-delivery'?{...value,delivery:null}:kind==='missing-candidate'?{...value,candidate:null}:value) as never);
  await expect(f.source.materialize(f.intent,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.generations.readHistoricalForQuality).toHaveBeenCalledWith(f.client,{...f.scope,runId:'generation'},f.host);
});

it.each(['missing-review','id-count','preparation','package','context','revision','episode'] as const)('cannot materialize frozen identities when actual source lacks the original %s',async kind=>{
  const f=await fixture(),intent=structuredClone(f.intent);if(kind==='missing-review')f.scripts.readHistorical.mockResolvedValue({...f.progress,review:null} as never);
  if(kind==='id-count')intent.ids.pop();if(kind==='preparation')intent.preparationDigest='d'.repeat(64);if(kind==='package')intent.packageDigest='d'.repeat(64);if(kind==='context')intent.contextDigest='d'.repeat(64);if(kind==='revision')intent.expectation.expectedSnapshotRevision++;if(kind==='episode')intent.episodeId=f.id('different-reviewed-episode');
  await expect(f.source.materialize(resign(intent),f.host)).rejects.toMatchObject({code:kind==='missing-review'?'CONFLICT':'STORAGE_FAILED'});expect(f.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
});
it.each(['candidate','identities'] as const)('rejects a self-consistent committed %s that does not belong to the frozen journal',async kind=>{
  const f=await fixture();f.state.bindings[0]!.record=structuredClone(f.binding);if(kind==='candidate')f.state.bindings[0]!.record.key.candidateId='different-committed-candidate';else f.state.bindings[0]!.record.ids[0]!.id=f.id('different-committed-id');resignBinding(f);
  await expect(f.source.materialize(f.intent,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('materializes the original frozen identities before native submission without fabricating a committed binding',async()=>{
  const f=await fixture();f.state.bindings=[];const result=await f.source.materialize(f.intent,f.host);expect(result.binding).toBeNull();expect(result.execution.ids).toEqual(f.ids);expect(result.execution.mapping).toEqual(f.mapping);expect(f.query.mock.calls.at(-1)![0]).toBe('COMMIT');
});
it('does not treat a recomputed committed mapping digest as reviewed-source authority',async()=>{
  const f=await fixture(),raw=structuredClone(f.binding);raw.mapping.contextDigest='d'.repeat(64);const {digest:_digest,...body}=raw.mapping;raw.mapping.digest=continuityDigest(body,8388608);f.state.bindings[0]!.record=raw;resignBinding(f);
  await expect(f.source.nativeCandidate(selection(f),f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});

it('resolves a real source binding, distinguishing absence from a foreign formal target',async()=>{
  const f=await fixture();expect(await f.source.sourceBinding({key:f.key,target:f.target},f.host)).toEqual(f.binding);
  await expect(f.source.sourceBinding({key:f.key,target:{...f.target,projectId:f.id('another-formal-target')}},f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  f.state.bindings=[];expect(await f.source.sourceBinding({key:f.key,target:f.target},f.host)).toBeNull();
});
it.each(['readReviewed','nativeCandidate','sourceBinding','handoff','adoptionProof'] as const)('captures the strict %s selector before obtaining a database connection',async method=>{
  const f=await fixture(),input=method==='readReviewed'||method==='sourceBinding'?{key:f.key,target:f.target,extra:true}:{...selection(f),extra:true};
  await expect(f.source[method](input,f.host)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(f.pool.connect).not.toHaveBeenCalled();
});
it.each(['nativeCandidate','sourceBinding','handoff','adoptionProof'] as const)('rechecks current human scope for %s before reading any native proof',async method=>{
  const f=await fixture(),host={...f.host,scope:{...f.scope,projectId:'outside-project'}},input=method==='sourceBinding'?{key:f.key,target:f.target}:selection(f);
  await expect(f.source[method](input,host)).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.query.mock.calls.map(([sql])=>sql)).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED','SET LOCAL search_path = pg_catalog','ROLLBACK']);expect(f.scripts.readHistorical).not.toHaveBeenCalled();
});
it.each(['handoff','adoptionProof'] as const)('refuses %s when native submission exists but original adoption proof is absent',async method=>{
  const f=await fixture();await expect(f.source[method](selection(f),f.host)).rejects.toMatchObject({code:'INCOMPLETE',path:'original proof'});
  expect(f.query.mock.calls[0]![0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');expect(f.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');expect(f.query.mock.calls.filter(([sql])=>sql.includes('FROM camery_screenplay.native_')).map(([,values])=>values)).toEqual([[f.target.tenantId,f.target.projectId,f.mapping.request.id],[f.target.tenantId,f.target.projectId,f.mapping.request.id]]);expect(f.release).toHaveBeenCalledWith(false);
});
it('does not claim a current handoff when the actual transaction isolation is stronger than READ COMMITTED',async()=>{
  const f=await fixture();f.state.isolation='repeatable read';await expect(f.source.handoff(selection(f),f.host)).rejects.toMatchObject({code:'CONFLICT',path:'transaction_isolation'});expect(f.query.mock.calls.some(([sql])=>sql.includes('FROM camery_screenplay.native_'))).toBe(false);
});
it('reads an adoption proof only from complete pure-native audit, immutable binding, object revisions and actual adopted snapshot',async()=>{
  const f=await fixture(),pending=submitChangeSet(createVersionState(f.head),f.mapping.request),adopted=adoptChangeSet(pending.state,f.mapping.request.id,{actor:f.author,scope:{kind:'episode',id:f.context.episode.id},at:f.host.at,authorize:()=>true});
  if(adopted.status!=='adopted')throw new Error('Expected actual pure native screenplay adoption');
  const body=screenplayNativeAdoptionFacts(f.binding,{...adopted,writeVersion:3}),receipt={...body,digest:continuityDigest(body,8388608)},audit=adopted.state.adoptions.at(-1)!,change=adopted.state.changes.find(row=>row.request.id===f.mapping.request.id)!;
  f.state.receipts=[{formal_tenant_id:f.target.tenantId,formal_project_id:f.target.projectId,change_id:f.mapping.request.id,from_revision:String(receipt.fromRevision),to_revision:String(receipt.toRevision),binding_digest:receipt.bindingDigest,digest:receipt.digest,record:receipt}];
  f.state.changes=[{status:change.status,record:change}];f.state.adoptions=[{from_revision:String(audit.from_revision),to_revision:String(audit.to_revision),record:audit}];
  f.state.objects=adopted.state.revisions.filter(row=>row.change_set_id===f.mapping.request.id).map(row=>({object_id:row.object_id,version:String(row.version),snapshot_revision:String(row.snapshot_revision),change_id:row.change_set_id,record:row}));
  const original=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values=[])=>sql.includes('FROM camery_versioning.snapshots')&&values[2]===receipt.toRevision?{rows:[{package:adopted.state.head}]}:original(sql,values));
  const result=await f.source.adoptionProof(selection(f),f.host);expect(result.receipt).toEqual(receipt);expect(result.binding).toEqual(f.binding);expect(result.head).toEqual(adopted.state.head);expect(f.query.mock.calls.at(-1)![0]).toBe('COMMIT');expect(f.scripts.readForAdoption).not.toHaveBeenCalled();
});
