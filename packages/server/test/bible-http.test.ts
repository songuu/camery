import { afterEach,describe,expect,it,vi } from 'vitest';
import type { SessionIdentity,SessionStore,Role } from '@camery/access';
import { BibleError,captureSource,confirmBible,rejectBibleCandidate } from '@camery/bible';
import { bibleRunDigest,projectBibleRun } from '@camery/bible/node';
import type { BibleProgress,BibleStore } from '@camery/bible/node';
import type { Task } from '@camery/durable';
import { reviewFixture } from '../../bible/test/review-support.js';
import { createApplication } from '../src/app.js';
const token=`cmry_${'b'.repeat(43)}`;const headers={authorization:`Bearer ${token}`};const base='/api/v1/projects/project/bibles';
const apps:Awaited<ReturnType<typeof createApplication>>[]=[];
async function fixture(role:Role='admin',ready=true){
  const f=reviewFixture();const execution={connectionId:'fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture-model',evidence:'synthetic_replay' as const,modelTier:'economy' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:100,tokens:10000,costMicros:0}};
  const run={tenantId:'tenant',projectId:'project',runId:'run',source:captureSource(f.source),plan:f.plan,method:f.candidate.method,execution,digest:bibleRunDigest(f.plan,f.candidate.method,execution),createdAt:f.host.at};
  const progress:BibleProgress={run,records:ready?f.candidate.records:[],candidate:ready?f.candidate:null,review:null};
  const store={start:vi.fn(async()=>run),read:vi.fn(async()=>progress),isCurrent:vi.fn(async()=>true),saveChunk:vi.fn(async(_key,record)=>record),materialize:vi.fn(async()=>f.candidate),
    confirm:vi.fn(async(_key,decision,host)=>{const review=confirmBible(f.source,f.candidate,decision,host);Object.assign(progress,{review});return review;}),
    reject:vi.fn(async(_key,reason,host)=>{const review=rejectBibleCandidate(f.source,f.candidate,reason,host);Object.assign(progress,{review});return review;})} satisfies BibleStore;
  const summary=()=>{const detail=projectBibleRun(progress,true,null);const {runId,createdAt,source,completedChunks,totalChunks,candidateDigest,reviewStatus,sourceChanged}=detail;return {runId,createdAt,source,completedChunks,totalChunks,candidateDigest,reviewStatus,sourceChanged};};
  const catalog={list:vi.fn(async()=>({items:[summary()],nextCursor:null})),summary:vi.fn(async()=>({summary:summary(),nextChunkId:ready?null:run.plan.chunks[0]!.id}))};
  const tasks={get:vi.fn(async()=>null as Task|null),enqueue:vi.fn(async(input)=>({...input,status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null} as Task))};
  const sessions={lookup:vi.fn(async()=>({tenantId:'tenant',userId:'human',sessionId:'s',grants:[{projectId:'project',role}]} as SessionIdentity|null)),revoke:vi.fn(async()=>{})} satisfies SessionStore;
  const presetFor=vi.fn(()=>({method:run.method,execution,label:'测试文本模型'}));
  const app=await createApplication({tenantId:'tenant',store:sessions,bibles:{store,catalog,tasks,presetFor,now:()=>f.host.at}});apps.push(app);
  return {app,store,catalog,tasks,sessions,presetFor,progress,f};
}
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
describe('authenticated Bible API',()=>{
  it('fails closed before reading any model or candidate data and observes session revocation',async()=>{
    const {app,catalog,sessions}=await fixture();
    expect((await app.inject({url:base})).statusCode).toBe(401);expect(catalog.list).not.toHaveBeenCalled();
    expect((await app.inject({url:base.replace('/project/','/other/'),headers})).statusCode).toBe(403);
    expect((await app.inject({url:base+'?tenantId=other',headers})).statusCode).toBe(400);
    expect((await app.inject({url:base,headers})).json().items).toHaveLength(1);
    sessions.lookup.mockResolvedValue(null);expect((await app.inject({url:base,headers})).statusCode).toBe(401);
  });
  it('returns only public candidate fields and the immutable source window',async()=>{
    const {app,f,store,catalog}=await fixture('viewer');
    const detail=await app.inject({url:base+'/run',headers});expect(detail.statusCode).toBe(200);expect(detail.headers['cache-control']).toBe('no-store');
    const data=detail.json();expect(data.candidate.entities[0].evidence[0].quote).toBeTruthy();expect(data).not.toHaveProperty('execution');expect(data.candidate).not.toHaveProperty('records');expect(data.source).not.toHaveProperty('tenantId');
    expect((await app.inject({url:base+'/run/source?offset=0',headers})).json().excerpt.text).toBe(f.source.document.text);
    expect((await app.inject({url:base+'/run/source?offset=0&before=1',headers})).statusCode).toBe(400);
    store.read.mockClear();expect((await app.inject({url:base+'/run/status',headers})).json().state).toBe('ready');expect(store.read).not.toHaveBeenCalled();expect(catalog.summary).toHaveBeenCalled();
    expect((await app.inject({url:base+'/capabilities',headers})).json().modelLabel).toBe('测试文本模型');
  });
  it.each(['viewer','reviewer'] as const)('denies %s new extraction without touching the store',async role=>{
    const {app,store}=await fixture(role);expect((await app.inject({method:'POST',url:base,headers,payload:{}})).statusCode).toBe(403);expect(store.start).not.toHaveBeenCalled();
  });
  it('starts with host-owned pins, only enqueue references, and rejects request identity/model injection',async()=>{
    const {app,store,tasks,progress}=await fixture('editor',false);const run=progress.run;
    const payload={runId:run.runId,documentId:run.source.source.documentId,kind:'novel',expectedRevision:1,expectedSourceDigest:run.source.source.sourceDigest};
    for(const extra of [{tenantId:'other'},{actorId:'admin'},{execution:run.execution},{method:run.method},{baseUrl:'http://127.0.0.1'},{approved:true}])expect((await app.inject({method:'POST',url:base,headers,payload:{...payload,...extra}})).statusCode).toBe(400);
    const response=await app.inject({method:'POST',url:base,headers,payload});expect(response.statusCode).toBe(201);expect(response.json().state).toBe('queued');
    expect(store.start).toHaveBeenCalledWith({...payload,tenantId:'tenant',projectId:'project',method:run.method,execution:run.execution});
    expect(tasks.enqueue.mock.calls[0]![0].input).toEqual({projectId:'project',runId:'run',runDigest:run.digest,chunkId:run.plan.chunks[0]!.id});expect(tasks.get).toHaveBeenCalled();
  });
  it('allows read/review with no configured model but refuses new work',async()=>{
    const {app,presetFor,progress}=await fixture();presetFor.mockReturnValue(null as never);
    expect((await app.inject({url:base+'/capabilities',headers})).json()).toEqual({canStart:false,modelLabel:null,budget:null});
    const run=progress.run;expect((await app.inject({method:'POST',url:base,headers,payload:{runId:'new',documentId:'book',kind:'novel',expectedRevision:1,expectedSourceDigest:run.source.source.sourceDigest}})).statusCode).toBe(503);
    expect((await app.inject({url:base+'/run',headers})).statusCode).toBe(200);
  });
  it.each(['viewer','editor'] as const)('denies %s confirm/reject before a mutation',async role=>{
    const {app,store,f}=await fixture(role);for(const action of ['confirm','reject'])expect((await app.inject({method:'POST',url:base+'/run/'+action,headers,payload:action==='confirm'?f.decision:{reason:'不可信'}})).statusCode).toBe(403);
    expect(store.confirm).not.toHaveBeenCalled();expect(store.reject).not.toHaveBeenCalled();
  });
  it('derives the reviewer and audit time on the server and rejects client authorization',async()=>{
    const {app,store,f}=await fixture('reviewer');
    expect((await app.inject({method:'POST',url:base+'/run/confirm',headers,payload:{...f.decision,actorId:'victim'}})).statusCode).toBe(400);
    const response=await app.inject({method:'POST',url:base+'/run/confirm',headers,payload:f.decision});expect(response.statusCode).toBe(201);expect(response.json().review).toMatchObject({status:'confirmed',actorId:'human',at:f.host.at});
    const host=store.confirm.mock.calls[0]![2];expect(host.authorize({actorId:'other',source:f.plan.source,action:'bible:confirm'})).toBe(false);expect(host.authorize({actorId:'human',source:{...f.plan.source,projectId:'other'},action:'bible:confirm'})).toBe(false);
  });
  it('persists explicit rejection and uses a default server clock when none is injected',async()=>{
    const {app}=await fixture('reviewer');const response=await app.inject({method:'POST',url:base+'/run/reject',headers,payload:{reason:'人物关系有误'}});expect(response.json().review.reason).toBe('人物关系有误');
    expect((await app.inject({method:'POST',url:base+'/run/reject',headers,payload:{reason:''}})).statusCode).toBe(400);
  });
  it('raises only confirm body size, including when source imports are disabled',async()=>{
    const {app}=await fixture('reviewer');
    expect((await app.inject({method:'POST',url:base+'/run/confirm',headers,payload:{extra:'x'.repeat(20000)}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:base+'/run/confirm',headers,payload:{extra:'x'.repeat(2_100_000)}})).statusCode).toBe(413);
    expect((await app.inject({method:'POST',url:base+'/run/reject',headers,payload:{reason:'x'.repeat(20000)}})).statusCode).toBe(413);
  });
  it.each([['INVALID_INPUT',400],['INPUT_LIMIT',413],['INVALID_EVIDENCE',422],['CONFLICT',409],['FORBIDDEN',403],['INCOMPLETE',409],['MODEL_FAILED',503],['NOT_FOUND',404],['STORAGE_FAILED',503]] as const)('maps Bible %s without exposing private errors',async(code,status)=>{
    const {app,catalog}=await fixture();catalog.list.mockRejectedValue(new BibleError(code,'private-provider-url'));
    const response=await app.inject({url:base,headers});expect(response.statusCode).toBe(status);expect(response.json()).toEqual({code,requestId:expect.any(String)});expect(response.body).not.toContain('private');
  });
});
