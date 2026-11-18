import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AccessError} from '@camery/access';
import type {Role,SessionIdentity,SessionStore} from '@camery/access';
import {OutlineError} from '@camery/script/outline/contracts';
import {VersionPersistenceError} from '@camery/versioning/node';
import {OutlineReceiptPageSchema} from '@camery/ir/outline-adoption';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {ProjectApplicationError} from '../src/projects/intent-contracts.js';
import type {OutlineAdoptionOptions} from '../src/projects/outline-adoption-options.js';
const methods=vi.hoisted(()=>({prepareOutline:vi.fn(),listCandidates:vi.fn(),candidate:vi.fn(),adoptCandidate:vi.fn(),rejectCandidate:vi.fn(),receiptMessages:vi.fn()}));
vi.mock('../src/projects/outline-adoption-application.js',()=>({OutlineAdoptionApplication:class {constructor(){return methods;}}}));
import {createApplication} from '../src/app.js';

const authorization=`Bearer cmry_${'b'.repeat(43)}`,headers={authorization},base='/api/v1/projects/project',candidateId=id('outline-http-candidate');
const prepareUrl=base+'/outline/run/candidates',catalogUrl=base+'/outline-adoption/candidates',candidateUrl=catalogUrl+'/'+candidateId;
const compare={expectedSnapshotRevision:5,expectedWriteVersion:7};
const preparation={...compare,applicationId:'outline-application',runDigest:'a'.repeat(64),briefDigest:'b'.repeat(64),candidateDigest:'c'.repeat(64),reviewDigest:'d'.repeat(64),sourceDigest:'e'.repeat(64)};
const acknowledgement={contractVersion:1,projectKey:'project',candidateId,kind:'preparation',requestId:preparation.applicationId,status:'candidate',snapshotRevision:5,writeVersion:8,issueCount:0,warningCount:131072,adoption:null,rejection:null};
const detail={contractVersion:1,projectKey:'project',candidateId,applicationId:preparation.applicationId,runId:'run',status:'candidate',snapshotRevision:5,writeVersion:8,baseRevision:5,operationCount:1249,sourceState:'current',canReview:true,preparation:acknowledgement};
const decision={...acknowledgement,kind:'decision',requestId:'decision',status:'adopted',warningCount:0,adoption:{change_set_id:candidateId,actor_id:id('outline-reviewer'),scope:{kind:'project',id:id('formal-project')},from_revision:5,to_revision:6,at:'2026-11-18T06:00:00.000Z'}};
const messages={contractVersion:1,projectKey:'project',candidateId,kind:'preparation',requestId:preparation.applicationId,section:'warnings',total:131072,items:[{code:'STALE_OUTLINE_DEPENDENCY',where:'/outline_beats/0',message:'核对原生版本给出的人物依赖。'}],nextCursor:'next-message-page'};
const catalog={contractVersion:1,items:[{candidateId,applicationId:preparation.applicationId,runId:'run',status:'candidate',authorId:id('outline-author'),createdAt:'2026-11-18T06:00:00.000Z',baseRevision:5,operationCount:1249}],nextCursor:null};
const apps:Awaited<ReturnType<typeof createApplication>>[]=[];
async function fixture(role:Role='admin',enabled=true){
  const subject:SessionIdentity={tenantId:'tenant',userId:'user',sessionId:'session',grants:[{projectId:'project',role}]};
  const store={lookup:vi.fn(async()=>subject as SessionIdentity|null),revoke:vi.fn(async()=>{})} satisfies SessionStore;
  const app=await createApplication({tenantId:'tenant',store,...(enabled?{outlineAdoption:{tenantId:'tenant'} as OutlineAdoptionOptions}:{})});apps.push(app);return {app,store,subject};
}
beforeEach(()=>{for(const method of Object.values(methods))method.mockReset();methods.prepareOutline.mockResolvedValue(detail);methods.candidate.mockResolvedValue(detail);methods.listCandidates.mockResolvedValue(catalog);methods.adoptCandidate.mockResolvedValue(decision);methods.rejectCandidate.mockResolvedValue({...decision,status:'rejected',adoption:null,rejection:{actor_id:id('outline-reviewer'),reason:'需要补充人物选择',at:'2026-11-18T06:00:00.000Z'}});methods.receiptMessages.mockResolvedValue(messages);});
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
const requests=()=>[
  {method:'POST' as const,url:prepareUrl,payload:preparation,headers:{...headers,'Idempotency-Key':preparation.applicationId}},
  {method:'GET' as const,url:catalogUrl,headers},
  {method:'GET' as const,url:candidateUrl,headers},
  {method:'POST' as const,url:candidateUrl+'/adopt',payload:compare,headers:{...headers,'Idempotency-Key':'decision'}},
  {method:'POST' as const,url:candidateUrl+'/reject',payload:{...compare,reason:'需要补充人物选择'},headers:{...headers,'Idempotency-Key':'decision'}},
  {method:'GET' as const,url:candidateUrl+'/receipts?kind=preparation&requestId='+preparation.applicationId+'&section=warnings',headers},
];

it('dispatches all six small authenticated routes and emits the bounded public envelopes',async()=>{
  const f=await fixture();for(const request of requests()){const response=await f.app.inject(request);expect(response.statusCode,response.body).toBe(request.method==='POST'?201:200);expect(response.json()).toEqual({data:expect.any(Object),requestId:expect.any(String)});expect(response.headers['cache-control']).toBe('no-store');}
  expect(methods.prepareOutline).toHaveBeenCalledWith({subject:f.subject,projectId:'project',runId:'run',command:preparation});
  expect(methods.listCandidates).toHaveBeenCalledWith({subject:f.subject,projectId:'project',command:{}});
  expect(methods.candidate).toHaveBeenCalledWith({subject:f.subject,projectId:'project',candidateId});
  expect(methods.adoptCandidate).toHaveBeenCalledWith({subject:f.subject,projectId:'project',candidateId,requestId:'decision',command:compare});
  expect(methods.rejectCandidate).toHaveBeenCalledWith({subject:f.subject,projectId:'project',candidateId,requestId:'decision',command:{...compare,reason:'需要补充人物选择'}});
  expect(methods.receiptMessages).toHaveBeenCalledWith({subject:f.subject,projectId:'project',candidateId,command:{kind:'preparation',requestId:preparation.applicationId,section:'warnings'}});
});
it('keeps every unconfigured route absent without instantiating an actionable transport',async()=>{
  const f=await fixture('admin',false);for(const request of requests())expect((await f.app.inject(request)).statusCode).toBe(404);for(const method of Object.values(methods))expect(method).not.toHaveBeenCalled();
});
it('authenticates every route before application dispatch and rechecks session revocation',async()=>{
  const f=await fixture();for(const request of requests())expect((await f.app.inject({...request,headers:{}})).statusCode).toBe(401);for(const method of Object.values(methods))expect(method).not.toHaveBeenCalled();
  expect((await f.app.inject({url:candidateUrl,headers})).statusCode).toBe(200);methods.candidate.mockClear();f.store.lookup.mockResolvedValue(null);
  const revoked=await f.app.inject({url:candidateUrl,headers});expect(revoked.statusCode).toBe(401);expect(revoked.headers['www-authenticate']).toBe('Bearer');expect(methods.candidate).not.toHaveBeenCalled();
});
it('isolates every route from another project before querying the application',async()=>{
  const f=await fixture();for(const request of requests())expect((await f.app.inject({...request,url:request.url.replace('/projects/project/','/projects/other/')})).statusCode).toBe(403);for(const method of Object.values(methods))expect(method).not.toHaveBeenCalled();
});
it.each(['viewer','editor'] as const)('refuses %s decisions before any review action dispatch',async role=>{
  const f=await fixture(role);for(const action of ['adopt','reject'])expect((await f.app.inject({method:'POST',url:candidateUrl+'/'+action,headers:{...headers,'Idempotency-Key':'decision'},payload:{...compare,...(action==='reject'?{reason:'需要修订'}:{})}})).statusCode).toBe(403);expect(methods.adoptCandidate).not.toHaveBeenCalled();expect(methods.rejectCandidate).not.toHaveBeenCalled();
});
it('allows viewer reads while requiring candidate-write permission for preparations',async()=>{
  const f=await fixture('viewer');for(const request of requests().filter(request=>request.method==='GET'))expect((await f.app.inject(request)).statusCode).toBe(200);
  expect((await f.app.inject(requests()[0]!)).statusCode).toBe(403);expect(methods.prepareOutline).not.toHaveBeenCalled();
});
it('requires one matching preparation key and one safe decision key at the wire boundary',async()=>{
  const f=await fixture();
  for(const extra of [{},{'Idempotency-Key':'different'},{'Idempotency-Key':[preparation.applicationId,preparation.applicationId]},{'Idempotency-Key':'one,two'},{'Idempotency-Key':'bad/key'},{'Idempotency-Key':'a'.repeat(129)}])expect((await f.app.inject({method:'POST',url:prepareUrl,headers:{...headers,...extra},payload:preparation})).statusCode).toBe(400);
  for(const action of ['adopt','reject'])for(const extra of [{},{'Idempotency-Key':['decision','decision']},{'Idempotency-Key':'one,two'},{'Idempotency-Key':'bad key'}])expect((await f.app.inject({method:'POST',url:candidateUrl+'/'+action,headers:{...headers,...extra},payload:{...compare,...(action==='reject'?{reason:'需要修订'}:{})}})).statusCode).toBe(400);
  expect(methods.prepareOutline).not.toHaveBeenCalled();expect(methods.adoptCandidate).not.toHaveBeenCalled();expect(methods.rejectCandidate).not.toHaveBeenCalled();
});
it('rejects duplicate authorization credentials before applying a business idempotency key',async()=>{
  const f=await fixture(),duplicateHeaders:Record<string,string|string[]>={authorization:[authorization,authorization],'Idempotency-Key':preparation.applicationId};const response=await f.app.inject({method:'POST',url:prepareUrl,headers:duplicateHeaders,payload:preparation});expect(response.statusCode).toBe(401);expect(methods.prepareOutline).not.toHaveBeenCalled();
});
it.each(['draft','source','actor','target','request','model','tenantId','projectId'])('rejects a caller-supplied %s during prepare and decisions',async field=>{
  const f=await fixture();expect((await f.app.inject({method:'POST',url:prepareUrl,headers:{...headers,'Idempotency-Key':preparation.applicationId},payload:{...preparation,[field]:{text:'untrusted authority'}}})).statusCode).toBe(400);
  for(const action of ['adopt','reject'])expect((await f.app.inject({method:'POST',url:candidateUrl+'/'+action,headers:{...headers,'Idempotency-Key':'decision'},payload:{...compare,...(action==='reject'?{reason:'需要修订'}:{}),[field]:{text:'untrusted authority'}}})).statusCode).toBe(400);
  expect(methods.prepareOutline).not.toHaveBeenCalled();expect(methods.adoptCandidate).not.toHaveBeenCalled();expect(methods.rejectCandidate).not.toHaveBeenCalled();
});
it('requires all five exact source digests and complete safe CAS values before preparing',async()=>{
  const f=await fixture();for(const field of ['runDigest','briefDigest','candidateDigest','reviewDigest','sourceDigest'])for(const value of [undefined,'A'.repeat(64),'a'.repeat(63),'a'.repeat(64)+'\n']){const payload:Record<string,unknown>={...preparation};if(value===undefined)delete payload[field];else payload[field]=value;expect((await f.app.inject({method:'POST',url:prepareUrl,headers:{...headers,'Idempotency-Key':preparation.applicationId},payload})).statusCode).toBe(400);}
  for(const field of ['expectedSnapshotRevision','expectedWriteVersion'])for(const value of [undefined,0,1.5,Number.MAX_SAFE_INTEGER+1,'5']){const payload:Record<string,unknown>={...preparation};if(value===undefined)delete payload[field];else payload[field]=value;expect((await f.app.inject({method:'POST',url:prepareUrl,headers:{...headers,'Idempotency-Key':preparation.applicationId},payload})).statusCode).toBe(400);}
  expect(methods.prepareOutline).not.toHaveBeenCalled();
});
it('requires a deliberate rejection reason and parses canonical candidate and run addresses',async()=>{
  const f=await fixture();for(const reason of ['','   ','\0','\ud800','x'.repeat(501)])expect((await f.app.inject({method:'POST',url:candidateUrl+'/reject',headers:{...headers,'Idempotency-Key':'decision'},payload:{...compare,reason}})).statusCode).toBe(400);
  expect((await f.app.inject({url:catalogUrl+'/invalid',headers})).statusCode).toBe(400);
  expect((await f.app.inject({method:'POST',url:catalogUrl+'/invalid/adopt',headers:{...headers,'Idempotency-Key':'decision'},payload:compare})).statusCode).toBe(400);
  expect((await f.app.inject({method:'POST',url:prepareUrl.replace('/run/','/run%0A/'),headers:{...headers,'Idempotency-Key':preparation.applicationId},payload:preparation})).statusCode).toBe(400);
  expect(methods.candidate).not.toHaveBeenCalled();expect(methods.adoptCandidate).not.toHaveBeenCalled();expect(methods.rejectCandidate).not.toHaveBeenCalled();expect(methods.prepareOutline).not.toHaveBeenCalled();
});
it('binds parsed catalog and receipt page selectors to the authenticated project and candidate',async()=>{
  const f=await fixture('viewer');const list=await f.app.inject({url:catalogUrl+'?runId=run&limit=50&cursor=catalog-cursor',headers});expect(list.statusCode,list.body).toBe(200);expect(methods.listCandidates).toHaveBeenCalledWith({subject:f.subject,projectId:'project',command:{runId:'run',limit:50,cursor:'catalog-cursor'}});
  const response=await f.app.inject({url:candidateUrl+'/receipts?kind=decision&requestId=decision&section=issues&limit=1&cursor=message-cursor',headers});expect(response.statusCode,response.body).toBe(200);expect(methods.receiptMessages).toHaveBeenCalledWith({subject:f.subject,projectId:'project',candidateId,command:{kind:'decision',requestId:'decision',section:'issues',limit:1,cursor:'message-cursor'}});
});
it('rejects ambiguous or forged read selectors instead of allowing another actor or arbitrary message offset',async()=>{
  const f=await fixture('viewer');for(const suffix of ['?actorId=other','?tenantId=other','?limit=51','?limit=01','?limit=true','?limit=1&limit=2','?runId=run&runId=other','?cursor=a&cursor=b'])expect((await f.app.inject({url:catalogUrl+suffix,headers})).statusCode).toBe(400);
  const valid='?kind=preparation&requestId=outline-application&section=warnings';for(const suffix of ['&actorId=other','&offset=50','&kind=decision','&requestId=other','&section=issues','&limit=1&limit=2','&limit=0','&limit=01','&cursor=a&cursor=b'])expect((await f.app.inject({url:candidateUrl+'/receipts'+valid+suffix,headers})).statusCode).toBe(400);
  expect((await f.app.inject({url:candidateUrl+'?actorId=other',headers})).statusCode).toBe(400);expect((await f.app.inject({url:candidateUrl+'/receipts',headers})).statusCode).toBe(400);
  expect(methods.listCandidates).not.toHaveBeenCalled();expect(methods.receiptMessages).not.toHaveBeenCalled();expect(methods.candidate).not.toHaveBeenCalled();
});
it('keeps the global 16KiB body ceiling on every new POST route',async()=>{
  const f=await fixture();for(const [url,payload,key] of [[prepareUrl,{...preparation,sourceBody:'x'.repeat(16384)},preparation.applicationId],[candidateUrl+'/adopt',{...compare,padding:'x'.repeat(16384)},'decision'],[candidateUrl+'/reject',{...compare,reason:'x'.repeat(16384)},'decision']] as const){const response=await f.app.inject({method:'POST',url,headers:{...headers,'Idempotency-Key':key},payload});expect(response.statusCode,response.body).toBe(413);}
  expect(methods.prepareOutline).not.toHaveBeenCalled();expect(methods.adoptCandidate).not.toHaveBeenCalled();expect(methods.rejectCandidate).not.toHaveBeenCalled();
});
it('rejects malformed host candidates and receipt evidence without exposing private response data',async()=>{
  const f=await fixture();for(const value of [{...detail,secret:'private-credential'},{...detail,candidateId:'invalid'},{...detail,preparation:{...acknowledgement,changeId:candidateId}},{...detail,preparation:{...acknowledgement,candidateId:id('foreign-candidate')}},{...detail,preparation:{...acknowledgement,projectKey:'other-project'}}]){methods.candidate.mockResolvedValue(value);const response=await f.app.inject({url:candidateUrl,headers});expect(response.statusCode,response.body).toBe(503);expect(response.json()).toEqual({code:'STORAGE_FAILED',requestId:expect.any(String)});expect(response.body).not.toContain('private');}
  for(const value of [{...decision,password:'private-credential'},{...decision,changeId:candidateId},{...decision,issueCount:131073},{...decision,adoption:{...decision.adoption,change_set_id:id('foreign-candidate')}}]){methods.adoptCandidate.mockResolvedValue(value);const response=await f.app.inject({method:'POST',url:candidateUrl+'/adopt',headers:{...headers,'Idempotency-Key':'decision'},payload:compare});expect(response.statusCode,response.body).toBe(503);expect(response.json()).toEqual({code:'STORAGE_FAILED',requestId:expect.any(String)});expect(response.body).not.toContain('private');}
});
it('rejects overlarge catalog and message responses and enforces the exact public byte budget',async()=>{
  const f=await fixture('viewer');methods.listCandidates.mockResolvedValue({...catalog,items:Array.from({length:51},()=>catalog.items[0])});expect((await f.app.inject({url:catalogUrl,headers})).statusCode).toBe(503);
  const url=candidateUrl+'/receipts?kind=preparation&requestId=outline-application&section=warnings';methods.receiptMessages.mockResolvedValue({...messages,items:Array.from({length:51},()=>messages.items[0])});expect((await f.app.inject({url,headers})).statusCode).toBe(503);
  const oversized={...messages,items:Array.from({length:50},()=>({code:'NATIVE_WARNING',where:'\u0001'.repeat(2048),message:'\u0001'.repeat(4096)}))};expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(983040);methods.receiptMessages.mockResolvedValue(oversized);const response=await f.app.inject({url,headers});expect(response.statusCode,response.body).toBe(503);expect(response.json()).toEqual({code:'STORAGE_FAILED',requestId:expect.any(String)});
});
it('keeps the complete acknowledgement envelope within the public byte budget at its exact data boundary',async()=>{
  const f=await fixture('viewer'),targetBytes=983020;
  const nearLimit={...messages,nextCursor:'x',items:Array.from({length:27},()=>({code:'PRIVATE_NATIVE_WARNING',where:'\u0001'.repeat(2048),message:'\u0001'.repeat(4096)}))};
  const initialBytes=Buffer.byteLength(JSON.stringify(nearLimit)),last=nearLimit.items.at(-1)!;
  expect(initialBytes).toBeGreaterThan(targetBytes);last.message=last.message.slice(Math.ceil((initialBytes-targetBytes)/6));
  nearLimit.nextCursor+='x'.repeat(targetBytes-Buffer.byteLength(JSON.stringify(nearLimit)));
  expect(Buffer.byteLength(JSON.stringify(nearLimit))).toBe(targetBytes);expect(OutlineReceiptPageSchema.safeParse(nearLimit).success).toBe(true);
  methods.receiptMessages.mockResolvedValue(nearLimit);
  const response=await f.app.inject({url:candidateUrl+'/receipts?kind=preparation&requestId=outline-application&section=warnings',headers});
  expect(response.statusCode,JSON.stringify({dataBytes:targetBytes,wireBytes:Buffer.byteLength(response.body)})).toBe(503);
  expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(983040);expect(response.json()).toEqual({code:'STORAGE_FAILED',requestId:expect.any(String)});expect(response.body).not.toContain('PRIVATE_NATIVE_WARNING');
});
it('refuses a trusted outline-adoption runtime bound to a different deployment tenant before startup',async()=>{
  await expect(createApplication({tenantId:'tenant',store:{lookup:async()=>null,revoke:async()=>{}},outlineAdoption:{tenantId:'other'} as OutlineAdoptionOptions})).rejects.toThrow('Outline adoption tenant mismatch');
});
it.each([
  {error:new OutlineError('INVALID_REFERENCE','private source path','private'),status:422,code:'INVALID_REFERENCE'},
  {error:new OutlineError('CONFLICT','private source path','private'),status:409,code:'CONFLICT'},
  {error:new OutlineError('FORBIDDEN','private source path','private'),status:403,code:'FORBIDDEN'},
  {error:new ProjectApplicationError('SCHEMA_UPGRADE_REQUIRED','private'),status:409,code:'SCHEMA_UPGRADE_REQUIRED'},
  {error:new VersionPersistenceError('ADOPTION_SOURCE_CHANGED','private','private'),status:409,code:'CONFLICT'},
  {error:new VersionPersistenceError('OUTLINE_SOURCE_UNAVAILABLE','private','private'),status:503,code:'STORAGE_FAILED'},
  {error:new VersionPersistenceError('PROJECT_NOT_FOUND','private','private'),status:404,code:'NOT_FOUND'},
  {error:new AccessError('FORBIDDEN'),status:403,code:'FORBIDDEN'},
  {error:new AccessError('UNAUTHENTICATED'),status:401,code:'UNAUTHENTICATED'},
])('maps known domain and authority failures to safe transport codes: $code/$status',async({error,status,code})=>{
  const f=await fixture();methods.adoptCandidate.mockRejectedValue(error);const response=await f.app.inject({method:'POST',url:candidateUrl+'/adopt',headers:{...headers,'Idempotency-Key':'decision'},payload:compare});expect(response.statusCode,response.body).toBe(status);expect(response.json()).toEqual({code,requestId:expect.any(String)});expect(response.body).not.toContain('private');
});
