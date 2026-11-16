import { randomBytes,randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect,it } from 'vitest';
import { issueSession } from '@camery/access';
import { migrateAccess,PostgresSessionStore,verifyRuntimeRole } from '@camery/access/node';
import { migrateIngest,PostgresDocumentStore } from '@camery/ingest/node';
import { importNovel } from '@camery/ingest';
import { createStoryBibleMethodPack } from '@camery/bible';
import { migrateBible,PostgresBibleStore,PostgresBibleCatalog,verifyBibleRuntimeRole,createBibleChunkWorkflow } from '@camery/bible/node';
import { MethodRegistry } from '@camery/methods';
import { migrateDurable,PostgresDurableStore,DurableWorker } from '@camery/durable';
import { migrateAgents,PostgresBudgetLedger } from '@camery/agents/node';
import { protocolTransport,sessionFactory } from '../../bible/test/workflow-pg-support.js';
import { grantBibleTaskRuntimeRole,verifyBibleTaskRuntimeRole } from '../src/bible-task-role.js';
import { createBibleHost } from '../src/bible-host.js';
import { createApplication } from '../src/app.js';
import { releaseResources } from '../src/shutdown.js';
const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];
if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for Bible HTTP integration');

it('authenticates persisted ten-chapter research, explicit review, frozen citations and source/revocation gates',async()=>{
  const admin=new Pool({connectionString:databaseUrl});const scope={tenantId:`bible-http-${randomUUID()}`,projectId:'project'};
  const roles:{role:string;pool:Pool}[]=[];let app:Awaited<ReturnType<typeof createApplication>>|undefined;
  async function login(prefix:string){
    const role=`${prefix}_${randomBytes(8).toString('hex')}`;const password=randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);
    const url=new URL(databaseUrl!);url.username=role;url.password=password;const result={role,pool:new Pool({connectionString:url.toString(),max:4})};roles.push(result);return result;
  }
  try{
    await migrateAccess(admin);await migrateIngest(admin);await migrateDurable(admin);await migrateAgents(admin);await migrateBible(admin);
    const auth=await login('bible_http_auth');const knowledge=await login('bible_http_data');const tasks=await login('bible_http_tasks');
    await admin.query(`GRANT USAGE ON SCHEMA camery_access TO ${auth.role}`);
    await admin.query(`GRANT SELECT ON camery_access.users,camery_access.memberships,camery_access.sessions TO ${auth.role}`);await admin.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO ${auth.role}`);
    await admin.query(`GRANT USAGE ON SCHEMA camery_bible,camery_ingest TO ${knowledge.role}`);await admin.query(`GRANT SELECT ON camery_ingest.documents,camery_ingest.scripts TO ${knowledge.role}`);
    await admin.query(`GRANT SELECT,INSERT ON camery_bible.runs,camery_bible.chunks,camery_bible.candidates,camery_bible.reviews TO ${knowledge.role}`);
    await grantBibleTaskRuntimeRole(admin,tasks.role);await verifyRuntimeRole(auth.pool);await verifyBibleRuntimeRole(knowledge.pool);await verifyBibleTaskRuntimeRole(tasks.pool);
    const installer=new PostgresSessionStore(admin);const credentials={editor:{authorization:''},reviewer:{authorization:''},viewer:{authorization:''}};
    for(const role of ['editor','reviewer','viewer'] as const){await installer.provisionMember({...scope,userId:role,role});const session=await issueSession({tenantId:scope.tenantId,userId:role,ttlSeconds:3600},installer);credentials[role]={authorization:`Bearer ${session.token}`};}
    const source=new PostgresDocumentStore(admin);const text=Array.from({length:10},(_,index)=>`第${index+1}章 来信\n小林来到车站。${'他读着来信。'.repeat(260)}\n`).join('');
    await source.append({...scope,documentId:'book',batchId:'first',text,expectedRevision:0});
    const method=new MethodRegistry().register(createStoryBibleMethodPack());
    const execution={connectionId:'fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture-text',evidence:'synthetic_replay' as const,modelTier:'economy' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:100,tokens:10000,costMicros:0}};
    await new PostgresBudgetLedger(admin).createProject({...scope,currency:'CNY',limits:execution.limits},'fixture-installer');
    const store=new PostgresBibleStore(knowledge.pool);const catalog=new PostgresBibleCatalog(knowledge.pool);const durable=new PostgresDurableStore(tasks.pool);let calls=0;
    const open=()=>createApplication({tenantId:scope.tenantId,store:new PostgresSessionStore(auth.pool),bibles:{store,catalog,tasks:durable,presetFor:projectId=>projectId===scope.projectId?{method,execution,label:'合成协议验收'}:null}});
    app=await open();const base='/api/v1/projects/project/bibles';const command={runId:'first',documentId:'book',kind:'novel',expectedRevision:1,expectedSourceDigest:importNovel(text).sourceDigest};
    expect((await app.inject({method:'POST',url:base,headers:credentials['reviewer'],payload:command})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:base,headers:credentials['editor'],payload:command})).statusCode).toBe(201);
    const worker=new DurableWorker(durable,{leaseMs:3000,runTimeoutMs:10000});worker.register(createBibleChunkWorkflow({store,ledger:new PostgresBudgetLedger(tasks.pool),sessionFor:sessionFactory(protocolTransport(()=>{calls++;}))}));
    const host=createBibleHost({scope,workerId:'fixture-host',store,catalog,durable,worker});
    for(let round=0;round<8;round++){await host.round();if((await store.read({...scope,runId:'first'})).candidate)break;}
    const progress=await store.read({...scope,runId:'first'});expect(progress.candidate).not.toBeNull();expect(progress.run.plan.chunks.length).toBeGreaterThan(1);expect(calls).toBe(progress.run.plan.chunks.length);
    const detail=(await app.inject({url:base+'/first',headers:credentials['viewer']})).json();expect(detail.state).toBe('ready');expect(detail.candidate).not.toHaveProperty('records');
    const pinned=(await app.inject({url:base+'/first/source?offset=0',headers:credentials['viewer']})).json();expect(pinned.excerpt.text).toBe(text.slice(0,pinned.excerpt.end));
    const candidate=progress.candidate!;const decision={candidateDigest:candidate.digest,groups:[{id:'lin',name:'小林',memberIds:candidate.entities.map(entity=>entity.id)}],rejectedEntityIds:[],selectedRelationIds:[],selectedClaimIds:[]};
    expect((await app.inject({method:'POST',url:base+'/first/confirm',headers:credentials['editor'],payload:decision})).statusCode).toBe(403);
    const confirmed=await app.inject({method:'POST',url:base+'/first/confirm',headers:credentials['reviewer'],payload:decision});expect(confirmed.statusCode).toBe(201);expect(confirmed.json().review.actorId).toBe('reviewer');
    await app.close();app=await open();expect((await app.inject({url:base+'/first',headers:credentials['viewer']})).json().review.decision).toEqual(decision);
    const paidCalls=calls;await host.round();expect(calls).toBe(paidCalls);
    expect((await app.inject({method:'POST',url:base,headers:credentials['editor'],payload:{...command,runId:'second'}})).statusCode).toBe(201);
    for(let round=0;round<8;round++){await host.round();if((await store.read({...scope,runId:'second'})).candidate)break;}
    const second=(await store.read({...scope,runId:'second'})).candidate!;expect(second).toBeTruthy();
    await source.append({...scope,documentId:'book',batchId:'next',text:'第十一章 新来的人。',expectedRevision:1});
    expect((await app.inject({url:base+'/second/status',headers:credentials['viewer']})).json().state).toBe('stale');
    expect((await app.inject({method:'POST',url:base+'/second/confirm',headers:credentials['reviewer'],payload:{...decision,candidateDigest:second.digest}})).statusCode).toBe(409);
    const old=(await app.inject({url:base+'/second/source?offset=0',headers:credentials['viewer']})).json();expect(old.sourceDigest).toBe(importNovel(text).sourceDigest);
    expect((await app.inject({method:'POST',url:base+'/second/reject',headers:credentials['reviewer'],payload:{reason:'来源已增加，请重新提取。'}})).json().review.status).toBe('rejected');
    await installer.provisionMember({...scope,userId:'editor',role:'viewer'});expect((await app.inject({method:'POST',url:base,headers:credentials['editor'],payload:{...command,runId:'third'}})).statusCode).toBe(403);
    expect((await app.inject({url:base.replace('/project/','/other/'),headers:credentials['viewer']})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/sign-out',headers:credentials['viewer']})).statusCode).toBe(204);expect((await app.inject({url:base,headers:credentials['viewer']})).statusCode).toBe(401);
  }finally{
    const ok=await releaseResources([()=>app?.close(),...roles.map(role=>()=>role.pool.end()),
      ...['reviews','candidates','chunks','runs'].map(table=>()=>admin.query(`DELETE FROM camery_bible.${table} WHERE tenant_id=$1`,[scope.tenantId])),
      ()=>admin.query('DELETE FROM camery_ingest.documents WHERE tenant_id=$1',[scope.tenantId]),
      ...['budget_events','budget_allocations','budget_projects'].map(table=>()=>admin.query(`DELETE FROM camery_agents.${table} WHERE tenant_id=$1`,[scope.tenantId])),
      ...['events','signals','steps','tasks'].map(table=>()=>admin.query(`DELETE FROM camery_durable.${table} WHERE tenant_id=$1`,[scope.tenantId])),
      ...['sessions','memberships','users'].map(table=>()=>admin.query(`DELETE FROM camery_access.${table} WHERE tenant_id=$1`,[scope.tenantId])),
      ...roles.flatMap(role=>[()=>admin.query(`DROP OWNED BY ${role.role}`),()=>admin.query(`DROP ROLE ${role.role}`)]),()=>admin.end()]);
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Do not hide leaked test principals or partial cleanup.
    if(!ok)throw new Error('Bible HTTP fixture cleanup failed');
  }
});
