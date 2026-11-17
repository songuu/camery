import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {expect,it} from 'vitest';
import {issueSession} from '@camery/access';
import {migrateAccess,PostgresSessionStore,verifyRuntimeRole} from '@camery/access/node';
import {migrateDurable,PostgresDurableStore,DurableWorker} from '@camery/durable';
import {migrateAgents,PostgresBudgetLedger} from '@camery/agents/node';
import {migrateDevelopment,PostgresDevelopmentStore,PostgresDevelopmentCatalog,PostgresDevelopmentBriefCatalog,grantDevelopmentRuntimeRole,verifyDevelopmentRuntimeRole,developmentMethodPins,createDevelopmentStageWorkflow} from '@camery/script/node';
import {protocolTransport,sessionFactory} from '../../script/test/workflow-pg-support.js';
import {grantDevelopmentTaskRuntimeRole,verifyDevelopmentTaskRuntimeRole} from '../src/development-task-role.js';
import {createDevelopmentHost} from '../src/development-host.js';
import {createApplication} from '../src/app.js';
import {releaseResources} from '../src/shutdown.js';
const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for development HTTP integration');
it('persists authenticated editable development across API restarts, stages, budgeted hosts and permission revocation',async()=>{
  const admin=new Pool({connectionString:databaseUrl});const scope={tenantId:'development-http-'+randomUUID(),projectId:'project'};const roles:{role:string;pool:Pool}[]=[];let app:Awaited<ReturnType<typeof createApplication>>|undefined;
  async function login(prefix:string){const role=prefix+'_'+randomBytes(8).toString('hex');const password=randomBytes(24).toString('hex');await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);const url=new URL(databaseUrl!);url.username=role;url.password=password;const identity={role,pool:new Pool({connectionString:url.toString(),max:4})};roles.push(identity);return identity;}
  try{
    await migrateAccess(admin);await migrateDurable(admin);await migrateAgents(admin);await migrateDevelopment(admin);
    const auth=await login('development_http_auth');const data=await login('development_http_data');const tasks=await login('development_http_tasks');
    await admin.query(`GRANT USAGE ON SCHEMA camery_access TO ${auth.role}`);await admin.query(`GRANT SELECT ON camery_access.users,camery_access.memberships,camery_access.sessions TO ${auth.role}`);await admin.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO ${auth.role}`);
    await grantDevelopmentRuntimeRole(admin,data.role);await grantDevelopmentTaskRuntimeRole(admin,tasks.role);await verifyRuntimeRole(auth.pool);await verifyDevelopmentRuntimeRole(data.pool);await verifyDevelopmentTaskRuntimeRole(tasks.pool);
    const installer=new PostgresSessionStore(admin);const credentials={editor:{authorization:''},reviewer:{authorization:''},viewer:{authorization:''}};
    for(const role of ['editor','reviewer','viewer'] as const){await installer.provisionMember({...scope,userId:role,role});const session=await issueSession({tenantId:scope.tenantId,userId:role,ttlSeconds:3600},installer);credentials[role]={authorization:`Bearer ${session.token}`};}
    const execution={connectionId:'fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture-original',evidence:'synthetic_replay' as const,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:2,tokens:200,costMicros:0}};
    await new PostgresBudgetLedger(admin).createProject({...scope,currency:'CNY',limits:{steps:20,tokens:2000,costMicros:0}},'fixture-installer');
    const store=new PostgresDevelopmentStore(data.pool);const catalog=new PostgresDevelopmentCatalog(data.pool);const durable=new PostgresDurableStore(tasks.pool);let calls=0;
    const worker=new DurableWorker(durable,{leaseMs:3000,runTimeoutMs:10000});worker.register(createDevelopmentStageWorkflow({store,ledger:new PostgresBudgetLedger(tasks.pool),sessionFor:sessionFactory(protocolTransport(()=>{calls++;}))}));
    const host=createDevelopmentHost({scope,workerId:'development-http-host',store,catalog,durable,worker,runsPerRound:20});
    const open=()=>createApplication({tenantId:scope.tenantId,store:new PostgresSessionStore(auth.pool),development:{store,catalog,briefs:new PostgresDevelopmentBriefCatalog(data.pool),tasks:durable,presetFor:projectId=>projectId===scope.projectId?{methods:developmentMethodPins(),execution,label:'合成协议验收'}:null}});
    app=await open();const base='/api/v1/projects/project/development';const brief={briefId:'idea',expectedRevision:0,idea:'修钟学徒收到未来的潮汐来信。',episodeCount:10,targetSeconds:120};
    expect((await app.inject({method:'POST',url:base+'/briefs',headers:credentials.viewer,payload:brief})).statusCode).toBe(403);
    const written=await app.inject({method:'POST',url:base+'/briefs',headers:credentials.editor,payload:brief});expect(written.statusCode,written.body).toBe(201);const original=written.json();expect(original.actorId).toBe('editor');expect(original.brief.revision).toBe(1);
    expect((await app.inject({method:'POST',url:base+'/briefs',headers:credentials.editor,payload:brief})).json()).toEqual(original);
    expect((await app.inject({url:base+'/briefs',headers:credentials.viewer})).json().items).toEqual([expect.objectContaining({briefId:'idea',revision:1,actorId:'editor'})]);
    const command={runId:'first',briefId:'idea',expectedRevision:1,expectedBriefDigest:original.brief.digest};expect((await app.inject({method:'POST',url:base,headers:credentials.reviewer,payload:command})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:base,headers:credentials.editor,payload:command})).statusCode).toBe(201);
    await host.round();const foundation=(await app.inject({url:base+'/first',headers:credentials.viewer})).json();expect(foundation.state).toBe('awaiting_review');expect(calls).toBe(1);expect(foundation.foundation.candidate).not.toHaveProperty('model');
    await app.close();app=await open();expect((await app.inject({url:base+'/first',headers:credentials.viewer})).json().foundation).toEqual(foundation.foundation);await host.round();expect(calls).toBe(1);
    const edited=structuredClone(foundation.foundation.candidate.output);edited.title='人工修改的潮汐来信';edited.characters[0].desire='用公开核对取代对未来来信的盲从。';const decision={candidateDigest:foundation.foundation.candidate.digest,output:edited};
    expect((await app.inject({method:'POST',url:base+'/first/foundation/confirm',headers:credentials.editor,payload:decision})).statusCode).toBe(403);
    const reviewed=await app.inject({method:'POST',url:base+'/first/foundation/confirm',headers:credentials.reviewer,payload:decision});expect(reviewed.statusCode,reviewed.body).toBe(201);expect(reviewed.json().foundation.review).toMatchObject({status:'reviewed',actorId:'reviewer',output:{title:edited.title}});
    await host.round();const episodes=(await app.inject({url:base+'/first',headers:credentials.viewer})).json();expect(episodes.stage).toBe('episodes');expect(episodes.episodes.candidate.output.episodes).toHaveLength(10);expect(calls).toBe(2);
    const episodeDecision={candidateDigest:episodes.episodes.candidate.digest,output:episodes.episodes.candidate.output};episodeDecision.output.episodes[0].title='人工编辑的第一集';
    const finished=await app.inject({method:'POST',url:base+'/first/episodes/confirm',headers:credentials.reviewer,payload:episodeDecision});expect(finished.statusCode,finished.body).toBe(201);expect(finished.json().state).toBe('reviewed');await host.round();expect(calls).toBe(2);
    expect((await new PostgresBudgetLedger(admin).project(scope)).used.tokens).toBe('200');
    expect((await app.inject({method:'POST',url:base,headers:credentials.editor,payload:{...command,runId:'second'}})).statusCode).toBe(201);await host.round();expect(calls).toBe(3);
    const second=(await app.inject({url:base+'/second',headers:credentials.viewer})).json();expect((await app.inject({method:'POST',url:base+'/briefs',headers:credentials.editor,payload:{...brief,expectedRevision:1,idea:'创意已修改，旧结果保持历史。'}})).statusCode).toBe(201);
    expect((await app.inject({url:base+'/second/status',headers:credentials.viewer})).json()).toMatchObject({state:'stale',sourceChanged:true});
    expect((await app.inject({method:'POST',url:base+'/second/foundation/confirm',headers:credentials.reviewer,payload:{candidateDigest:second.foundation.candidate.digest,output:second.foundation.candidate.output}})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:base+'/second/foundation/reject',headers:credentials.reviewer,payload:{reason:'创意已变化，请重做。'}})).statusCode).toBe(201);
    expect((await app.inject({url:base+'/briefs/idea?revision=1',headers:credentials.viewer})).json().brief.digest).toBe(original.brief.digest);
    expect((await app.inject({url:base+'?briefId=idea',headers:credentials.viewer})).json().items).toHaveLength(2);
    await installer.provisionMember({...scope,userId:'editor',role:'viewer'});expect((await app.inject({method:'POST',url:base,headers:credentials.editor,payload:{...command,runId:'third'}})).statusCode).toBe(403);
    expect((await app.inject({url:base.replace('/project/','/other/'),headers:credentials.viewer})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/sign-out',headers:credentials.viewer})).statusCode).toBe(204);expect((await app.inject({url:base,headers:credentials.viewer})).statusCode).toBe(401);
  }finally{
    const ok=await releaseResources([()=>app?.close(),...roles.map(role=>()=>role.pool.end()),
      ...['reviews','candidates','runs','briefs'].map(table=>()=>admin.query(`DELETE FROM camery_script.${table} WHERE tenant_id=$1`,[scope.tenantId])),
      ...['budget_events','budget_allocations','budget_projects'].map(table=>()=>admin.query(`DELETE FROM camery_agents.${table} WHERE tenant_id=$1`,[scope.tenantId])),
      ...['events','signals','steps','tasks'].map(table=>()=>admin.query(`DELETE FROM camery_durable.${table} WHERE tenant_id=$1`,[scope.tenantId])),
      ...['sessions','memberships','users'].map(table=>()=>admin.query(`DELETE FROM camery_access.${table} WHERE tenant_id=$1`,[scope.tenantId])),
      ...roles.flatMap(role=>[()=>admin.query(`DROP OWNED BY ${role.role}`),()=>admin.query(`DROP ROLE ${role.role}`)]),()=>admin.end()]);
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Report incomplete cleanup after attempting every owned resource.
    if(!ok)throw new Error('Development HTTP fixture cleanup failed');
  }
});
