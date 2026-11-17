import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Role,SessionIdentity,SessionStore} from '@camery/access';
import {fixtureId as id,changeSet} from '../../ir/test/fixtures.js';
import {ProjectApplicationError} from '../src/projects/intent-contracts.js';
import {ProjectIdentityError} from '../src/projects/contracts.js';
import {VersionPersistenceError} from '@camery/versioning/node';
import type {ProjectApplicationOptions} from '../src/projects/options.js';
const methods=vi.hoisted(()=>Object.fromEntries(['state','listCandidates','candidate','previewChange','submitCandidate','prepareUpgrade','prepareDevelopment','adoptCandidate','rejectCandidate','readSnapshot','readObjectHistory','readReadyAsset'].map(name=>[name,vi.fn()])));
vi.mock('../src/projects/application.js',()=>({ProjectApplication:class {constructor(){return methods;}}}));
import {createApplication} from '../src/app.js';
const headers={authorization:`Bearer cmry_${'b'.repeat(43)}`};const base='/api/v1/projects/project';const candidateId=id('http-change');
const apps:Awaited<ReturnType<typeof createApplication>>[]=[];
const state={contractVersion:1,projectKey:'project',projectId:id('prj_demo'),schemaVersion:'0.6.0-draft',snapshotRevision:5,writeVersion:2,actorId:id('user_1'),canWrite:true,canReview:true,nativePending:0,counts:[]};
const receipt={version:1,changeId:candidateId,status:'candidate',snapshotRevision:5,writeVersion:2,issues:[],warnings:[],adoption:null,rejection:null};
const detail={contractVersion:1,projectKey:'project',candidateId,applicationId:'application',managed:true,status:'candidate',authorId:id('user_1'),authorKey:'user',createdAt:'2026-11-17T07:00:00.000Z',baseRevision:5,source:{kind:'manual'},snapshotRevision:5,writeVersion:2,baseWriteVersion:1,scope:{kind:'project',id:id('prj_demo')},differences:[],issues:[],warnings:[],canAdopt:true,canReject:true,blockingReasons:[],preparation:receipt};
async function fixture(role:Role='admin',enabled=true){
  const subject:SessionIdentity={tenantId:'tenant',userId:'user',sessionId:'session',grants:[{projectId:'project',role}]};
  const store={lookup:vi.fn(async()=>subject as SessionIdentity|null),revoke:vi.fn(async()=>{})} satisfies SessionStore;
  const app=await createApplication({tenantId:'tenant',store,...(enabled?{projects:{tenantId:'tenant'} as ProjectApplicationOptions}:{})});apps.push(app);return {app,store,subject};
}
beforeEach(()=>{for(const method of Object.values(methods))method.mockReset();methods.state!.mockResolvedValue(state);methods.listCandidates!.mockResolvedValue({contractVersion:1,items:[],nextCursor:null});for(const name of ['candidate','submitCandidate','prepareUpgrade','prepareDevelopment'])methods[name]!.mockResolvedValue(detail);for(const name of ['adoptCandidate','rejectCandidate'])methods[name]!.mockResolvedValue(receipt);methods.previewChange!.mockResolvedValue({contractVersion:1,status:'candidate',snapshotRevision:5,writeVersion:2,differences:[],issues:[],warnings:[]});});
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
it('exposes strictly bounded authenticated snapshot and history reads with the shared envelopes',async()=>{
  const f=await fixture('viewer');const snapshot={contractVersion:1,projectKey:'project',projectId:state.projectId,schemaVersion:state.schemaVersion,snapshotRevision:5,writeVersion:2,scope:detail.scope,renditionId:null,nextCursor:null,counts:[],capabilities:{canWrite:false,canReview:false,canReadMedia:false},rows:[],relations:[],lineage:[],locks:[]};methods.readSnapshot!.mockResolvedValue(snapshot);
  const response=await f.app.inject({url:base+'/workbench?expectedRevision=5&limit=200',headers});expect(response.statusCode,response.body).toBe(200);expect(response.json().data).toEqual(snapshot);expect(methods.readSnapshot).toHaveBeenCalledWith({subject:f.subject,projectId:'project',command:{expectedRevision:5,limit:200}});
  for(const suffix of ['?tenantId=self','?limit=201','?collection=shot_lineage','?sceneId=foreign'])expect((await f.app.inject({url:base+'/workbench'+suffix,headers})).statusCode).toBe(400);
  const objectId=id('history-shot');const history={contractVersion:1,projectKey:'project',projectId:state.projectId,collection:'shots',objectId,snapshotRevision:5,writeVersion:2,nextCursor:null,items:[{ref:{collection:'shots',id:objectId,version:1},parentVersion:null,snapshotRevision:5,changeId:null,deleted:false,value:{id:objectId,version:1}}]};methods.readObjectHistory!.mockResolvedValue(history);
  const read=await f.app.inject({url:base+'/workbench/objects/shots/'+objectId+'/history?expectedRevision=5&limit=50',headers});expect(read.statusCode,read.body).toBe(200);expect(read.json().data).toEqual(history);expect(methods.readObjectHistory).toHaveBeenCalledWith({subject:f.subject,projectId:'project',collection:'shots',objectId,command:{expectedRevision:5,limit:50}});
  expect((await f.app.inject({url:base+'/workbench/objects/shots/'+objectId+'/history?limit=51',headers})).statusCode).toBe(400);expect((await f.app.inject({url:base+'/workbench',headers:{}})).statusCode).toBe(401);
});
it('returns explicit asset unavailability without a file URL or treating metadata as a media capability',async()=>{
  const f=await fixture('viewer');const assetId=id('asset');methods.readReadyAsset!.mockRejectedValue(new ProjectApplicationError('ASSET_NOT_READY','private file path unavailable'));
  const url=base+'/workbench/assets/'+assetId+'/versions/1?expectedRevision=5';const response=await f.app.inject({url,headers});expect(response.statusCode,response.body).toBe(409);expect(response.json()).toEqual({code:'ASSET_NOT_READY',requestId:expect.any(String)});expect(methods.readReadyAsset).toHaveBeenCalledWith({subject:f.subject,projectId:'project',assetId,version:1,command:{expectedRevision:5}});
  expect((await f.app.inject({url:url.replace('/1?','/zero?'),headers})).statusCode).toBe(400);methods.readReadyAsset!.mockResolvedValue({url:'file:///private'});expect((await f.app.inject({url,headers})).statusCode).toBe(503);
});
it('keeps disabled project routes absent and authenticates enabled reads before application access',async()=>{
  const off=await fixture('admin',false);expect((await off.app.inject({url:base+'/workbench/state',headers})).statusCode).toBe(404);
  const f=await fixture();expect((await f.app.inject({url:base+'/workbench/state'})).statusCode).toBe(401);expect(methods.state).not.toHaveBeenCalled();
  expect((await f.app.inject({url:base.replace('/project','/other')+'/workbench/state',headers})).statusCode).not.toBe(200);
  const response=await f.app.inject({url:base+'/workbench/state',headers});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({data:state,requestId:expect.any(String)});expect(response.headers['cache-control']).toBe('no-store');expect(methods.state).toHaveBeenCalledWith({subject:f.subject,projectId:'project'});
  f.store.lookup.mockResolvedValue(null);expect((await f.app.inject({url:base+'/workbench/state',headers})).statusCode).toBe(401);
});
it('strictly binds list query and rejects identity or unknown query fields',async()=>{
  const f=await fixture('viewer');expect((await f.app.inject({url:base+'/workbench/candidates?runId=run&limit=10&cursor=cursor',headers})).statusCode).toBe(200);expect(methods.listCandidates).toHaveBeenCalledWith({subject:f.subject,projectId:'project',runId:'run',limit:10,cursor:'cursor'});
  for(const suffix of ['?tenantId=other','?limit=51','?runId=one&runId=two'])expect((await f.app.inject({url:base+'/workbench/candidates'+suffix,headers})).statusCode).toBe(400);
  expect((await f.app.inject({url:base+'/workbench/candidates/'+candidateId,headers})).statusCode).toBe(200);expect(methods.candidate).toHaveBeenCalledWith({subject:f.subject,projectId:'project',candidateId});
});
it('requires one matching idempotency key for preparations and validates strict commands before writes',async()=>{
  const f=await fixture('editor');const body={applicationId:'application',expectedSnapshotRevision:5,expectedWriteVersion:1};const url=base+'/workbench/schema-upgrade';
  for(const extra of [{},{'Idempotency-Key':'different'},{'Idempotency-Key':['application','application']}])expect((await f.app.inject({method:'POST',url,headers:{...headers,...extra},payload:body})).statusCode).toBe(400);
  expect(methods.prepareUpgrade).not.toHaveBeenCalled();expect((await f.app.inject({method:'POST',url,headers:{...headers,'Idempotency-Key':'application'},payload:{...body,actor:'forged'}})).statusCode).toBe(400);
  const result=await f.app.inject({method:'POST',url,headers:{...headers,'Idempotency-Key':'application'},payload:body});expect(result.statusCode,result.body).toBe(201);expect(methods.prepareUpgrade).toHaveBeenCalledWith({subject:f.subject,projectId:'project',command:body});
  const development={...body,runDigest:'a'.repeat(64),briefDigest:'b'.repeat(64),foundationReviewDigest:'c'.repeat(64),episodesReviewDigest:'d'.repeat(64)};
  expect((await f.app.inject({method:'POST',url:base+'/development/run/candidates',headers:{...headers,'Idempotency-Key':'application'},payload:development})).statusCode).toBe(201);expect(methods.prepareDevelopment).toHaveBeenCalledWith({subject:f.subject,projectId:'project',runId:'run',command:development});
});
it.each(['viewer','editor'] as const)('denies %s review before decision application dispatch',async role=>{
  const f=await fixture(role);expect((await f.app.inject({method:'POST',url:base+'/workbench/candidates/'+candidateId+'/adopt',headers:{...headers,'Idempotency-Key':'decision'},payload:{scope:detail.scope,expectedSnapshotRevision:5,expectedWriteVersion:2}})).statusCode).toBe(403);expect(methods.adoptCandidate).not.toHaveBeenCalled();
});
it('dispatches reviewer decisions with request UUID and rejects forged or ambiguous authority',async()=>{
  const f=await fixture('reviewer');const body={scope:detail.scope,expectedSnapshotRevision:5,expectedWriteVersion:2};
  for(const action of ['adopt','reject'] as const){const command=action==='reject'?{...body,reason:'需要修订'}:body;const response=await f.app.inject({method:'POST',url:base+'/workbench/candidates/'+candidateId+'/'+action,headers:{...headers,'Idempotency-Key':'decision'},payload:command});expect(response.statusCode,response.body).toBe(201);expect(methods[action+'Candidate']).toHaveBeenCalledWith({subject:f.subject,projectId:'project',candidateId,requestId:'decision',command});}
  expect((await f.app.inject({method:'POST',url:base+'/workbench/candidates/'+candidateId+'/adopt',headers:{...headers,'Idempotency-Key':'decision'},payload:{...body,actorId:'victim'}})).statusCode).toBe(400);
});
it('permits a bounded manual preview without an idempotency key and keeps other routes at 16KiB',async()=>{
  const f=await fixture('editor');const change=changeSet([{op:'update',op_id:id('op'),collection:'shots',target:id('sh_1'),set:{action:'x'.repeat(20000)}}],{schema_version:'0.6.0-draft'});
  const command={change,expectedSnapshotRevision:5};const response=await f.app.inject({method:'POST',url:base+'/workbench/changes/preview',headers,payload:command});expect(response.statusCode,response.body).toBe(201);expect(methods.previewChange).toHaveBeenCalledWith({subject:f.subject,projectId:'project',command});
  expect((await f.app.inject({method:'POST',url:base+'/workbench/schema-upgrade',headers:{...headers,'Idempotency-Key':'application'},payload:{padding:'x'.repeat(20000)}})).statusCode).toBe(413);
  expect((await f.app.inject({method:'POST',url:base+'/workbench/changes/preview',headers,payload:{padding:'x'.repeat(540000)}})).statusCode).toBe(413);
});
it('submits a manual candidate with the exact captured command and rejects oversized or forged fields',async()=>{
  const f=await fixture('editor');const change=changeSet([{op:'update',op_id:id('op'),collection:'shots',target:id('sh_1'),set:{action:'x'.repeat(20000)}}],{schema_version:'0.6.0-draft'});const command={change,applicationId:'application',expectedSnapshotRevision:5,expectedWriteVersion:1};const url=base+'/workbench/candidates';
  expect((await f.app.inject({method:'POST',url,headers:{...headers,'Idempotency-Key':'application'},payload:command})).statusCode).toBe(201);expect(methods.submitCandidate).toHaveBeenCalledWith({subject:f.subject,projectId:'project',command});
  expect((await f.app.inject({method:'POST',url,headers:{...headers,'Idempotency-Key':'application'},payload:{...command,source:{kind:'manual'}}})).statusCode).toBe(400);
  expect((await f.app.inject({method:'POST',url,headers:{...headers,'Idempotency-Key':'application'},payload:{padding:'x'.repeat(540000)}})).statusCode).toBe(413);
});
it('rejects missing or combined decision keys and invalid identifiers without dispatching',async()=>{
  const f=await fixture('reviewer');const command={scope:detail.scope,expectedSnapshotRevision:5,expectedWriteVersion:2};const url=base+'/workbench/candidates/'+candidateId+'/adopt';
  for(const extra of [{},{'Idempotency-Key':'one,two'},{'Idempotency-Key':['one','two']}])expect((await f.app.inject({method:'POST',url,headers:{...headers,...extra},payload:command})).statusCode).toBe(400);
  expect((await f.app.inject({method:'POST',url:url.replace(candidateId,'invalid'),headers:{...headers,'Idempotency-Key':'decision'},payload:command})).statusCode).toBe(400);expect(methods.adoptCandidate).not.toHaveBeenCalled();
  expect((await f.app.inject({url:base+'/workbench/state?tenantId=forged',headers})).statusCode).toBe(400);
  expect((await f.app.inject({url:base+'/workbench/candidates/'+candidateId+'?actorId=forged',headers})).statusCode).toBe(400);
});
it('fails safely when a host projection is malformed or larger than the response boundary',async()=>{
  const f=await fixture();methods.state!.mockResolvedValue({...state,password:'postgresql://secret'});const malformed=await f.app.inject({url:base+'/workbench/state',headers});expect(malformed.statusCode).toBe(503);expect(malformed.body).not.toContain('secret');
  methods.candidate!.mockResolvedValue({...detail,differences:[{collection:'shots',id:id('sh_1'),kind:'replace',before:null,after:{text:'x'.repeat(1048576)}}]});expect((await f.app.inject({url:base+'/workbench/candidates/'+candidateId,headers})).statusCode).toBe(503);
});
it('refuses a trusted project runtime bound to another deployment tenant before starting',async()=>{
  await expect(createApplication({tenantId:'tenant',store:{lookup:async()=>null,revoke:async()=>{}},projects:{tenantId:'other'} as ProjectApplicationOptions})).rejects.toThrow('Project tenant mismatch');
});
it.each([
  [new ProjectIdentityError('PROJECT_BINDING_MISSING','postgresql://secret'),409,'PROJECT_BINDING_MISSING'],
  [new ProjectIdentityError('PRINCIPAL_BINDING_MISSING','postgresql://secret'),403,'PRINCIPAL_BINDING_MISSING'],
  [new ProjectApplicationError('SOURCE_POLICY_MISSING','postgresql://secret'),409,'SOURCE_POLICY_MISSING'],
  [new VersionPersistenceError('SNAPSHOT_STALE','postgresql://secret','project'),409,'SNAPSHOT_STALE'],
  [new VersionPersistenceError('UNEXPECTED','postgresql://secret','project'),503,'STORAGE_FAILED'],
])('redacts project application failures %#',async(error,status,code)=>{
  const f=await fixture();methods.state!.mockRejectedValue(error);const response=await f.app.inject({url:base+'/workbench/state',headers});expect(response.statusCode).toBe(status);expect(response.json()).toEqual({code,requestId:expect.any(String)});expect(response.body).not.toContain('secret');
});
