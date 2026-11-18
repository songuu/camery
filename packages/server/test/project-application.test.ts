import {expect,it,vi} from 'vitest';
import {ProjectApplication} from '../src/projects/application.js';
import {adoptChangeSet,createVersionState,rejectChangeSet,submitChangeSet} from '@camery/versioning';
import type {ChangeResult} from '@camery/versioning';
import type {PersistedAdoptOptions,VersionTransactionReceipt} from '@camery/versioning/node';
import {mappingFixture} from '../../script/test/development-mapping-fixture.js';
import {ProjectIdentityError} from '../src/projects/contracts.js';
import {CandidateIntentSchema,DecisionIntentSchema,ProjectApplicationError} from '../src/projects/intent-contracts.js';
import type {CandidateIntent,CandidateIntentBody,DecisionIntent,DecisionIntentBody,ProjectActionReceipt} from '../src/projects/intent-contracts.js';
import {projectIntentDigest} from '../src/projects/intent-store.js';
import {ChangeSetV06,ChangeSetV07,upgradeV05Package,upgradeV06Package} from '@camery/ir';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';
import type {SessionIdentity} from '@camery/access';
import type {ProjectApplicationOptions} from '../src/projects/options.js';

const key={tenantId:id('application-tenant'),projectId:id('prj_demo')};
const actor={kind:'user' as const,id:id('user_1')};
it('identifies an actual schema upgrade for another reader without allocating identities or writing',async()=>{
  const f=memory(),prepared=await f.application.prepareUpgrade({subject:subject('editor'),projectId:'project',command:{applicationId:'verified-upgrade',expectedSnapshotRevision:5,expectedWriteVersion:1}}),writes=f.versions.submitWithReceipt.mock.calls.length,allocated=f.newId.mock.calls.length;
  const detail=await f.application.upgradeCandidate({subject:{...subject('viewer'),userId:'another-reader'},projectId:'project',candidateId:prepared.candidateId});
  expect(detail).toMatchObject({contractVersion:1,from:'0.6.0-draft',to:'0.7.0-draft',candidate:{candidateId:prepared.candidateId,applicationId:'verified-upgrade',source:{kind:'manual'},managed:true}});expect(f.versions.submitWithReceipt).toHaveBeenCalledTimes(writes);expect(f.newId).toHaveBeenCalledTimes(allocated);
});
it('does not label an ordinary manual change as a schema upgrade',async()=>{const f=memory(),candidate=await f.application.submitCandidate({subject:subject(),projectId:'project',command:f.command()});await expect(f.application.upgradeCandidate({subject:subject('viewer'),projectId:'project',candidateId:candidate.candidateId})).rejects.toMatchObject({code:'NOT_FOUND'});});
it('rejects an upgrade intent when the actual native candidate operation disagrees',async()=>{const f=memory(),candidate=await f.application.prepareUpgrade({subject:subject('editor'),projectId:'project',command:{applicationId:'mismatched-upgrade',expectedSnapshotRevision:5,expectedWriteVersion:1}}),state=f.getState();const changes=state.changes.map(change=>({...change,request:ChangeSetV07.parse({...change.request,ops:[{op:'add',op_id:id('unexpected-upgrade-op'),collection:'props',value:{id:id('unexpected-upgrade-prop'),version:1,name:'普通道具',description:'不是结构升级'}}]})}));f.versions.read.mockResolvedValueOnce({state:{...state,changes},writeVersion:2});await expect(f.application.upgradeCandidate({subject:subject('viewer'),projectId:'project',candidateId:candidate.candidateId})).rejects.toMatchObject({code:'STORAGE_FAILED'});});
it('authorizes upgrade inspection before any project or candidate reads',async()=>{const f=fixture();await expect(f.application.upgradeCandidate({subject:{...subject('viewer'),grants:[]},projectId:'project',candidateId:id('unread-upgrade')})).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.identities.resolveProject).not.toHaveBeenCalled();expect(f.intents.candidateForChange).not.toHaveBeenCalled();});
const subject=(role:'viewer'|'editor'|'reviewer'|'admin'='admin'):SessionIdentity=>({tenantId:'tenant',userId:'user',sessionId:'session',grants:[{projectId:'project',role}]});
it.each(['adaptation_plans','outline_beats','outline_episode_plans','asset_plans','outline_plot_units','outline_adaptation_decisions'] as const)('closes generic manual writes for source-managed %s until its dedicated source guard is connected',async collection=>{const f=fixture();const state=createVersionState(upgradeV06Package(f.state.head));f.versions.read.mockResolvedValue({state,writeVersion:1});for(const op of [{op:'add',value:{id:id('outline-manual'),version:1}},{op:'update',target:id('outline-manual'),set:{source:{forged:true}}},{op:'remove',target:id('outline-manual')},{op:'replace',target:id('outline-manual'),value:{id:id('outline-manual'),version:1}}]){const change=ChangeSetV07.parse({...changeSet([]),schema_version:'0.7.0-draft',ops:[{...op,collection,op_id:id('closed-op')}],author:actor});await expect(f.application.previewChange({subject:subject('editor'),projectId:'project',command:{change,expectedSnapshotRevision:5}})).rejects.toMatchObject({code:'SOURCE_POLICY_MISSING'});}expect(f.versions.submitWithReceipt).not.toHaveBeenCalled();expect(f.newId).not.toHaveBeenCalled();});
function fixture(){
  const state=createVersionState(upgradeV05Package(makePackage()));
  const identities={resolveProject:vi.fn(async()=>({tenantId:'tenant',projectId:'project',versionKey:key})),resolvePrincipal:vi.fn(async(_input:{tenantId:string;kind:'user';key:string})=>({tenantId:'tenant',kind:'user' as const,key:'user',principal:actor})),resolve:vi.fn(async()=>({scope:{tenantId:'tenant',projectId:'project'},versionKey:key,principal:actor}))};
  const versions={read:vi.fn(async()=>({state,writeVersion:1})),submitWithReceipt:vi.fn(),adoptGuarded:vi.fn(),rejectWithReceipt:vi.fn()};
  const reads={head:vi.fn(async()=>({head:state.head,writeVersion:1,pendingCount:state.changes.filter(row=>row.status==='candidate').length})),history:vi.fn()};
  const intents={findCandidate:vi.fn(async(_input:{applicationId:string}):Promise<CandidateIntent|null>=>null),candidateForChange:vi.fn(async(_input:{changeId:string}):Promise<CandidateIntent|null>=>null),findDecision:vi.fn(async(_input:{requestId:string}):Promise<DecisionIntent|null>=>null),putCandidate:vi.fn(),putDecision:vi.fn(),readPreparationReceipt:vi.fn(async(_input:{applicationId:string}):Promise<ProjectActionReceipt|null>=>null),readDecisionReceipt:vi.fn(async(_input:{requestId:string}):Promise<ProjectActionReceipt|null>=>null),preparationReceiptWriter:vi.fn(),decisionReceiptWriter:vi.fn(),listCandidateHeaders:vi.fn(async()=>({items:[],nextCursor:null}))};
  const development={store:{read:vi.fn(),isCurrent:vi.fn(),readForAdoption:vi.fn()},identities:{prepare:vi.fn()}};const newId=vi.fn(()=>id('allocated'));const options={tenantId:'tenant',identities,versions,reads,intents,development,newId,now:()=> '2026-11-17T07:00:00.000Z'} as unknown as ProjectApplicationOptions;
  return {application:new ProjectApplication(options),options,identities,versions,reads,intents,development,newId,state};
}
it('returns authorized mapped state without writing, allocating IDs or invoking a model',async()=>{
  const f=fixture();const result=await f.application.state({subject:subject(),projectId:'project'});expect(result.projectKey).toBe('project');expect(result.projectId).toBe(key.projectId);expect(result.snapshotRevision).toBe(5);expect(result.canWrite).toBe(true);expect(result.canReview).toBe(true);expect(f.newId).not.toHaveBeenCalled();expect(f.versions.submitWithReceipt).not.toHaveBeenCalled();expect(f.development.identities.prepare).not.toHaveBeenCalled();
});
it.each(['viewer','editor'] as const)('checks %s review permission before any mapping or store read',async role=>{
  const f=fixture();await expect(f.application.adoptCandidate({subject:subject(role),projectId:'project',candidateId:id('change'),requestId:'review',command:{scope:{kind:'project',id:key.projectId},expectedSnapshotRevision:5,expectedWriteVersion:1}})).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.identities.resolve).not.toHaveBeenCalled();expect(f.versions.read).not.toHaveBeenCalled();
});
it('rejects an authenticated subject from another tenant before reading the identity registry',async()=>{
  const f=fixture();await expect(f.application.state({subject:{...subject(),tenantId:'other'},projectId:'project'})).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.identities.resolveProject).not.toHaveBeenCalled();
});
it('previews a strict mapped manual change with no storage or ID-allocation side effects',async()=>{
  const f=fixture();const request=changeSet([{op:'update',op_id:id('preview-op'),collection:'shots',target:id('sh_1'),set:{action:'明确预览'}}],{schema_version:'0.6.0-draft',author:actor,base_revisions:[{id:id('sh_1'),version:1}]});const original=structuredClone(request);
  const result=await f.application.previewChange({subject:subject('editor'),projectId:'project',command:{change:request,expectedSnapshotRevision:5}});expect(result.status).toBe('candidate');expect(result.differences.some(row=>row.id===id('sh_1'))).toBe(true);expect(request).toEqual(original);expect(f.versions.submitWithReceipt).not.toHaveBeenCalled();expect(f.intents.putCandidate).not.toHaveBeenCalled();expect(f.newId).not.toHaveBeenCalled();
});
it('rejects forged request author and stale preview state without persisting a candidate',async()=>{
  const f=fixture();const request=changeSet([{op:'update',op_id:id('preview-op'),collection:'shots',target:id('sh_1'),set:{action:'preview'}}],{schema_version:'0.6.0-draft',base_revisions:[{id:id('sh_1'),version:1}]});
  request.author.id=id('another');await expect(f.application.previewChange({subject:subject('editor'),projectId:'project',command:{change:request,expectedSnapshotRevision:5}})).rejects.toMatchObject({code:'FORBIDDEN'});request.author=actor;await expect(f.application.previewChange({subject:subject('editor'),projectId:'project',command:{change:request,expectedSnapshotRevision:4}})).rejects.toMatchObject({code:'SNAPSHOT_STALE'});expect(f.intents.putCandidate).not.toHaveBeenCalled();
});
it('shows native unmanaged candidates without granting them a fabricated source policy',async()=>{
  const f=fixture();const request=changeSet([{op:'update',op_id:id('native-op'),collection:'shots',target:id('sh_1'),set:{action:'native'}}],{schema_version:'0.6.0-draft',base_revisions:[{id:id('sh_1'),version:1}]});const submitted=submitChangeSet(f.state,request);f.versions.read.mockResolvedValue({state:submitted.state,writeVersion:2});const view=await f.application.candidate({subject:subject(),projectId:'project',candidateId:request.id});expect(view.managed).toBe(false);expect(view.canAdopt).toBe(false);expect(view.blockingReasons).toContain('SOURCE_POLICY_MISSING');
});

function memory(){
  const f=fixture();let state=f.state;let writeVersion=1;let sequence=0;const candidates=new Map<string,CandidateIntent>();const decisions=new Map<string,DecisionIntent>();const preparations=new Map<string,ProjectActionReceipt>();const receipts=new Map<string,ProjectActionReceipt>();
  f.newId.mockImplementation(()=>id('application-allocation-'+sequence++));f.versions.read.mockImplementation(async()=>({state,writeVersion}));f.reads.head.mockImplementation(async()=>({head:state.head,writeVersion,pendingCount:state.changes.filter(row=>row.status==='candidate').length}));
  f.intents.findCandidate.mockImplementation(async(input:{applicationId:string})=>candidates.get(input.applicationId)??null);
  f.intents.candidateForChange.mockImplementation(async(input:{changeId:string})=>[...candidates.values()].find(row=>row.changeId===input.changeId)??null);
  f.intents.putCandidate.mockImplementation(async(input:CandidateIntentBody)=>{const candidate=CandidateIntentSchema.parse({...input,digest:projectIntentDigest(input),businessDigest:projectIntentDigest(input),createdAt:'2026-11-17T07:00:00.000Z'});candidates.set(candidate.applicationId,candidate);if(!candidate.request)preparations.set(candidate.applicationId,receipt(candidate.changeId,'unchanged'));return candidate;});
  f.intents.readPreparationReceipt.mockImplementation(async(input:{applicationId:string})=>preparations.get(input.applicationId)??null);
  const receipt=(changeId:string,status:ProjectActionReceipt['status'],result?:ChangeResult):ProjectActionReceipt=>({version:1,changeId,status,snapshotRevision:state.head.revision.number,writeVersion,issues:result?.issues??[],warnings:result?.warnings??[],adoption:state.adoptions.find(row=>row.change_set_id===changeId)??null,rejection:state.changes.find(row=>row.request.id===changeId)?.rejection??null});
  f.intents.preparationReceiptWriter.mockImplementation((candidate:CandidateIntent)=>async(_client:unknown,result:ChangeResult)=>{preparations.set(candidate.applicationId,receipt(candidate.changeId,result.status,result));});
  f.versions.submitWithReceipt.mockImplementation(async(_key:unknown,request:unknown,_options:unknown,writer:VersionTransactionReceipt)=>{const result=submitChangeSet(state,request);state=result.state;writeVersion++;await writer(null as never,{...result,writeVersion},null as never);return {...result,writeVersion};});
  f.intents.findDecision.mockImplementation(async(input:{requestId:string})=>decisions.get(input.requestId)??null);
  f.intents.putDecision.mockImplementation(async(input:DecisionIntentBody)=>{const previous=decisions.get(input.requestId);if(previous){if(projectIntentDigest({...previous,digest:null,businessDigest:null,createdAt:null,at:null})!==projectIntentDigest({...input,digest:null,businessDigest:null,createdAt:null,at:null}))throw new ProjectApplicationError('CONFLICT','test immutable decision');return previous;}const saved=DecisionIntentSchema.parse({...input,digest:projectIntentDigest(input),businessDigest:projectIntentDigest(input),createdAt:input.at});decisions.set(input.requestId,saved);return saved;});
  f.intents.readDecisionReceipt.mockImplementation(async(input:{requestId:string})=>receipts.get(input.requestId)??null);
  f.intents.decisionReceiptWriter.mockImplementation((decision:DecisionIntent)=>async(_client:unknown,result:ChangeResult)=>{receipts.set(decision.requestId,receipt(decision.changeId,result.status,result));});
  const decide=async(changeId:string,options:PersistedAdoptOptions,writer:VersionTransactionReceipt,reason?:string)=>{const authority={actor:options.actor,scope:options.scope,at:options.at,authorize:()=>options.authorize(options.actor,key,options.scope)};const result=reason===undefined?adoptChangeSet(state,changeId,authority):rejectChangeSet(state,changeId,authority,reason);state=result.state;writeVersion++;await writer(null as never,{...result,writeVersion},null as never);return {...result,writeVersion};};
  f.versions.adoptGuarded.mockImplementation(async(_key:unknown,changeId:string,options:PersistedAdoptOptions,_guard:unknown,writer:VersionTransactionReceipt)=>decide(changeId,options,writer));
  f.versions.rejectWithReceipt.mockImplementation(async(_key:unknown,changeId:string,options:PersistedAdoptOptions,reason:string,writer:VersionTransactionReceipt)=>decide(changeId,options,writer,reason));
  const request=()=>ChangeSetV06.parse(changeSet([{op:'update',op_id:id('memory-op'),collection:'shots',target:id('sh_1'),set:{action:'人工审阅变更'}}],{id:id('memory-change'),schema_version:'0.6.0-draft',author:actor,base_revisions:[{id:id('sh_1'),version:1}]}));
  const command=()=>({applicationId:'manual-command',change:request(),expectedSnapshotRevision:5,expectedWriteVersion:1});
  return {...f,candidates,preparations,decisions,receipts,command,getState:()=>state,setState:(next:typeof state,nextVersion=writeVersion)=>{state=next;writeVersion=nextVersion;}};
}
it('persists a manual command and exact original receipt, then recovers ACK before stale base checks',async()=>{
  const f=memory();const command=f.command();const first=await f.application.submitCandidate({subject:subject('editor'),projectId:'project',command});expect(first.status).toBe('candidate');expect(first.source).toEqual({kind:'manual'});expect(f.newId).not.toHaveBeenCalled();
  f.setState(createVersionState(upgradeV05Package({...makePackage(),revision:{number:8,status:'adopted',note:'advanced'}})),9);
  const ack=await f.application.submitCandidate({subject:subject('editor'),projectId:'project',command});expect(ack.candidateId).toBe(first.candidateId);expect(ack.preparation).toEqual(first.preparation);expect(f.versions.submitWithReceipt).toHaveBeenCalledTimes(1);
  await expect(f.application.submitCandidate({subject:subject('editor'),projectId:'project',command:{...command,expectedWriteVersion:2}})).rejects.toMatchObject({code:'CONFLICT'});
});
it('resumes the exact persisted request after an uncertain submit result without allocating IDs',async()=>{
  const f=memory();const real=f.versions.submitWithReceipt.getMockImplementation()!;f.versions.submitWithReceipt.mockRejectedValueOnce(new Error('connection lost'));const command=f.command();
  await expect(f.application.submitCandidate({subject:subject(),projectId:'project',command})).rejects.toThrow('connection lost');expect(f.candidates.size).toBe(1);expect(f.preparations.size).toBe(0);f.versions.submitWithReceipt.mockImplementation(real);
  const view=await f.application.submitCandidate({subject:subject(),projectId:'project',command});expect(view.status).toBe('candidate');expect(f.intents.putCandidate).toHaveBeenCalledTimes(1);expect(f.newId).not.toHaveBeenCalled();
});
it.each(['adopt','reject'] as const)('fixes the first %s command and replays its receipt after a later head',async action=>{
  const f=memory();const prepared=await f.application.submitCandidate({subject:subject(),projectId:'project',command:f.command()});const input={subject:subject('reviewer'),projectId:'project',candidateId:prepared.candidateId,requestId:'decision',command:{scope:prepared.scope,expectedSnapshotRevision:5,expectedWriteVersion:2,...(action==='reject'?{reason:'补充人物动机'}:{})}};
  const result=action==='adopt'?await f.application.adoptCandidate(input):await f.application.rejectCandidate(input);expect(result.status).toBe(action==='adopt'?'adopted':'rejected');
  const replay=action==='adopt'?await f.application.adoptCandidate(input):await f.application.rejectCandidate(input);expect(replay).toEqual(result);expect(f.versions.adoptGuarded.mock.calls.length+f.versions.rejectWithReceipt.mock.calls.length).toBe(1);
  await expect(f.application.adoptCandidate({...input,subject:subject('editor')})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(f.application.adoptCandidate({...input,command:{scope:prepared.scope,expectedSnapshotRevision:5,expectedWriteVersion:9}})).rejects.toMatchObject({code:'CONFLICT'});
});
it('rejects unmapped decisions, unavailable snapshots, wrong target bindings and stale writes explicitly',async()=>{
  const f=memory();await expect(f.application.adoptCandidate({subject:subject(),projectId:'project',candidateId:id('unknown'),requestId:'unknown',command:{scope:{kind:'project',id:key.projectId},expectedSnapshotRevision:5,expectedWriteVersion:1}})).rejects.toMatchObject({code:'SOURCE_POLICY_MISSING'});
  await expect(f.application.submitCandidate({subject:subject(),projectId:'project',command:{...f.command(),expectedWriteVersion:8}})).rejects.toMatchObject({code:'WRITE_VERSION_CONFLICT'});
  f.reads.head.mockResolvedValueOnce(null as never);await expect(f.application.state({subject:subject(),projectId:'project'})).rejects.toMatchObject({code:'NOT_FOUND'});
  f.identities.resolveProject.mockResolvedValueOnce({tenantId:'tenant',projectId:'project',versionKey:{...key,projectId:id('wrong-project')}});await expect(f.application.state({subject:subject(),projectId:'project'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('keeps a viewer readable without an actor binding and does not swallow other identity faults',async()=>{
  const f=fixture();f.identities.resolvePrincipal.mockRejectedValueOnce(new ProjectIdentityError('PRINCIPAL_BINDING_MISSING','test'));const view=await f.application.state({subject:subject('viewer'),projectId:'project'});expect(view.actorId).toBeNull();expect(view.canWrite).toBe(false);
  f.identities.resolvePrincipal.mockRejectedValueOnce(new ProjectIdentityError('STORAGE_FAILED','test'));await expect(f.application.state({subject:subject(),projectId:'project'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('lists candidate metadata using only the authenticated mapped tenant/project and bounded filter',async()=>{
  const f=fixture();await f.application.listCandidates({subject:subject('viewer'),projectId:'project',runId:'run',limit:4});expect(f.intents.listCandidateHeaders).toHaveBeenCalledWith({scope:{tenantId:'tenant',projectId:'project'},target:key,subjectId:'user',runId:'run',limit:4});expect(f.versions.read).not.toHaveBeenCalled();expect(f.newId).not.toHaveBeenCalled();
  await expect(f.application.listCandidates({subject:subject(),projectId:'project',limit:51})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
it('keeps explicit schema upgrade separate from source preparation and adoption',async()=>{
  const f=memory();f.setState(createVersionState(makePackage()),1);const command={applicationId:'upgrade',expectedSnapshotRevision:5,expectedWriteVersion:1};
  const view=await f.application.prepareUpgrade({subject:subject('editor'),projectId:'project',command});expect(view.status).toBe('candidate');expect(f.candidates.get('upgrade')?.request?.ops[0]?.op).toBe('upgrade_schema');expect(f.versions.adoptGuarded).not.toHaveBeenCalled();
  expect((await f.application.prepareUpgrade({subject:subject('editor'),projectId:'project',command})).candidateId).toBe(view.candidateId);expect(f.newId).toHaveBeenCalledTimes(2);
  const intermediate=memory();const next=await intermediate.application.prepareUpgrade({subject:subject(),projectId:'project',command});expect(next.differences).toContainEqual({collection:'projects',id:key.projectId,kind:'replace',before:{schema_version:'0.6.0-draft'},after:{schema_version:'0.7.0-draft'}});
  const fresh=memory();fresh.setState(createVersionState(upgradeV06Package(fresh.getState().head)),1);await expect(fresh.application.prepareUpgrade({subject:subject(),projectId:'project',command})).rejects.toMatchObject({code:'CONFLICT'});
});
it('rechecks a preexisting manual intent before first adoption of protected outline changes',async()=>{const f=memory();const original=await f.application.submitCandidate({subject:subject('editor'),projectId:'project',command:f.command()});const saved=f.candidates.get('manual-command')!;const {digest:_digest,businessDigest:_business,createdAt:_created,...body}=saved;const request=ChangeSetV07.parse({...saved.request,schema_version:'0.7.0-draft',id:id('preexisting-outline'),ops:[{op_id:id('preexisting-outline-op'),op:'remove',collection:'adaptation_plans',target:id('outline-plan')}]});f.setState(createVersionState(upgradeV06Package(upgradeV05Package(makePackage()))),2);await f.intents.putCandidate({...body,applicationId:'preexisting-outline',changeId:request.id,request});await expect(f.application.adoptCandidate({subject:subject(),projectId:'project',candidateId:request.id,requestId:'protected-manual-adopt',command:{scope:{kind:'project',id:key.projectId},expectedSnapshotRevision:5,expectedWriteVersion:2}})).rejects.toMatchObject({code:'SOURCE_POLICY_MISSING'});expect(f.versions.adoptGuarded).not.toHaveBeenCalled();expect(original.status).toBe('candidate');});
it('refuses a schema upgrade while any old native candidate remains pending',async()=>{
  const f=memory();const legacy=createVersionState(makePackage());f.setState(submitChangeSet(legacy,changeSet([{op:'update',op_id:id('legacy-pending'),collection:'shots',target:id('sh_1'),set:{action:'pending'}}],{base_revisions:[{id:id('sh_1'),version:1}]})).state,2);
  await expect(f.application.prepareUpgrade({subject:subject(),projectId:'project',command:{applicationId:'upgrade',expectedSnapshotRevision:5,expectedWriteVersion:2}})).rejects.toMatchObject({code:'CONFLICT'});expect(f.intents.putCandidate).not.toHaveBeenCalled();
});
it('captures command accessors and oversized bodies without evaluating getters or allocating identities',async()=>{
  const f=fixture();const getter=vi.fn();await expect(f.application.previewChange({subject:subject(),projectId:'project',command:{get change(){return getter();},expectedSnapshotRevision:5}})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(getter).not.toHaveBeenCalled();
  await expect(f.application.prepareUpgrade({subject:subject(),projectId:'project',command:{value:'a'.repeat(550000)}})).rejects.toMatchObject({code:'INPUT_LIMIT'});expect(f.newId).not.toHaveBeenCalled();
});
it('refuses a manual provenance claim even when an earlier invalid operation prevents a preview',async()=>{
  const f=memory();const command=f.command();command.change.ops.unshift({op:'add',op_id:id('forged-source-op'),collection:'development_plans',value:{id:id('forged-plan'),version:1,source:{reviewer_key:'forged'}}});
  await expect(f.application.submitCandidate({subject:subject(),projectId:'project',command})).rejects.toMatchObject({code:'SOURCE_POLICY_MISSING'});expect(f.intents.putCandidate).not.toHaveBeenCalled();
});
it('prepares complete reviewed development through durable identities and immutable command recovery',async()=>{
  const f=memory();const source=await mappingFixture();f.setState(createVersionState(source.head));f.development.identities.prepare.mockResolvedValue({identities:{...source.identities,tenantId:'tenant',projectId:'project',target:key},progress:source.progress});
  // Use the actual fixture ordinary scope; identity registration remains independent of source generation.
  const ordinary={tenantId:source.source.tenantId,projectId:source.source.projectId};const principal={...subject(),tenantId:ordinary.tenantId,grants:[{projectId:ordinary.projectId,role:'admin' as const}]};
  f.identities.resolve.mockResolvedValue({scope:ordinary,versionKey:key,principal:actor});f.identities.resolveProject.mockResolvedValue({...ordinary,versionKey:key});f.identities.resolvePrincipal.mockImplementation(async input=>({...input,principal:{kind:'user' as const,id:input.key==='user'?actor.id:id('mapping-'+input.key)}}));
  f.development.identities.prepare.mockResolvedValue({identities:{...source.identities,target:key},progress:source.progress});f.development.store.read.mockResolvedValue(source.progress);f.development.store.isCurrent.mockResolvedValue(true);
  const application=new ProjectApplication({...f.options,tenantId:ordinary.tenantId});
  const command={applicationId:'development',expectedSnapshotRevision:5,expectedWriteVersion:1,runDigest:source.source.runDigest,briefDigest:source.source.briefDigest,foundationReviewDigest:source.source.foundationReviewDigest,episodesReviewDigest:source.source.episodesReviewDigest};
  const view=await application.prepareDevelopment({subject:principal,projectId:ordinary.projectId,runId:source.source.runId,command});expect(view.source).toEqual({kind:'development',runId:source.source.runId,state:'current'});expect(view.differences.some(row=>row.collection==='development_plans')).toBe(true);expect(f.versions.adoptGuarded).not.toHaveBeenCalled();
  const allocations=f.newId.mock.calls.length;await application.prepareDevelopment({subject:principal,projectId:ordinary.projectId,runId:source.source.runId,command});expect(f.newId).toHaveBeenCalledTimes(allocations);expect(f.development.identities.prepare).toHaveBeenCalledTimes(1);
  f.development.store.isCurrent.mockResolvedValue(false);expect((await application.candidate({subject:principal,projectId:ordinary.projectId,candidateId:view.candidateId})).source).toMatchObject({state:'stale'});f.development.store.read.mockRejectedValue(new Error('offline'));expect((await application.candidate({subject:principal,projectId:ordinary.projectId,candidateId:view.candidateId})).source).toMatchObject({state:'unavailable'});
});
it('keeps candidate reads available to viewers and unmapped reviewers, but propagates a broken registry',async()=>{
  const f=memory();const view=await f.application.submitCandidate({subject:subject(),projectId:'project',command:f.command()});
  expect((await f.application.candidate({subject:subject('viewer'),projectId:'project',candidateId:view.candidateId})).canAdopt).toBe(false);
  f.identities.resolvePrincipal.mockRejectedValueOnce(new ProjectIdentityError('PRINCIPAL_BINDING_MISSING','test'));expect((await f.application.candidate({subject:subject(),projectId:'project',candidateId:view.candidateId})).canAdopt).toBe(false);
  f.identities.resolvePrincipal.mockRejectedValueOnce(new ProjectIdentityError('STORAGE_FAILED','test'));await expect(f.application.candidate({subject:subject(),projectId:'project',candidateId:view.candidateId})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  f.identities.resolvePrincipal.mockRejectedValueOnce(new Error('untrusted driver'));await expect(f.application.state({subject:subject(),projectId:'project'})).rejects.toThrow('untrusted driver');
  await f.application.listCandidates({subject:subject(),projectId:'project'});await f.application.listCandidates({subject:subject(),projectId:'project',cursor:'opaque'});
});
it.each(['actor-id','actor-key','tenant','project'] as const)('refuses changed stored candidate %s bindings before exact receipt recovery',async field=>{
  const f=memory();const command=f.command();const view=await f.application.submitCandidate({subject:subject(),projectId:'project',command});const saved=f.candidates.get(command.applicationId)!;
  if(field==='actor-id')saved.actor.id=id('other');if(field==='actor-key')saved.actor.key='another';if(field==='tenant')saved.target.tenantId=id('other-tenant');if(field==='project')saved.target.projectId=id('other-project');
  await expect(f.application.submitCandidate({subject:subject(),projectId:'project',command})).rejects.toMatchObject({code:'CONFLICT'});
  if(field==='tenant'||field==='project'){
    await expect(f.application.candidate({subject:subject(),projectId:'project',candidateId:view.candidateId})).rejects.toMatchObject({code:'STORAGE_FAILED'});
    await expect(f.application.adoptCandidate({subject:subject(),projectId:'project',candidateId:view.candidateId,requestId:'decision',command:{scope:view.scope,expectedSnapshotRevision:5,expectedWriteVersion:2}})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  }
});
it('does not accept a forged manual author, including a different principal kind',async()=>{
  const f=memory();for(const author of [{kind:'user' as const,id:id('someone')},{kind:'agent_run' as const,id:actor.id}]){
    const command=f.command();command.change.author=author;await expect(f.application.submitCandidate({subject:subject(),projectId:'project',command})).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(f.application.previewChange({subject:subject(),projectId:'project',command:{change:command.change,expectedSnapshotRevision:5}})).rejects.toMatchObject({code:'FORBIDDEN'});
  }expect(f.intents.putCandidate).not.toHaveBeenCalled();
});
it('refuses damaged unchanged receipts and prevents review of an unchanged intent',async()=>{
  const f=memory();const view=await f.application.submitCandidate({subject:subject(),projectId:'project',command:f.command()});const saved=f.candidates.get('manual-command')!;saved.request=null;f.preparations.clear();
  await expect(f.application.submitCandidate({subject:subject(),projectId:'project',command:f.command()})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  await expect(f.application.adoptCandidate({subject:subject(),projectId:'project',candidateId:view.candidateId,requestId:'noop',command:{scope:view.scope,expectedSnapshotRevision:5,expectedWriteVersion:2}})).rejects.toMatchObject({code:'CONFLICT'});
});
it('reports a missing committed decision receipt instead of fabricating success',async()=>{
  const f=memory();const view=await f.application.submitCandidate({subject:subject(),projectId:'project',command:f.command()});f.intents.decisionReceiptWriter.mockReturnValue(async()=>{});
  await expect(f.application.rejectCandidate({subject:subject(),projectId:'project',candidateId:view.candidateId,requestId:'missing',command:{scope:view.scope,expectedSnapshotRevision:5,expectedWriteVersion:2,reason:'补充细节'}})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('captures a decision before an asynchronous identity lookup can yield to caller mutation',async()=>{
  const f=memory();const view=await f.application.submitCandidate({subject:subject(),projectId:'project',command:f.command()});let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  f.identities.resolve.mockImplementation(async()=>{await gate;return {scope:{tenantId:'tenant',projectId:'project'},versionKey:key,principal:actor};});
  const input={subject:subject(),projectId:'project',candidateId:view.candidateId,requestId:'original-decision',command:{scope:view.scope,expectedSnapshotRevision:5,expectedWriteVersion:2}};
  const operation=f.application.adoptCandidate(input);input.candidateId=id('mutated-change');input.requestId='mutated-decision';input.command.scope={kind:'project',id:id('mutated-project')};input.command.expectedWriteVersion=99;release();
  await expect(operation).resolves.toMatchObject({status:'adopted',changeId:view.candidateId});expect(f.decisions.get('original-decision')).toMatchObject({changeId:view.candidateId,expectation:{expectedWriteVersion:2},adoptionScope:view.scope});expect(f.decisions.has('mutated-decision')).toBe(false);
});
it('requires explicit upgrade and both reviewed source stages before allocating a formal development change',async()=>{
  const f=memory();const command={applicationId:'development',expectedSnapshotRevision:5,expectedWriteVersion:1,runDigest:'a'.repeat(64),briefDigest:'b'.repeat(64),foundationReviewDigest:'c'.repeat(64),episodesReviewDigest:'d'.repeat(64)};
  f.setState(createVersionState(makePackage()));await expect(f.application.prepareDevelopment({subject:subject(),projectId:'project',runId:'run',command})).rejects.toMatchObject({code:'SCHEMA_UPGRADE_REQUIRED'});
  const source=await mappingFixture();f.setState(createVersionState(source.head));
  for(const stage of ['foundation','episodes'] as const){const progress={...source.progress,[stage]:{...source.progress[stage],review:null}};f.development.identities.prepare.mockResolvedValue({identities:source.identities,progress});await expect(f.application.prepareDevelopment({subject:subject(),projectId:'project',runId:'run',command})).rejects.toMatchObject({code:'CONFLICT'});}
  expect(f.newId).not.toHaveBeenCalled();expect(f.intents.putCandidate).not.toHaveBeenCalled();
});
it.each(['replace-missing','replace-source','update-source','update-fields','remove'] as const)('guards manual plan operations %s without depending on a successful preview',async mode=>{
  const f=memory();const source=await mappingFixture();const draft=(await import('@camery/script/node')).prepareDevelopmentDraft({...source,head:source.head});const request=(await import('@camery/script/node')).finalizeDevelopmentChangeSet({draft,changeSetId:id('policy-source'),author:actor,operationIds:draft.operations.map((row,index)=>({slot:row.slot,id:id('policy-op-'+index)}))});
  const submitted=submitChangeSet(createVersionState(source.head),request);f.setState(adoptChangeSet(submitted.state,request.id,{actor,scope:{kind:'project',id:key.projectId},at:'2026-11-17T07:00:00.000Z',authorize:()=>true}).state);
  const head=f.getState().head;if(head.schema_version!=='0.6.0-draft')throw new Error('Expected formal source');const plan=head.development_plans[0]!;
  const op=mode==='remove'?{op:'remove',op_id:id('plan-op'),collection:'development_plans',target:plan.id}:mode.startsWith('replace')?{op:'replace',op_id:id('plan-op'),collection:'development_plans',target:mode==='replace-missing'?id('missing'):plan.id,value:{...plan,source:{...plan.source,reviewer_key:'forged'}}}:{op:'update',op_id:id('plan-op'),collection:'development_plans',target:plan.id,set:mode==='update-source'?{source:{...plan.source,reviewer_key:'forged'}}:{title:'人工修改标题'}};
  const change=ChangeSetV06.parse({schema_version:'0.6.0-draft',id:id('plan-edit'),author:actor,status:'candidate',base_revision:6,base_revisions:[{id:plan.id,version:1}],ops:[op]});
  const result=f.application.previewChange({subject:subject(),projectId:'project',command:{change,expectedSnapshotRevision:6}});
  if(mode==='remove'||mode==='update-fields')await expect(result).resolves.toHaveProperty('contractVersion',1);else await expect(result).rejects.toMatchObject({code:'SOURCE_POLICY_MISSING'});
});
