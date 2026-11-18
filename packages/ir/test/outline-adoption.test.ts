import {expect,it} from 'vitest';
import {fixtureId as id,changeSet} from './fixtures';
import {WorkbenchActionReceiptSchema,WorkbenchSubmitSchema} from '../src/workbench';
import {OutlinePrepareCommandSchema,OutlineAdoptCommandSchema,OutlineRejectCommandSchema,OutlineReceiptSchema,OutlineReceiptQuerySchema,OutlineReceiptPageSchema,OutlineCandidateSchema,OutlineCandidateListQuerySchema,OutlineCandidateHeaderSchema,OutlineCandidatePageSchema} from '../src/outline-adoption';

const base={expectedSnapshotRevision:5,expectedWriteVersion:7};
const prepare={...base,applicationId:'outline-application',runDigest:'a'.repeat(64),briefDigest:'b'.repeat(64),candidateDigest:'c'.repeat(64),reviewDigest:'d'.repeat(64),sourceDigest:'e'.repeat(64)};
const receipt={contractVersion:1,projectKey:'ordinary-project',candidateId:id('outline-candidate'),kind:'preparation',requestId:prepare.applicationId,status:'candidate',snapshotRevision:5,writeVersion:8,issueCount:131072,warningCount:131072,adoption:null,rejection:null};
const candidate={contractVersion:1,projectKey:receipt.projectKey,candidateId:receipt.candidateId,applicationId:prepare.applicationId,runId:'outline-run',status:'candidate',snapshotRevision:5,writeVersion:8,baseRevision:5,operationCount:4096,sourceState:'current',canReview:true,preparation:receipt};
const header={candidateId:candidate.candidateId,applicationId:candidate.applicationId,runId:candidate.runId,status:'prepared',authorId:id('outline-author'),createdAt:'2026-11-18T06:00:00.000Z',baseRevision:5,operationCount:1249};
const issue={code:'STALE_OUTLINE_DEPENDENCY',where:'/outline_beats/0',message:'核对过期的人物依赖。'};
const page={contractVersion:1,projectKey:receipt.projectKey,candidateId:receipt.candidateId,kind:'preparation',requestId:receipt.requestId,section:'warnings',total:131072,items:[issue],nextCursor:'opaque-cursor'};

it('accepts complete source pins and compare-and-swap bases without transporting a graph',()=>{
  expect(OutlinePrepareCommandSchema.parse(prepare)).toEqual(prepare);
  for(const field of ['applicationId','runDigest','briefDigest','candidateDigest','reviewDigest','sourceDigest','expectedSnapshotRevision','expectedWriteVersion']){
    const missing:Record<string,unknown>={...prepare};delete missing[field];expect(OutlinePrepareCommandSchema.safeParse(missing).success).toBe(false);
  }
});
it.each(['draft','request','target','actor','scope','model','body','tenantId'])('rejects caller-authored %s at command boundaries',field=>{
  expect(OutlinePrepareCommandSchema.safeParse({...prepare,[field]:{content:'untrusted'}}).success).toBe(false);
  expect(OutlineAdoptCommandSchema.safeParse({...base,[field]:'untrusted'}).success).toBe(false);
  expect(OutlineRejectCommandSchema.safeParse({...base,reason:'重新审阅人物选择',[field]:'untrusted'}).success).toBe(false);
});
it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1,Infinity,'5'])('refuses an unsafe command base %s',value=>{
  for(const field of ['expectedSnapshotRevision','expectedWriteVersion']){
    expect(OutlinePrepareCommandSchema.safeParse({...prepare,[field]:value}).success).toBe(false);
    expect(OutlineAdoptCommandSchema.safeParse({...base,[field]:value}).success).toBe(false);
  }
});
it.each(['',' ','bad\n','a'.repeat(129)])('rejects malformed ordinary identity %j',value=>{
  expect(OutlinePrepareCommandSchema.safeParse({...prepare,applicationId:value}).success).toBe(false);
  expect(OutlineCandidateSchema.safeParse({...candidate,runId:value}).success).toBe(false);
});
it.each(['f'.repeat(63),'F'.repeat(64),'f'.repeat(65),'f'.repeat(64)+'\n'])('rejects malformed source digest %j',value=>{
  for(const field of ['runDigest','briefDigest','candidateDigest','reviewDigest','sourceDigest'])expect(OutlinePrepareCommandSchema.safeParse({...prepare,[field]:value}).success).toBe(false);
});
it('keeps decisions narrow and requires a deliberate valid rejection reason',()=>{
  expect(OutlineAdoptCommandSchema.parse(base)).toEqual(base);
  expect(OutlineRejectCommandSchema.parse({...base,reason:'核对分集末尾卡点。'}).reason).toBe('核对分集末尾卡点。');
  for(const reason of ['','   ','\0','\ud800','x'.repeat(501)])expect(OutlineRejectCommandSchema.safeParse({...base,reason}).success).toBe(false);
  expect(OutlineRejectCommandSchema.safeParse(base).success).toBe(false);
});
it('reports complete private message counts through a compact acknowledgement',()=>{
  expect(OutlineReceiptSchema.parse(receipt)).toEqual(receipt);
  for(const status of ['candidate','adopted','rejected','conflicted','unchanged'])expect(OutlineReceiptSchema.parse({...receipt,status}).status).toBe(status);
  expect(OutlineReceiptSchema.safeParse({...receipt,status:'prepared'}).success).toBe(false);
  for(const extra of [{issues:[issue]},{warnings:[issue]},{draft:{}},{configuration:{}}])expect(OutlineReceiptSchema.safeParse({...receipt,...extra}).success).toBe(false);
  for(const field of ['issueCount','warningCount'])for(const value of [-1,1.5,131073,Infinity])expect(OutlineReceiptSchema.safeParse({...receipt,[field]:value}).success).toBe(false);
});
it('retains original native adoption and rejection audit shapes',()=>{
  const adoption={change_set_id:receipt.candidateId,actor_id:id('reviewer'),scope:{kind:'project',id:id('formal-project')},from_revision:5,to_revision:6,at:'2026-11-18T06:00:00.000Z'};
  expect(OutlineReceiptSchema.parse({...receipt,status:'adopted',adoption}).adoption).toEqual(adoption);
  const rejection={actor_id:id('reviewer'),reason:'重新核对卡点',at:'2026-11-18T06:00:00.000Z'};
  expect(OutlineReceiptSchema.parse({...receipt,status:'rejected',rejection}).rejection).toEqual(rejection);
  expect(OutlineReceiptSchema.safeParse({...receipt,adoption:{...adoption,change_set_id:id('foreign-candidate')}}).success).toBe(false);
});
it('distinguishes the current candidate head from its original preparation acknowledgement',()=>{
  const current={...candidate,status:'adopted',snapshotRevision:12,writeVersion:20};
  expect(OutlineCandidateSchema.parse(current).preparation).toEqual(receipt);
  expect(OutlineCandidateSchema.parse({...candidate,preparation:null,status:'prepared'}).preparation).toBeNull();
});
it.each(['projectKey','candidateId','requestId','kind'])('binds the embedded preparation %s to the candidate',field=>{
  const value=field==='candidateId'?id('other-candidate'):field==='kind'?'decision':'different';
  expect(OutlineCandidateSchema.safeParse({...candidate,preparation:{...receipt,[field]:value}}).success).toBe(false);
});
it('bounds formal operation metadata and canonical stable addresses',()=>{
  expect(OutlineCandidateHeaderSchema.parse(header)).toEqual(header);
  for(const value of [-1,4097,1.5]){
    expect(OutlineCandidateSchema.safeParse({...candidate,operationCount:value}).success).toBe(false);
    expect(OutlineCandidateHeaderSchema.safeParse({...header,operationCount:value}).success).toBe(false);
  }
  for(const value of ['bad',id('candidate')+'0',id('candidate').toLowerCase()])expect(OutlineCandidateSchema.safeParse({...candidate,candidateId:value}).success).toBe(false);
  expect(OutlineCandidateHeaderSchema.safeParse({...header,createdAt:'2026-11-18T06:00:00Z'}).success).toBe(false);
});
it('supports bounded metadata and message pagination with strict HTTP selectors',()=>{
  expect(OutlineCandidateListQuerySchema.parse({runId:'outline-run',limit:'50',cursor:'cursor'})).toEqual({runId:'outline-run',limit:50,cursor:'cursor'});
  expect(OutlineReceiptQuerySchema.parse({kind:'decision',requestId:'decision',section:'issues',limit:'1'})).toEqual({kind:'decision',requestId:'decision',section:'issues',limit:1});
  for(const extra of [{actor:'other-user'},{scope:'other-project'},{target:{projectId:id('foreign')}},{offset:50}])expect(OutlineReceiptQuerySchema.safeParse({kind:'preparation',requestId:'application',section:'warnings',...extra}).success).toBe(false);
  for(const value of [0,51,-1,1.5,'',true,null]){
    expect(OutlineCandidateListQuerySchema.safeParse({limit:value}).success).toBe(false);
    expect(OutlineReceiptQuerySchema.safeParse({kind:'preparation',requestId:'application',section:'warnings',limit:value}).success).toBe(false);
  }
  for(const cursor of ['','x'.repeat(4097)])expect(OutlineCandidateListQuerySchema.safeParse({cursor}).success).toBe(false);
});
it('pages complete native messages without widening legacy Workbench budgets',()=>{
  expect(OutlineReceiptPageSchema.parse(page)).toEqual(page);
  expect(OutlineReceiptPageSchema.parse({...page,items:Array.from({length:50},()=>issue),nextCursor:null}).items).toHaveLength(50);
  expect(OutlineReceiptPageSchema.safeParse({...page,items:Array.from({length:51},()=>issue)}).success).toBe(false);
  expect(OutlineReceiptPageSchema.safeParse({...page,total:131073}).success).toBe(false);
  expect(OutlineReceiptPageSchema.safeParse({...page,nextCursor:''}).success).toBe(false);
  expect(OutlineReceiptPageSchema.safeParse({...page,actorId:id('other')}).success).toBe(false);
  const legacy={version:1,changeId:receipt.candidateId,status:'candidate',snapshotRevision:5,writeVersion:7,issues:Array.from({length:501},()=>issue),warnings:[],adoption:null,rejection:null};
  expect(WorkbenchActionReceiptSchema.safeParse(legacy).success).toBe(false);
  const change=changeSet([{op:'update',op_id:id('op'),collection:'shots',target:id('sh_1'),set:{action:'候选'}}]);
  expect(WorkbenchSubmitSchema.safeParse({...base,applicationId:'legacy',change:{...change,ops:Array.from({length:501},()=>change.ops[0]!)}}).success).toBe(false);
});
it('keeps candidate catalogs bounded and free of full graph or source text',()=>{
  const catalog={contractVersion:1,items:[header],nextCursor:null};expect(OutlineCandidatePageSchema.parse(catalog)).toEqual(catalog);
  expect(OutlineCandidatePageSchema.safeParse({...catalog,items:Array.from({length:51},()=>header)}).success).toBe(false);
  expect(OutlineCandidatePageSchema.safeParse({...catalog,nextCursor:''}).success).toBe(false);
  for(const extra of [{source:{text:'private'}},{request:{}},{draft:{}}])expect(OutlineCandidateHeaderSchema.safeParse({...header,...extra}).success).toBe(false);
});
