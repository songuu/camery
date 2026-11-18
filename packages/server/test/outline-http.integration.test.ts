import { createServer } from 'node:http';
import { randomBytes,randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect,it,vi } from 'vitest';
import { issueSession } from '@camery/access';
import { migrateAccess,PostgresSessionStore,verifyRuntimeRole } from '@camery/access/node';
import { migrateDurable,PostgresDurableStore,DurableWorker,stepIdempotencyKey } from '@camery/durable';
import { migrateAgents,PostgresBudgetLedger } from '@camery/agents/node';
import { migrateIngest } from '@camery/ingest/node';
import { migrateBible } from '@camery/bible/node';
import { migrateDevelopment } from '@camery/script/node';
import { PostgresOutlineStore,PostgresOutlineCatalog,PostgresOutlineBriefCatalog,PostgresOutlineSourceCatalog,grantOutlineRuntimeRole,verifyOutlineRuntimeRole,migrateOutline,createOutlineWorkflow,outlineTaskId } from '@camery/script/outline/node';
import type { OutlineRunView,OutlineBriefView,OutlineSourceList } from '@camery/script/outline/http';
import type { Json } from '@camery/model-modes';
import { createDevelopmentSourceFixture,createBibleSourceFixture } from '../../script/test/outline-source-pg-support.js';
import { outlineProtocolTransport } from '../../script/test/outline-workflow-pg-support.js';
import { createApplication } from '../src/app.js';
import { createOutlineHost } from '../src/outline-host.js';
import { createOutlineModelRuntime } from '../src/outline-runtime.js';
import type { OutlineDeploymentConfig } from '../src/outline-config.js';
import { grantOutlineTaskRuntimeRole,verifyOutlineTaskRuntimeRole } from '../src/outline-task-role.js';
import { releaseResources } from '../src/shutdown.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for outline HTTP integration');
it.each(['development','bible'] as const)('uses restricted pools and actual sessions for %s outlines, human ACK recovery and no-text paid journal replay',async kind=>{
  const admin=new Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000}),scope={tenantId:'outline-http-'+randomUUID(),projectId:'project'};
  const roles:{name:string;url:string;pool:Pool}[]=[],extraPools:Pool[]=[];let app:Awaited<ReturnType<typeof createApplication>>|undefined;
  let calls=0,reviewAckLost=false,candidateAckLost=false;const token='fixture-outline-'+randomBytes(20).toString('hex');
  const protocol=outlineProtocolTransport(()=>{calls++;},kind==='bible');
  const provider=createServer((request,response)=>{void(async()=>{
    if(request.url!=='/v1/chat/completions'||request.headers.authorization!=='Bearer '+token){response.statusCode=403;response.end('{}');return;}
    const chunks:Buffer[]=[];for await(const part of request)chunks.push(part as Buffer);const body:Json=JSON.parse(Buffer.concat(chunks).toString());
    const result=await protocol.exchange({method:'POST',path:'/chat/completions',body,effect:'submit',responseType:'json'},{tenantId:scope.tenantId,connectionId:'outline-http',modeDigest:'a'.repeat(64),idempotencyKey:'fixture-response',signal:new AbortController().signal});
    if(result.body.kind!=='json')throw new Error('Expected JSON protocol fixture');response.setHeader('content-type','application/json');response.end(JSON.stringify(result.body.value));
  })().catch(()=>response.destroy(new Error('Owned outline protocol fixture failed')));});
  async function login(prefix:string){
    const name=prefix+'_'+randomBytes(8).toString('hex'),password=randomBytes(24).toString('hex');await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);
    const url=new URL(databaseUrl!);url.username=name;url.password=password;const identity={name,url:url.href,pool:new Pool({connectionString:url.href,max:4,connectionTimeoutMillis:5000})};roles.push(identity);return identity;
  }
  try{
    await migrateAccess(admin);await migrateDurable(admin);await migrateAgents(admin);await migrateIngest(admin);await migrateBible(admin);await migrateDevelopment(admin);await migrateOutline(admin);
    const source=kind==='development'?await createDevelopmentSourceFixture(admin,scope):await createBibleSourceFixture(admin,scope);
    const auth=await login('outline_http_auth'),data=await login('outline_http_data'),tasks=await login('outline_http_tasks');
    await admin.query(`GRANT USAGE ON SCHEMA camery_access TO ${auth.name}`);await admin.query(`GRANT SELECT ON camery_access.users,camery_access.memberships,camery_access.sessions TO ${auth.name}`);await admin.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO ${auth.name}`);
    await grantOutlineRuntimeRole(admin,data.name);await grantOutlineTaskRuntimeRole(admin,tasks.name);await verifyRuntimeRole(auth.pool);await verifyOutlineRuntimeRole(data.pool);await verifyOutlineTaskRuntimeRole(tasks.pool);
    const installer=new PostgresSessionStore(admin),headers={editor:{authorization:''},reviewer:{authorization:''},viewer:{authorization:''}};
    for(const role of ['editor','reviewer','viewer'] as const){await installer.provisionMember({...scope,userId:role,role});const session=await issueSession({tenantId:scope.tenantId,userId:role,ttlSeconds:3600},installer);headers[role]={authorization:'Bearer '+session.token};}
    await new PostgresBudgetLedger(admin).createProject({...scope,currency:'CNY',limits:{steps:5,tokens:1500,costMicros:50}},'fixture-installer');
    await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();if(!address||typeof address==='string')throw new Error('Missing owned provider port');
    const config:OutlineDeploymentConfig={...scope,outlineDatabaseUrl:data.url,taskDatabaseUrl:tasks.url,workerId:'outline-http-worker',pollMs:50,runsPerRound:20,
      text:{label:'合成HTTP协议验收，非真实质量',baseUrl:`http://127.0.0.1:${address.port}/v1`,connectionId:'outline-http',modelIdentity:'fixture-outline',modeDigest:'a'.repeat(64),structuredOutput:'json_schema',timeoutMs:3000,allowPrivateNetworks:true,allowInsecureHttp:true,token,currency:'CNY',reservation:{tokens:300,costMicros:10},pricing:{inputMicrosPerMillionTokens:100,outputMicrosPerMillionTokens:100},limits:{steps:1,tokens:300,costMicros:10}}};
    const runtime=createOutlineModelRuntime(config),store=new PostgresOutlineStore(data.pool),durable=new PostgresDurableStore(tasks.pool),catalog=new PostgresOutlineCatalog(data.pool);
    const save=store.saveCandidate.bind(store);vi.spyOn(store,'saveCandidate').mockImplementation(async(...args)=>{const result=await save(...args);if(!candidateAckLost){candidateAckLost=true;throw new Error('private candidate ACK failure');}return result;});
    const review=store.review.bind(store);vi.spyOn(store,'review').mockImplementation(async(...args)=>{const result=await review(...args);if(!reviewAckLost){reviewAckLost=true;throw new Error('private review ACK failure');}return result;});
    const worker=new DurableWorker(durable,{retryDelayMs:1,leaseMs:5000,runTimeoutMs:20000});worker.register(createOutlineWorkflow({store,ledger:new PostgresBudgetLedger(tasks.pool),sessionFor:runtime.sessionFor}));
    const host=createOutlineHost({scope,workerId:config.workerId,store,catalog,durable,worker});
    const open=(authPool:Pool,dataStore:PostgresOutlineStore,dataPool:Pool,taskStore:PostgresDurableStore,presetFor:typeof runtime.presetFor)=>createApplication({tenantId:scope.tenantId,store:new PostgresSessionStore(authPool),outlines:{store:dataStore,catalog:new PostgresOutlineCatalog(dataPool),briefs:new PostgresOutlineBriefCatalog(dataPool),sources:new PostgresOutlineSourceCatalog(dataPool),tasks:taskStore,presetFor}});
    app=await open(auth.pool,store,data.pool,durable,runtime.presetFor);const base='/api/v1/projects/project/outlines';
    const get=async(path:string)=>{const result=await app!.inject({url:base+path,headers:headers.viewer});expect(result.statusCode,result.body).toBe(200);return result;};
    const put={briefId:'adaptation',expectedRevision:0,notes:'保留经人工确认的港城选择与冲突。',episodeCount:3,targetSeconds:90,paidEpisodeNumbers:[3],mainGenre:'rebirth-revenge',auxiliaryGenres:['suspense']};
    expect((await app.inject({method:'POST',url:base+'/briefs',headers:headers.viewer,payload:put})).statusCode).toBe(403);
    const written=await app.inject({method:'POST',url:base+'/briefs',headers:headers.editor,payload:put});expect(written.statusCode,written.body).toBe(201);const brief=written.json<OutlineBriefView>();expect(brief.actorId).toBe('editor');
    const selected=(await get('/sources?kind='+kind)).json<OutlineSourceList>();expect(selected.items).toHaveLength(1);expect(selected.items[0]!.source.runDigest).toBe(source.descriptor.runDigest);
    const command={runId:'first',briefId:brief.brief.briefId,expectedRevision:1,expectedBriefDigest:brief.brief.digest,source:selected.items[0]!.source};
    expect((await app.inject({method:'POST',url:base,headers:headers.reviewer,payload:command})).statusCode).toBe(403);expect((await app.inject({method:'POST',url:base,headers:headers.editor,payload:command})).statusCode).toBe(201);
    expect(calls).toBe(0);await get('/first/status');await get('/first');expect(calls).toBe(0);expect((await host.round()).executed).toBe(1);expect(calls).toBe(1);
    const pending=(await get('/first')).json<OutlineRunView>();expect(pending.state).toBe('queued');expect(pending.candidate).not.toHaveProperty('model');expect(pending.candidate?.output.assets).toHaveLength(kind==='bible'?128:1);
    const edited=structuredClone(pending.candidate!.output);edited.adaptation.title='真实会话审核者修改';const decision={candidateDigest:pending.candidate!.digest,output:edited,ablations:[{genre:'suspense',judgment:'participates',reason:'测试宿主核对查证改变反击。'}],waivers:[]};
    expect((await app.inject({method:'POST',url:base+'/first/confirm',headers:headers.editor,payload:decision})).statusCode).toBe(403);
    const lost=await app.inject({method:'POST',url:base+'/first/confirm',headers:headers.reviewer,payload:decision});expect(lost.statusCode,lost.body).toBe(500);expect(lost.body).not.toContain('private');
    const audited=(await get('/first')).json<OutlineRunView>();expect(audited.review).toMatchObject({status:'reviewed',actorId:'reviewer',output:edited});
    if(kind==='bible')expect(Buffer.byteLength(JSON.stringify(edited))).toBeGreaterThan(262144);
    const guard={...command,runId:'unknown'};expect((await app.inject({method:'POST',url:base,headers:headers.editor,payload:guard})).statusCode).toBe(201);
    const guardKey={tenantId:scope.tenantId,taskId:outlineTaskId({...scope,runId:guard.runId})},claim=await durable.claimTask(guardKey,'fixture-unknown',60000);expect(claim).not.toBeNull();
    await durable.openStep(claim!.lease,{key:'agent.0.decision',position:0,kind:'external',input:{purpose:'synthetic unknown guard, no completed provider call claimed'},fingerprint:'b'.repeat(64),idempotencyKey:stepIdempotencyKey(guardKey,'agent.0.decision')});await durable.failStep(claim!.lease,'agent.0.decision','Synthetic unavailable outcome',true);
    await durable.enqueue({tenantId:scope.tenantId,taskId:'unrelated-sentinel',workflow:'not-registered',version:1,input:null,maxAttempts:1,availableAt:new Date('2025-01-01T00:00:00Z')});
    expect((await app.inject({method:'POST',url:base+'/briefs',headers:headers.editor,payload:{...put,expectedRevision:1,notes:'审核之后更新的目标。'}})).statusCode).toBe(201);await app.close();app=undefined;
    const authPool=new Pool({connectionString:auth.url,max:2}),dataPool=new Pool({connectionString:data.url,max:2}),taskPool=new Pool({connectionString:tasks.url,max:2});extraPools.push(authPool,dataPool,taskPool);
    const restored=new PostgresOutlineStore(dataPool),restoredTasks=new PostgresDurableStore(taskPool),empty=createOutlineModelRuntime({...config,text:null});let sessions=0;
    app=await open(authPool,restored,dataPool,restoredTasks,empty.presetFor);expect((await get('/capabilities')).json()).toMatchObject({canStart:false,budget:null});
    const retry=await app.inject({method:'POST',url:base,headers:headers.editor,payload:command});expect(retry.statusCode,retry.body).toBe(201);expect(retry.json()).toMatchObject({state:'queued',sourceChanged:true});
    await installer.provisionMember({...scope,userId:'reviewer',role:'viewer'});expect((await app.inject({method:'POST',url:base+'/first/confirm',headers:headers.reviewer,payload:decision})).statusCode).toBe(403);
    await installer.provisionMember({...scope,userId:'reviewer',role:'reviewer'});const ack=await app.inject({method:'POST',url:base+'/first/confirm',headers:headers.reviewer,payload:decision});expect(ack.statusCode,ack.body).toBe(201);expect(ack.json().review).toEqual(audited.review);
    const recoveredWorker=new DurableWorker(restoredTasks,{retryDelayMs:1});recoveredWorker.register(createOutlineWorkflow({store:restored,ledger:new PostgresBudgetLedger(taskPool),sessionFor:async(...args)=>{sessions++;return empty.sessionFor(...args);}}));
    await createOutlineHost({scope,workerId:'outline-no-text-recovery',store:restored,catalog:new PostgresOutlineCatalog(dataPool),durable:restoredTasks,worker:recoveredWorker}).round();
    const finished=(await get('/first')).json<OutlineRunView>();expect(finished.state).toBe('reviewed');expect(finished.sourceChanged).toBe(true);expect(finished.candidate).toEqual(pending.candidate);expect(finished.review).toEqual(audited.review);expect(sessions).toBe(0);expect(calls).toBe(1);
    expect((await app.inject({method:'POST',url:base,headers:headers.editor,payload:guard})).json()).toMatchObject({state:'reconciling'});expect(await restoredTasks.get(guardKey)).toMatchObject({status:'reconciling'});
    await restoredTasks.cancel(guardKey,'fixture-owner');expect((await app.inject({method:'POST',url:base,headers:headers.editor,payload:guard})).json()).toMatchObject({state:'cancelled'});
    expect((await app.inject({method:'POST',url:base,headers:headers.editor,payload:{...command,runId:'new-without-text'}})).statusCode).toBe(409);expect((await get('/first')).headers['cache-control']).toBe('no-store');
    expect(await restoredTasks.get({tenantId:scope.tenantId,taskId:'unrelated-sentinel'})).toMatchObject({status:'queued',attempts:0});expect((await admin.query('SELECT count(*)::int n FROM camery_agents.budget_allocations WHERE tenant_id=$1',[scope.tenantId])).rows[0]).toEqual({n:1});
    expect((await new PostgresBudgetLedger(admin).project(scope)).used.tokens).toBe('300');expect((await restored.read({...scope,runId:'first'})).candidate?.model).toMatchObject({evidence:'live_model',providerRequestId:'fixture-outline-workflow'});
    await expect(dataPool.query('SELECT * FROM camery_access.sessions WHERE tenant_id=$1',[scope.tenantId])).rejects.toMatchObject({code:'42501'});await expect(taskPool.query('SELECT record FROM camery_outline.runs WHERE tenant_id=$1',[scope.tenantId])).rejects.toMatchObject({code:'42501'});
    expect((await app.inject({url:base.replace('/project/','/other/'),headers:headers.viewer})).statusCode).toBe(403);expect((await app.inject({method:'POST',url:'/api/v1/auth/sign-out',headers:headers.viewer})).statusCode).toBe(204);expect((await app.inject({url:base,headers:headers.viewer})).statusCode).toBe(401);
  }finally{
    const ok=await releaseResources([()=>app?.close(),...extraPools.map(pool=>()=>pool.end()),...roles.map(role=>()=>role.pool.end()),()=>provider.listening?new Promise<void>((resolve,reject)=>provider.close(error=>error?reject(error):resolve())):undefined,
      ...([['camery_outline',['reviews','candidates','runs','briefs']],['camery_script',['run_origins','reviews','candidates','runs','briefs']],['camery_bible',['reviews','candidates','chunks','runs']],['camery_ingest',['reading_checkpoints','documents']],['camery_agents',['budget_events','budget_allocations','budget_projects']],['camery_durable',['events','signals','steps','tasks']],['camery_access',['sessions','memberships','users']]] as const).flatMap(([schema,tables])=>tables.map(table=>()=>admin.query(`DELETE FROM ${schema}.${table} WHERE tenant_id=$1`,[scope.tenantId]))),
      ...roles.flatMap(role=>[()=>admin.query(`DROP OWNED BY ${role.name}`),()=>admin.query(`DROP ROLE ${role.name}`)]),()=>admin.end()]);
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Every owned role, pool and test tenant must report cleanup failure.
    if(!ok)throw new Error('Outline HTTP fixture cleanup failed');
  }
});
