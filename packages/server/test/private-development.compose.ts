import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {issueSession} from '@camery/access';
import {migrateAccess,PostgresSessionStore} from '@camery/access/node';
import {migrateAgents,PostgresBudgetLedger} from '@camery/agents/node';
import {migrateDurable,PostgresDurableStore} from '@camery/durable';
import {migrateDevelopment,PostgresDevelopmentStore,grantDevelopmentRuntimeRole,developmentStageTaskId} from '@camery/script/node';
import type {DevelopmentRunView,DevelopmentBriefView} from '@camery/script/http';
import {foundationFixture} from '../../script/test/foundation-fixture.js';
import {episodeFixture} from '../../script/test/episode-fixture.js';
import {grantDevelopmentTaskRuntimeRole} from '../src/development-task-role.js';
import {releaseResources} from '../src/shutdown.js';
import {docker} from './fixtures/compose-probe.js';
const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for private development tests');
it('runs the built API and scoped development worker with independent secrets, real HTTP fixture calls and restart recovery',async()=>{
  const admin=new Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000});const suffix=randomBytes(10).toString('hex');const project='camery-development-smoke-'+suffix;
  const scope={tenantId:'development-container-'+randomUUID(),projectId:'project'};const directory=await mkdtemp(join(tmpdir(),'camery-development-smoke-'));
  const files=['auth-url','data-url','task-url','text-config','text-token','model-server.mjs','network.json'].map(name=>join(directory,name));const [authFile,dataFile,taskFile,textFile,tokenFile,modelFile,networkFile]=files as [string,string,string,string,string,string,string];
  const compose=['compose','--project-name',project,'--env-file','deploy/.env.phase0','-f','deploy/compose.private.yml','-f','deploy/compose.api.yml','-f','deploy/compose.development.yml','-f','deploy/compose.development-text.yml','-f',networkFile];
  const env={...process.env,CAMERY_TENANT_ID:scope.tenantId,CAMERY_API_PORT:'0',CAMERY_SOURCE_IMPORTS:'0',CAMERY_API_DATABASE_SECRET_FILE:authFile,CAMERY_DEVELOPMENT_PROJECT_ID:scope.projectId,CAMERY_DEVELOPMENT_DATABASE_SECRET_FILE:dataFile,CAMERY_DEVELOPMENT_TASK_DATABASE_SECRET_FILE:taskFile,CAMERY_DEVELOPMENT_TEXT_CONFIG_SECRET_FILE:textFile,CAMERY_DEVELOPMENT_TEXT_TOKEN_SECRET_FILE:tokenFile,CAMERY_DEVELOPMENT_POLL_MS:'50'};
  const roles:{name:string;password:string;url:string}[]=[];let attempted=false;let initialized=false;
  async function role(prefix:string){const name=prefix+'_'+suffix;const password=randomBytes(24).toString('hex');await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);const url=new URL(databaseUrl!);url.hostname='postgres';url.port='5432';url.username=name;url.password=password;const value={name,password,url:url.toString()};roles.push(value);return value;}
  try{
    await docker(['network','inspect','camery-phase0_default','--format','{{.Name}}']);await migrateAccess(admin);await migrateDurable(admin);await migrateAgents(admin);await migrateDevelopment(admin);initialized=true;
    const auth=await role('development_auth');const data=await role('development_data');const tasks=await role('development_tasks');
    await admin.query(`GRANT USAGE ON SCHEMA camery_access TO ${auth.name}`);await admin.query(`GRANT SELECT ON camery_access.users,camery_access.memberships,camery_access.sessions TO ${auth.name}`);await admin.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO ${auth.name}`);
    await grantDevelopmentRuntimeRole(admin,data.name);await grantDevelopmentTaskRuntimeRole(admin,tasks.name);
    const installer=new PostgresSessionStore(admin);await installer.provisionMember({...scope,userId:'human',role:'admin'});const session=await issueSession({tenantId:scope.tenantId,userId:'human',ttlSeconds:3600},installer);
    await new PostgresBudgetLedger(admin).createProject({...scope,currency:'CNY',limits:{steps:20,tokens:1000,costMicros:1000}},'container-fixture-installer');
    const durable=new PostgresDurableStore(admin);await durable.enqueue({tenantId:scope.tenantId,taskId:'unrelated-sentinel',workflow:'not-registered',version:1,input:null,maxAttempts:1,availableAt:new Date('2025-01-01T00:00:00Z')});
    const token='fixture-text-'+randomBytes(20).toString('hex');const privateMarker='private-idea-'+randomBytes(12).toString('hex');
    const text={label:'合成HTTP协议夹具，不是真实模型质量',baseUrl:'http://model-fixture:9000/v1',connectionId:'container-fixture',modelIdentity:'fixture-original',structuredOutput:'json_schema',timeoutMs:3000,allowPrivateNetworks:true,allowInsecureHttp:true,currency:'CNY',reservation:{tokens:100,costMicros:10},limits:{steps:2,tokens:200,costMicros:20}};
    // Synthetic protocol server lives on the owned container network. Only its count endpoint is mapped to loopback for assertions.
    const modelSource=`import {createServer} from 'node:http';const foundation=${JSON.stringify(foundationFixture())};const episodes=${JSON.stringify(episodeFixture().output)};let calls=0;let foundationTitle=null;createServer((req,res)=>{void(async()=>{res.setHeader('content-type','application/json');if(req.url==='/stats'){res.end(JSON.stringify({calls,foundationTitle}));return;}if(req.url!=='/v1/chat/completions'||req.headers.authorization!==${JSON.stringify('Bearer '+token)}){res.statusCode=403;res.end('{}');return;}const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());const source=JSON.parse(body.messages.at(-1).content).untrustedSource;calls++;if(source.foundation)foundationTitle=source.foundation.title;res.end(JSON.stringify({id:'fixture-'+calls,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(source.foundation?episodes:foundation)}}],usage:{prompt_tokens:50,completion_tokens:30}}));})().catch(()=>{res.statusCode=500;res.end('{}');});}).listen(9000,'0.0.0.0');`;
    const network={services:{'development-worker':{restart:'no'},'model-fixture':{image:'camery-api:phase0',command:['node','/run/secrets/model-server.mjs'],init:true,read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],ports:['127.0.0.1::9000'],volumes:[{type:'bind',source:modelFile,target:'/run/secrets/model-server.mjs',read_only:true}]}},networks:{default:{external:true,name:'camery-phase0_default'}}};
    await Promise.all([writeFile(authFile,auth.url+'\n',{mode:0o444}),writeFile(dataFile,data.url+'\n',{mode:0o444}),writeFile(taskFile,tasks.url+'\n',{mode:0o444}),writeFile(textFile,JSON.stringify(text),{mode:0o444}),writeFile(tokenFile,token+'\n',{mode:0o444}),writeFile(modelFile,modelSource,{mode:0o444}),writeFile(networkFile,JSON.stringify(network),{mode:0o600})]);
    await docker([...compose,'config','--quiet'],env);attempted=true;await docker([...compose,'up','--no-deps','--no-build','--pull','never','-d','model-fixture'],env);
    const modelPort=await docker([...compose,'port','model-fixture','9000'],env);expect(modelPort).toMatch(/^127\.0\.0\.1:\d+$/);const stats=async()=>await(await fetch('http://'+modelPort+'/stats',{signal:AbortSignal.timeout(3000)})).json() as {calls:number;foundationTitle:string|null};
    await vi.waitFor(async()=>expect((await stats()).calls).toBe(0),{timeout:10000,interval:100});
    await docker([...compose,'up','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','50','-d','api','development-worker'],env);
    let address='http://'+await docker([...compose,'port','api','3000'],env);const headers={authorization:`Bearer ${session.token}`};const base='/api/v1/projects/project/development';
    const request=(path:string,body?:unknown)=>fetch(address+path,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{...headers,'content-type':'application/json'},signal:AbortSignal.timeout(5000)});
    expect((await request(base+'/capabilities')).status).toBe(200);const saved=await request(base+'/briefs',{briefId:'idea',expectedRevision:0,idea:privateMarker,episodeCount:10,targetSeconds:120});expect(saved.status).toBe(201);const brief=await saved.json() as DevelopmentBriefView;
    const start=await request(base,{runId:'first',briefId:'idea',expectedRevision:1,expectedBriefDigest:brief.brief.digest});expect(start.status).toBe(201);
    let view:DevelopmentRunView|undefined;await vi.waitFor(async()=>{view=await(await request(base+'/first')).json() as DevelopmentRunView;expect(view.state).toBe('awaiting_review');expect(view.foundation.candidate).not.toBeNull();},{timeout:20000,interval:100});expect((await stats()).calls).toBe(1);
    const container=await docker([...compose,'ps','--quiet','development-worker'],env);expect(await docker(['inspect','--format','{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{json .HostConfig.CapDrop}}',container])).toMatch(/^(?:node|1000(?::1000)?) true false \["ALL"\]$/);
    await docker([...compose,'kill','--signal','SIGKILL','development-worker'],env);expect(await docker(['inspect','--format','{{.State.ExitCode}}',container])).toBe('137');await docker([...compose,'up','--no-deps','--no-build','--pull','never','-d','development-worker'],env);
    const edited=structuredClone(view!.foundation.candidate!.output);edited.title='容器验收中的人工设定';const confirm=await request(base+'/first/foundation/confirm',{candidateDigest:view!.foundation.candidate!.digest,output:edited});expect(confirm.status).toBe(201);
    await vi.waitFor(async()=>{view=await(await request(base+'/first')).json() as DevelopmentRunView;expect(view.episodes.candidate?.output.episodes).toHaveLength(10);expect(view.state).toBe('awaiting_review');},{timeout:20000,interval:100});expect(await stats()).toEqual({calls:2,foundationTitle:edited.title});
    const finish=await request(base+'/first/episodes/confirm',{candidateDigest:view!.episodes.candidate!.digest,output:view!.episodes.candidate!.output});expect(finish.status).toBe(201);expect((await finish.json() as DevelopmentRunView).state).toBe('reviewed');
    const developmentStore=new PostgresDevelopmentStore(admin);const original=await developmentStore.read({...scope,runId:'first'});
    const redoCommand={runId:'episodes-redo',expectedSourceRunDigest:original.run.digest,expectedBriefDigest:original.run.brief.digest,expectedFoundationReviewDigest:original.foundation.review!.digest};
    const redo=await request(base+'/first/redo/episodes',redoCommand);expect(redo.status).toBe(201);
    // The inherited foundation keeps its original evidence; only the new episodes task calls the current HTTP fixture.
    await vi.waitFor(async()=>{view=await(await request(base+'/episodes-redo')).json() as DevelopmentRunView;expect(view.episodes.candidate?.output.episodes).toHaveLength(10);expect(view.state).toBe('awaiting_review');},{timeout:20000,interval:100});
    expect(await stats()).toEqual({calls:3,foundationTitle:edited.title});expect(view!.budget).toEqual({currency:'CNY',tokens:100,costMicros:10});
    const childKey={...scope,runId:'episodes-redo'};const inherited=await developmentStore.read(childKey);expect(inherited.foundation).toEqual(original.foundation);
    expect(inherited.run.execution.limits).toEqual({steps:1,tokens:100,costMicros:10});expect(await durable.get({tenantId:scope.tenantId,taskId:developmentStageTaskId(childKey,'foundation')})).toBeNull();
    expect(await durable.get({tenantId:scope.tenantId,taskId:developmentStageTaskId(childKey,'episodes')})).toMatchObject({workflow:'original.development-stage',version:2,status:'succeeded'});
    expect((await admin.query('SELECT count(*)::int n FROM camery_agents.budget_allocations WHERE tenant_id=$1',[scope.tenantId])).rows[0]?.n).toBe(3);
    expect((await developmentStore.read({...scope,runId:'first'}))).toEqual(original);
    const redoFinish=await request(base+'/episodes-redo/episodes/confirm',{candidateDigest:view!.episodes.candidate!.digest,output:view!.episodes.candidate!.output});expect(redoFinish.status).toBe(201);expect((await redoFinish.json() as DevelopmentRunView).state).toBe('reviewed');
    await docker([...compose,'restart','api'],env);await docker([...compose,'up','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','50','-d','api'],env);address='http://'+await docker([...compose,'port','api','3000'],env);
    expect((await(await request(base+'/first')).json() as DevelopmentRunView).foundation.review).toMatchObject({status:'reviewed',actorId:'human',output:{title:edited.title}});expect((await stats()).calls).toBe(3);
    expect((await(await request(base+'/episodes-redo')).json() as DevelopmentRunView).foundation).toEqual(view!.foundation);
    expect((await durable.get({tenantId:scope.tenantId,taskId:'unrelated-sentinel'}))).toMatchObject({status:'queued',attempts:0});expect((await new PostgresBudgetLedger(admin).project(scope)).used.tokens).toBe('300');
    const stored=await new PostgresDevelopmentStore(admin).read({...scope,runId:'first'});expect(stored.foundation.candidate?.model).toMatchObject({evidence:'live_model',providerRequestId:'fixture-1'});expect(stored.episodes.candidate?.upstreamDigest).toBe(stored.foundation.review!.digest);
    expect((await request('/api/v1/auth/sign-out',{})).status).toBe(204);expect((await request(base)).status).toBe(401);
    const logs=await docker([...compose,'logs','--no-color','api','development-worker'],env);for(const secret of [token,session.token,privateMarker,...roles.flatMap(value=>[value.password,value.url])])expect(logs).not.toContain(secret);
    await docker([...compose,'stop','--timeout','15','development-worker','api'],env);expect(await docker(['inspect','--format','{{.State.ExitCode}}',container])).toBe('0');
  }finally{
    const ok=await releaseResources([()=>attempted?docker([...compose,'down','--volumes','--timeout','15'],env):undefined,
      ...['run_origins','reviews','candidates','runs','briefs'].map(table=>()=>initialized?admin.query(`DELETE FROM camery_script.${table} WHERE tenant_id=$1`,[scope.tenantId]):undefined),
      ...['budget_events','budget_allocations','budget_projects'].map(table=>()=>initialized?admin.query(`DELETE FROM camery_agents.${table} WHERE tenant_id=$1`,[scope.tenantId]):undefined),
      ...['events','signals','steps','tasks'].map(table=>()=>initialized?admin.query(`DELETE FROM camery_durable.${table} WHERE tenant_id=$1`,[scope.tenantId]):undefined),
      ...['sessions','memberships','users'].map(table=>()=>initialized?admin.query(`DELETE FROM camery_access.${table} WHERE tenant_id=$1`,[scope.tenantId]):undefined),
      ...roles.flatMap(value=>[()=>admin.query(`DROP OWNED BY ${value.name}`),()=>admin.query(`DROP ROLE ${value.name}`)]),()=>admin.end(),...files.map(file=>()=>rm(file,{force:true})),()=>rmdir(directory)]);
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Cleanup must report owned containers, principals or secret files left behind.
    if(!ok)throw new Error('Private development fixture cleanup failed');
  }
});
