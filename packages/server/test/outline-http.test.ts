import { afterEach,expect,it } from 'vitest';
import type { Task } from '@camery/durable';
import { OutlineError } from '@camery/script/outline/contracts';
import { createApplication } from '../src/app.js';
import { outlineHttpFixture,outlineApps,outlineBase as base,outlineHeaders as headers } from './outline-http-support.js';
afterEach(async()=>{await Promise.all(outlineApps.splice(0).map(app=>app.close()));});
it('registers the Outline module through the authenticated application boundary',async()=>{
  const f=await outlineHttpFixture();const response=await f.app.inject({url:base+'/capabilities',headers});
  expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({canStart:true,defaultEpisodeCount:10,modelLabel:'测试大纲模型',formalAdoption:false});
});
it('keeps the new module disabled by default',async()=>{
  const f=await outlineHttpFixture();const app=await createApplication({tenantId:f.key.tenantId,store:f.sessions});outlineApps.push(app);
  expect((await app.inject({url:base+'/capabilities',headers})).statusCode).toBe(404);
});
it('authenticates before source or model reads and observes project isolation and session revocation',async()=>{
  const f=await outlineHttpFixture();expect((await f.app.inject({url:base})).statusCode).toBe(401);
  expect(f.catalog.list).not.toHaveBeenCalled();expect(f.presetFor).not.toHaveBeenCalled();expect(f.storeSpies.read).not.toHaveBeenCalled();
  expect((await f.app.inject({url:base.replace('/project/','/other/'),headers})).statusCode).toBe(403);
  expect((await f.app.inject({url:base+'?tenantId=other',headers})).statusCode).toBe(400);
  expect((await f.app.inject({url:base,headers})).statusCode).toBe(200);f.sessions.lookup.mockResolvedValue(null);
  expect((await f.app.inject({url:base,headers})).statusCode).toBe(401);expect(f.tasks.enqueue).not.toHaveBeenCalled();
});
it.each(['viewer','reviewer'] as const)('prevents %s brief writes and starts before reading host presets or domain records',async role=>{
  const f=await outlineHttpFixture(role);
  for(const url of [base,base+'/briefs'])expect((await f.app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(403);
  expect(f.storeSpies.start).not.toHaveBeenCalled();expect(f.storeSpies.putBrief).not.toHaveBeenCalled();expect(f.presetFor).not.toHaveBeenCalled();
});
it('saves and restores a scoped brief without text configuration, using the authenticated author',async()=>{
  const f=await outlineHttpFixture('editor');f.presetFor.mockReturnValue(null);const body=f.briefBody();
  const saved=await f.app.inject({method:'POST',url:base+'/briefs',headers,payload:body});expect(saved.statusCode,saved.body).toBe(201);
  expect(saved.json()).toMatchObject({actorId:'http-human',brief:{briefId:body.briefId,revision:1}});expect(saved.json().brief).not.toHaveProperty('tenantId');
  expect(f.storeSpies.putBrief).toHaveBeenCalledWith({...body,tenantId:f.key.tenantId,projectId:f.key.projectId,actorId:'http-human'});
  const restored=await f.app.inject({url:base+'/briefs/'+body.briefId+'?revision=1',headers});expect(restored.statusCode,restored.body).toBe(200);expect(restored.json()).toEqual(saved.json());
  expect(f.tasks.enqueue).not.toHaveBeenCalled();expect(f.sessionFor).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();
  for(const extra of [{tenantId:'foreign'},{projectId:'foreign'},{actorId:'client'},{at:'2026-11-17T00:00:00.000Z'}])expect((await f.app.inject({method:'POST',url:base+'/briefs',headers,payload:{...body,...extra}})).statusCode).toBe(400);
});
it('lists bounded metadata and source selections with session scope and strict query fields',async()=>{
  const f=await outlineHttpFixture('viewer');
  expect((await f.app.inject({url:base+'?cursor=abc&briefId=idea',headers})).statusCode).toBe(200);
  expect(f.catalog.list).toHaveBeenCalledWith({tenantId:f.key.tenantId,projectId:f.key.projectId,cursor:'abc',briefId:'idea'});
  expect((await f.app.inject({url:base+'/briefs?cursor=brief-page',headers})).statusCode).toBe(200);expect(f.briefs.list).toHaveBeenCalledWith({tenantId:f.key.tenantId,projectId:f.key.projectId,cursor:'brief-page'});
  for(const kind of ['development','bible']){
    expect((await f.app.inject({url:base+'/sources?kind='+kind+'&cursor=source-page',headers})).statusCode).toBe(200);
    expect(f.sources.list).toHaveBeenLastCalledWith({tenantId:f.key.tenantId,projectId:f.key.projectId,kind,cursor:'source-page'});
  }
  for(const suffix of ['?cursor=a&cursor=b','?unknown=1','/sources','/sources?kind=bad','/sources?kind=bible&tenantId=other','/briefs?revision=1','/briefs/outline?revision=0','/briefs/outline?revision=01'])
    expect((await f.app.inject({url:base+suffix,headers})).statusCode).toBe(400);
  expect(f.tasks.enqueue).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();
});
it('starts a new immutable run using only the host profile and queues a small reference',async()=>{
  const f=await outlineHttpFixture('editor'),body=f.startBody('new-outline');
  const response=await f.app.inject({method:'POST',url:base,headers,payload:body});expect(response.statusCode,response.body).toBe(201);expect(response.json().state).toBe('queued');
  expect(f.storeSpies.start).toHaveBeenCalledWith({...body,tenantId:f.key.tenantId,projectId:f.key.projectId,source:{...body.source,tenantId:f.key.tenantId,projectId:f.key.projectId},execution:f.execution});
  expect(f.tasks.enqueue).toHaveBeenCalledOnce();const queued=f.tasks.enqueue.mock.calls[0]![0];expect(queued.input).toMatchObject({projectId:f.key.projectId,runId:body.runId,runDigest:expect.any(String)});
  expect(queued.input).not.toHaveProperty('source');expect(queued.input).not.toHaveProperty('execution');expect(f.exchange).not.toHaveBeenCalled();
});
it('refuses client scope, method, model, receipt and actor overrides before start',async()=>{
  const f=await outlineHttpFixture('editor'),body=f.startBody('new-outline');
  for(const extra of [{tenantId:'other'},{projectId:'other'},{execution:{}},{method:{}},{model:{}},{receipt:{}},{actorId:'client'},{authorize:true}])
    expect((await f.app.inject({method:'POST',url:base,headers,payload:{...body,...extra}})).statusCode).toBe(400);
  expect((await f.app.inject({method:'POST',url:base,headers,payload:{...body,source:{...body.source,tenantId:'other'}}})).statusCode).toBe(400);
  expect(f.storeSpies.start).not.toHaveBeenCalled();expect(f.tasks.enqueue).not.toHaveBeenCalled();
});
it('disables new generation without a preset but keeps all reads and brief data available',async()=>{
  const f=await outlineHttpFixture('editor');f.presetFor.mockReturnValue(null);
  const capabilities=await f.app.inject({url:base+'/capabilities',headers});expect(capabilities.json()).toEqual({canStart:false,defaultEpisodeCount:10,modelLabel:null,budget:null,formalAdoption:false});
  expect((await f.app.inject({method:'POST',url:base,headers,payload:f.startBody('not-yet-saved')})).statusCode).toBe(409);expect(f.storeSpies.start).not.toHaveBeenCalled();
  expect((await f.app.inject({url:base+'/'+f.key.runId,headers})).statusCode).toBe(200);expect(f.tasks.enqueue).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();
});
it.each(['none','changed'] as const)('retries the original start with %s current configuration and preserves the original physical task',async mode=>{
  const f=await outlineHttpFixture('editor'),original=f.task('queued');f.saved.set(original.taskId,original);
  if(mode==='none')f.presetFor.mockReturnValue(null);else f.presetFor.mockReturnValue({label:'新的部署模型',execution:{...f.execution,connectionId:'new-provider',modelIdentity:'new-model'}});
  const response=await f.app.inject({method:'POST',url:base,headers,payload:f.startBody()});expect(response.statusCode,response.body).toBe(201);expect(response.json()).toMatchObject({state:'queued',runDigest:f.run.digest});
  expect(f.storeSpies.start).toHaveBeenLastCalledWith({...f.command,source:f.source.descriptor,execution:f.execution});expect(f.tasks.enqueue).not.toHaveBeenCalled();
  expect(f.saved.get(original.taskId)).toBe(original);expect(f.exchange).not.toHaveBeenCalled();
});
it.each(['reconciling','failed','cancelled'] as const)('keeps the original %s task on start retry without creating a replacement',async status=>{
  const f=await outlineHttpFixture('editor'),original=f.task(status);f.saved.set(original.taskId,original);f.presetFor.mockReturnValue(null);
  const response=await f.app.inject({method:'POST',url:base,headers,payload:f.startBody()});expect(response.statusCode,response.body).toBe(201);expect(response.json().state).toBe(status);
  expect(f.tasks.enqueue).not.toHaveBeenCalled();expect(f.saved.size).toBe(1);expect(f.exchange).not.toHaveBeenCalled();
});
it('recovers a committed start ACK loss with the same request after text configuration disappears',async()=>{
  const f=await outlineHttpFixture('editor'),body=f.startBody('commit-ack-lost');let lost=false;
  f.storeSpies.start.mockImplementation(async command=>{const run=await f.originalStart(command);if(!lost){lost=true;throw new Error('private commit ACK details');}return run;});
  const first=await f.app.inject({method:'POST',url:base,headers,payload:body});expect(first.statusCode).toBe(500);expect(first.body).not.toContain('private');expect(f.tasks.enqueue).not.toHaveBeenCalled();
  f.presetFor.mockReturnValue(null);const retry=await f.app.inject({method:'POST',url:base,headers,payload:body});expect(retry.statusCode,retry.body).toBe(201);expect(retry.json()).toMatchObject({runId:body.runId,state:'queued'});
  expect(f.tasks.enqueue).toHaveBeenCalledOnce();expect(f.saved.size).toBe(1);expect(f.exchange).not.toHaveBeenCalled();
});
it('preserves a reviewed stale candidate and its original journal tail when retrying without text configuration',async()=>{
  const f=await outlineHttpFixture('admin',{ready:true}),body=await f.confirmBody();
  expect((await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/confirm',headers,payload:body})).statusCode).toBe(201);
  const original=f.task('queued');f.saved.set(original.taskId,original);f.db.state.current=false;f.presetFor.mockReturnValue(null);
  const retry=await f.app.inject({method:'POST',url:base,headers,payload:f.startBody()});expect(retry.statusCode,retry.body).toBe(201);
  expect(retry.json()).toMatchObject({state:'queued',reviewStatus:'reviewed',sourceChanged:true,runDigest:f.run.digest});
  expect(f.tasks.enqueue).not.toHaveBeenCalled();expect(f.saved.get(original.taskId)).toBe(original);expect(f.exchange).toHaveBeenCalledOnce();expect(f.sessionFor).toHaveBeenCalledOnce();
});
it('rejects a reused run identity with different brief or source semantics',async()=>{
  const f=await outlineHttpFixture('editor'),body=f.startBody();f.presetFor.mockReturnValue(null);
  for(const change of [{briefId:'different'},{expectedRevision:2},{expectedBriefDigest:'b'.repeat(64)},{source:{...body.source,runDigest:'b'.repeat(64)}}]){
    const response=await f.app.inject({method:'POST',url:base,headers,payload:{...body,...change}});expect(response.statusCode,response.body).toBe(409);
  }
  expect(f.tasks.enqueue).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();
});
it('keeps status and detail read-only and redacts stored model and task internals',async()=>{
  const f=await outlineHttpFixture('viewer',{ready:true}),original=f.task('running');f.saved.set(original.taskId,original);
  for(const suffix of ['', '/status']){
    const response=await f.app.inject({url:base+'/'+f.key.runId+suffix,headers});expect(response.statusCode,response.body).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
    const data=response.json();expect(data.state).toBe('running');expect(data.task).toEqual({status:'running',resultState:null,reason:null});expect(response.body).not.toContain('private provider credential');expect(data).not.toHaveProperty('execution');
    if(!suffix){expect(data.candidate.output).toEqual(f.output);expect(data.candidate).not.toHaveProperty('model');expect(data.source.descriptor).not.toHaveProperty('tenantId');}
  }
  expect(f.tasks.enqueue).not.toHaveBeenCalled();expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
});
it('captures the authenticated reviewer, preserves full edits and never generates from confirmation',async()=>{
  const f=await outlineHttpFixture('reviewer',{ready:true}),body=await f.confirmBody();body.output.adaptation.title='HTTP 人工修订的停钟之夜';
  const response=await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/confirm',headers,payload:body});expect(response.statusCode,response.body).toBe(201);
  expect(response.json().candidate.output).toEqual(f.output);expect(response.json().review).toMatchObject({status:'reviewed',actorId:'http-human',at:f.host.at,output:body.output,ablations:body.ablations,waivers:[]});
  const host=f.storeSpies.review.mock.calls[0]![2];expect(host.actor).toEqual({kind:'human',id:'http-human'});expect(host.authorize({actorId:'foreign',brief:f.brief,action:'outline:review'})).toBe(false);
  expect(f.tasks.enqueue).not.toHaveBeenCalled();expect(f.exchange).toHaveBeenCalledOnce();
});
it('confirms a legal full output above the old 256KiB envelope without truncating any assets or decisions',async()=>{
  const f=await outlineHttpFixture('reviewer',{ready:true,large:true}),body=await f.confirmBody();expect(Buffer.byteLength(JSON.stringify(body.output))).toBeGreaterThan(262144);expect(Buffer.byteLength(JSON.stringify(body.output))).toBeLessThanOrEqual(524288);
  const response=await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/confirm',headers,payload:body});expect(response.statusCode,response.body).toBe(201);
  const result=response.json();expect(result.review.output).toEqual(body.output);expect(result.review.output.assets).toHaveLength(128);expect(result.review.output.adaptation.decisions).toHaveLength(128);expect(f.exchange).toHaveBeenCalledOnce();expect(f.tasks.enqueue).not.toHaveBeenCalled();
});
it('prevents editor approval and rejects caller-supplied approval, actor or audit fields',async()=>{
  const editor=await outlineHttpFixture('editor',{ready:true});expect((await editor.app.inject({method:'POST',url:base+'/'+editor.key.runId+'/confirm',headers,payload:await editor.confirmBody()})).statusCode).toBe(403);expect(editor.storeSpies.review).not.toHaveBeenCalled();
  const f=await outlineHttpFixture('reviewer',{ready:true}),body=await f.confirmBody();
  for(const extra of [{actorId:'client'},{at:f.host.at},{tenantId:'other'},{authorize:true},{model:{}},{report:{}}])expect((await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/confirm',headers,payload:{...body,...extra}})).statusCode).toBe(400);
  expect(f.storeSpies.review).not.toHaveBeenCalled();
});
it('rechecks graph references and current source before storing a human decision',async()=>{
  const f=await outlineHttpFixture('reviewer',{ready:true}),body=await f.confirmBody();body.output.episodes[0]!.beatIds=['missing-beat'];
  const invalid=await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/confirm',headers,payload:body});expect(invalid.statusCode,invalid.body).toBe(422);
  f.db.state.current=false;const stale=await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/confirm',headers,payload:await f.confirmBody()});expect(stale.statusCode,stale.body).toBe(409);
  expect((await f.progress()).review).toBeNull();expect(f.exchange).toHaveBeenCalledOnce();
});
it('recovers a committed human audit ACK without replacing its original actor or time and rechecks session revocation',async()=>{
  const f=await outlineHttpFixture('reviewer',{ready:true}),body=await f.confirmBody();let lost=false;
  f.storeSpies.review.mockImplementation(async(...args)=>{const review=await f.originalReview(...args);if(!lost){lost=true;throw new Error('private audit ACK');}return review;});
  expect((await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/confirm',headers,payload:body})).statusCode).toBe(500);
  f.now.mockReturnValue('2026-11-17T20:00:00.000Z');const retry=await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/confirm',headers,payload:body});expect(retry.statusCode,retry.body).toBe(201);expect(retry.json().review).toMatchObject({actorId:'http-human',at:f.host.at});
  f.sessions.lookup.mockResolvedValue(null);expect((await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/confirm',headers,payload:body})).statusCode).toBe(401);expect(f.exchange).toHaveBeenCalledOnce();
});
it('stores explicit rejection without queueing and rejects empty or oversized requests at their exact routes',async()=>{
  const f=await outlineHttpFixture('reviewer',{ready:true});const response=await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/reject',headers,payload:{reason:'重新整理季级冲突引擎。'}});
  expect(response.statusCode,response.body).toBe(201);expect(response.json().review).toMatchObject({status:'rejected',actorId:'http-human',reason:'重新整理季级冲突引擎。'});expect(f.tasks.enqueue).not.toHaveBeenCalled();
  expect((await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/reject',headers,payload:{reason:''}})).statusCode).toBe(400);
  expect((await f.app.inject({method:'POST',url:base+'/'+f.key.runId+'/confirm',headers,payload:{output:'x'.repeat(2097153)}})).statusCode).toBe(413);
  expect((await f.app.inject({method:'POST',url:base+'/briefs',headers,payload:{notes:'x'.repeat(16385)}})).statusCode).toBe(413);
});
it.each([['INVALID_INPUT',400],['INPUT_LIMIT',413],['INVALID_REFERENCE',422],['INCOMPLETE',409],['CONFLICT',409],['FORBIDDEN',403],['INVALID_EVIDENCE',422],['NOT_FOUND',404],['STORAGE_FAILED',503]] as const)('maps %s into a safe status without domain or driver diagnostics',async(code,status)=>{
  const f=await outlineHttpFixture('viewer');f.storeSpies.read.mockRejectedValue(new OutlineError(code,'private credential operation','private-value'));
  const response=await f.app.inject({url:base+'/'+f.key.runId,headers});expect(response.statusCode,response.body).toBe(status);expect(response.json().code).toBe(code);expect(response.body).not.toContain('private');expect(response.headers['cache-control']).toBe('no-store');
});
it('reads the original task header before an independent human audit committed during polling',async()=>{
  const f=await outlineHttpFixture('viewer',{ready:true}),decision=await f.confirmBody();let reviewed=false;
  f.tasks.get.mockImplementation(async()=>{
    if(!reviewed){reviewed=true;await f.originalReview(f.key,decision,f.host);}return f.task('running');
  });
  const response=await f.app.inject({url:base+'/'+f.key.runId,headers});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({state:'running',reviewStatus:'reviewed',review:{actorId:f.host.actor.id}});expect(f.tasks.enqueue).not.toHaveBeenCalled();
});
it('refuses a foreign physical task and a succeeded task missing its candidate instead of inventing a queued result',async()=>{
  const f=await outlineHttpFixture('viewer');f.tasks.get.mockResolvedValue({...f.task(),tenantId:'foreign'});
  expect((await f.app.inject({url:base+'/'+f.key.runId,headers})).statusCode).toBe(503);
  f.tasks.get.mockResolvedValue({...f.task('succeeded'),output:{state:'candidate',runDigest:f.run.digest,candidateDigest:'a'.repeat(64)}} as Task);
  expect((await f.app.inject({url:base+'/'+f.key.runId+'/status',headers})).statusCode).toBe(503);expect(f.tasks.enqueue).not.toHaveBeenCalled();
});
