import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import type {PoolClient} from 'pg';
import {expect,it,vi} from 'vitest';
import {issueSession} from '@camery/access';
import {migrateAccess,PostgresSessionStore,verifyRuntimeRole} from '@camery/access/node';
import {migrateAgents,PostgresBudgetLedger} from '@camery/agents/node';
import {migrateDurable,PostgresDurableStore} from '@camery/durable';
import {migrateIngest} from '@camery/ingest/node';
import {migrateBible} from '@camery/bible/node';
import {migrateDevelopment} from '@camery/script/node';
import {migrateOutline,PostgresOutlineStore,grantOutlineRuntimeRole,verifyOutlineRuntimeRole,outlineTaskId} from '@camery/script/outline/node';
import type {OutlineBriefView,OutlineRunView,OutlineSourceList} from '@camery/script/outline/http';
import {createDevelopmentSourceFixture} from '../../script/test/outline-source-pg-support.js';
import {outlineFixture} from '../../script/test/outline-support.js';
import {grantOutlineTaskRuntimeRole,verifyOutlineTaskRuntimeRole} from '../src/outline-task-role.js';
import {releaseResources} from '../src/shutdown.js';
import {docker} from './fixtures/compose-probe.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for private outline tests');
it('restores an actually committed outline decision in a built no-text worker after an owned SIGKILL',async()=>{
  const admin=new Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000}),suffix=randomBytes(10).toString('hex'),project='camery-outline-smoke-'+suffix;
  const scope={tenantId:'outline-container-'+randomUUID(),projectId:'project'},key={...scope,runId:'first'};
  const directory=await mkdtemp(join(tmpdir(),'camery-outline-smoke-'));
  const files=['auth-url','data-url','task-url','text-config','text-token','model-server.mjs','network.json','worker-override.json'].map(name=>join(directory,name));
  const [authFile,dataFile,taskFile,textFile,tokenFile,modelFile,networkFile,workerOverrideFile]=files as [string,string,string,string,string,string,string,string];
  const baseCompose=['compose','--project-name',project,'--env-file','deploy/.env.phase0','-f','deploy/compose.private.yml','-f','deploy/compose.api.yml'];
  const offCompose=[...baseCompose,'-f',networkFile];
  const noTextCompose=[...baseCompose,'-f','deploy/compose.outline.yml','-f',networkFile,'-f',workerOverrideFile];
  const textCompose=[...baseCompose,'-f','deploy/compose.outline.yml','-f','deploy/compose.outline-text.yml','-f',networkFile,'-f',workerOverrideFile];
  const env={...process.env,CAMERY_TENANT_ID:scope.tenantId,CAMERY_API_PORT:'0',CAMERY_SOURCE_IMPORTS:'0',CAMERY_API_DATABASE_SECRET_FILE:authFile,
    CAMERY_OUTLINE_PROJECT_ID:scope.projectId,CAMERY_OUTLINE_DATABASE_SECRET_FILE:dataFile,CAMERY_OUTLINE_TASK_DATABASE_SECRET_FILE:taskFile,
    CAMERY_OUTLINE_TEXT_CONFIG_SECRET_FILE:textFile,CAMERY_OUTLINE_TEXT_TOKEN_SECRET_FILE:tokenFile,CAMERY_OUTLINE_POLL_MS:'50'};
  const roles:{name:string;password:string;url:string}[]=[];let attempted=false,initialized=false,barrierActive=false;let barrier:PoolClient|undefined;
  async function role(prefix:string){
    const name=prefix+'_'+suffix,password=randomBytes(24).toString('hex');await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);
    const url=new URL(databaseUrl!);url.hostname='postgres';url.port='5432';url.username=name;url.password=password;const value={name,password,url:url.href};roles.push(value);return value;
  }
  async function verifyLogin(identity:{name:string;password:string},verify:(pool:Pool)=>Promise<void>){
    const url=new URL(databaseUrl!);url.username=identity.name;url.password=identity.password;const pool=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000});
    try{await verify(pool);}finally{await pool.end();}
  }
  async function releaseBarrier(){
    const client=barrier;barrier=undefined;if(!client)return;let broken=false;
    try{if(barrierActive)await client.query('ROLLBACK');}catch{broken=true;throw new Error('Owned outline candidate barrier rollback failed');}
    finally{barrierActive=false;client.release(broken);}
  }
  try{
    await docker(['network','inspect','camery-phase0_default','--format','{{.Name}}']);await migrateAccess(admin);await migrateDurable(admin);await migrateAgents(admin);await migrateIngest(admin);await migrateBible(admin);await migrateDevelopment(admin);await migrateOutline(admin);initialized=true;
    const source=await createDevelopmentSourceFixture(admin,scope),auth=await role('outline_auth'),data=await role('outline_data'),tasks=await role('outline_tasks');
    await admin.query(`GRANT USAGE ON SCHEMA camery_access TO ${auth.name}`);await admin.query(`GRANT SELECT ON camery_access.users,camery_access.memberships,camery_access.sessions TO ${auth.name}`);await admin.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO ${auth.name}`);
    await grantOutlineRuntimeRole(admin,data.name);await grantOutlineTaskRuntimeRole(admin,tasks.name);await verifyLogin(auth,verifyRuntimeRole);await verifyLogin(data,verifyOutlineRuntimeRole);await verifyLogin(tasks,verifyOutlineTaskRuntimeRole);
    const installer=new PostgresSessionStore(admin);await installer.provisionMember({...scope,userId:'human',role:'admin'});const session=await issueSession({tenantId:scope.tenantId,userId:'human',ttlSeconds:3600},installer);
    await new PostgresBudgetLedger(admin).createProject({...scope,currency:'CNY',limits:{steps:5,tokens:1500,costMicros:50}},'container-fixture-installer');
    const durable=new PostgresDurableStore(admin);await durable.enqueue({tenantId:scope.tenantId,taskId:'unrelated-sentinel',workflow:'not-registered',version:1,input:null,maxAttempts:1,availableAt:new Date('2025-01-01T00:00:00Z')});
    const token='fixture-outline-'+randomBytes(20).toString('hex'),privateMarker='private-outline-'+randomBytes(12).toString('hex');
    const text={label:'合成HTTP协议夹具，非真实模型质量',baseUrl:'http://model-fixture:9000/v1',connectionId:'container-outline',modelIdentity:'fixture-outline',structuredOutput:'json_schema',timeoutMs:3000,allowPrivateNetworks:true,allowInsecureHttp:true,currency:'CNY',reservation:{tokens:300,costMicros:10},limits:{steps:1,tokens:300,costMicros:10}};
    const template=outlineFixture().output,asset=template.assets[0]!,decision=template.adaptation.decisions[0]!;
    template.assets=Array.from({length:128},(_,index)=>({...structuredClone(asset),id:'asset-'+index,description:'d'.repeat(1000),narrativeRole:'r'.repeat(1000)}));
    template.adaptation.decisions=Array.from({length:128},(_,index)=>({...structuredClone(decision),id:'decision-'+index,reason:'r'.repeat(1000)}));
    // Only this owned synthetic server produces protocol replies. Actual ModelSession receipts and SQL journals remain authoritative.
    const modelSource=`import {createServer} from 'node:http';const template=${JSON.stringify(template)};let calls=0;createServer((req,res)=>{void(async()=>{res.setHeader('content-type','application/json');if(req.url==='/stats'){res.end(JSON.stringify({calls}));return;}if(req.url!=='/v1/chat/completions'||req.headers.authorization!==${JSON.stringify('Bearer '+token)}){res.statusCode=403;res.end('{}');return;}const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());const input=JSON.parse(body.messages.at(-1).content).untrustedSource;const ref=input.source.references[0].id;const output=structuredClone(template);for(const item of output.adaptation.decisions)item.sourceRefIds=item.action==='invent'?[]:[ref];for(const item of [...output.characters,...output.beats,...output.assets])item.origin.sourceRefIds=item.origin.kind==='invented'?[]:[ref];calls++;res.end(JSON.stringify({id:'fixture-outline-'+calls,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:150,completion_tokens:80}}));})().catch(()=>{res.statusCode=500;res.end('{}');});}).listen(9000,'0.0.0.0');`;
    const network={services:{'model-fixture':{image:'camery-api:phase0',command:['node','/run/secrets/model-server.mjs'],init:true,read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],ports:['127.0.0.1::9000'],volumes:[{type:'bind',source:modelFile,target:'/run/secrets/model-server.mjs',read_only:true}]}},networks:{default:{external:true,name:'camery-phase0_default'}}};
    await Promise.all([writeFile(authFile,auth.url+'\n',{mode:0o444}),writeFile(dataFile,data.url+'\n',{mode:0o444}),writeFile(taskFile,tasks.url+'\n',{mode:0o444}),writeFile(textFile,JSON.stringify(text),{mode:0o444}),writeFile(tokenFile,token+'\n',{mode:0o444}),writeFile(modelFile,modelSource,{mode:0o444}),writeFile(networkFile,JSON.stringify(network),{mode:0o600}),writeFile(workerOverrideFile,JSON.stringify({services:{'outline-worker':{restart:'no'}}}),{mode:0o600})]);
    await docker([...offCompose,'config','--quiet'],env);await docker([...textCompose,'config','--quiet'],env);await docker([...noTextCompose,'config','--quiet'],env);attempted=true;
    await docker([...offCompose,'up','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','50','-d','api'],env);
    let address='http://'+await docker([...offCompose,'port','api','3000'],env);const headers={authorization:'Bearer '+session.token},base='/api/v1/projects/project/outlines';
    const request=(path:string,body?:unknown)=>fetch(address+path,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{...headers,'content-type':'application/json'},signal:AbortSignal.timeout(5000)});
    expect((await request(base+'/capabilities')).status).toBe(404);await docker([...offCompose,'stop','--timeout','15','api'],env);
    await docker([...textCompose,'up','--no-deps','--no-build','--pull','never','-d','model-fixture'],env);
    const modelPort=await docker([...textCompose,'port','model-fixture','9000'],env);expect(modelPort).toMatch(/^127\.0\.0\.1:\d+$/);const stats=async()=>await(await fetch('http://'+modelPort+'/stats',{signal:AbortSignal.timeout(3000)})).json() as {calls:number};
    await vi.waitFor(async()=>expect((await stats()).calls).toBe(0),{timeout:10000,interval:100});
    await docker([...textCompose,'up','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','50','-d','api'],env);address='http://'+await docker([...textCompose,'port','api','3000'],env);
    expect((await(await request(base+'/capabilities')).json() as {canStart:boolean}).canStart).toBe(true);
    const selected=await(await request(base+'/sources?kind=development')).json() as OutlineSourceList;expect(selected.items).toHaveLength(1);expect(selected.items[0]!.source.runDigest).toBe(source.run.digest);
    const saved=await request(base+'/briefs',{briefId:'adaptation',expectedRevision:0,notes:privateMarker,episodeCount:3,targetSeconds:90,paidEpisodeNumbers:[3],mainGenre:'rebirth-revenge',auxiliaryGenres:['suspense']});expect(saved.status).toBe(201);const brief=await saved.json() as OutlineBriefView;
    const command={runId:key.runId,briefId:brief.brief.briefId,expectedRevision:1,expectedBriefDigest:brief.brief.digest,source:selected.items[0]!.source};expect((await request(base,command)).status).toBe(201);expect((await request(base+'/first/status')).status).toBe(200);expect((await stats()).calls).toBe(0);
    const store=new PostgresOutlineStore(admin),before=await store.read(key),taskKey={tenantId:scope.tenantId,taskId:outlineTaskId(key)};
    // An uncommitted row on this test's sole PK blocks only its eventual candidate INSERT; SELECT and model preflight see no candidate.
    barrier=await admin.connect();await barrier.query('BEGIN');barrierActive=true;
    await barrier.query('INSERT INTO camery_outline.candidates(tenant_id,project_id,run_id,digest,record) VALUES($1,$2,$3,$4,$5::jsonb)',[scope.tenantId,scope.projectId,key.runId,'a'.repeat(64),'{}']);
    await docker([...textCompose,'up','--no-deps','--no-build','--pull','never','-d','outline-worker'],env);
    const killedContainer=await docker([...textCompose,'ps','--quiet','outline-worker'],env);expect(killedContainer).toBeTruthy();
    await vi.waitFor(async()=>expect((await durable.steps(taskKey)).find(step=>step.key==='agent.0.decision')?.status).toBe('completed'),{timeout:20000,interval:100});
    // Do not read the run through its advisory-locking store while the worker waits at INSERT.
    expect((await admin.query('SELECT count(*)::int n FROM camery_outline.candidates WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',[scope.tenantId,scope.projectId,key.runId])).rows[0]).toEqual({n:0});
    expect(await durable.get(taskKey)).toMatchObject({status:'running'});expect((await stats()).calls).toBe(1);
    await docker([...textCompose,'kill','--signal','SIGKILL','outline-worker'],env);expect(await docker(['inspect','--format','{{.State.ExitCode}}',killedContainer])).toBe('137');await releaseBarrier();
    expect((await durable.steps(taskKey)).find(step=>step.key==='agent.0.decision')?.status).toBe('completed');expect((await store.read(key)).candidate).toBeNull();
    await admin.query("UPDATE camery_durable.tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND task_id=$2",[scope.tenantId,taskKey.taskId]);
    await docker([...textCompose,'stop','--timeout','15','api'],env);
    await docker([...noTextCompose,'up','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','50','-d','api','outline-worker'],env);address='http://'+await docker([...noTextCompose,'port','api','3000'],env);
    const recoveredContainer=await docker([...noTextCompose,'ps','--quiet','outline-worker'],env),apiContainer=await docker([...noTextCompose,'ps','--quiet','api'],env);
    expect(await docker(['inspect','--format','{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{json .HostConfig.CapDrop}}',recoveredContainer])).toMatch(/^(?:node|1000(?::1000)?) true false \["ALL"\]$/);
    const workerEnvironment=await docker(['inspect','--format','{{json .Config.Env}}',recoveredContainer]);expect(workerEnvironment).not.toContain('CAMERY_OUTLINE_TEXT_CONFIG_FILE');expect(workerEnvironment).not.toContain('CAMERY_OUTLINE_TEXT_TOKEN_FILE');
    expect((await(await request(base+'/capabilities')).json() as {canStart:boolean}).canStart).toBe(false);
    let view:OutlineRunView|undefined;await vi.waitFor(async()=>{const response=await request(base+'/first');expect(response.status).toBe(200);view=await response.json() as OutlineRunView;expect(view.state).toBe('awaiting_review');expect(view.candidate?.output.assets).toHaveLength(128);},{timeout:20000,interval:100});
    expect((await stats()).calls).toBe(1);expect(await durable.get(taskKey)).toMatchObject({status:'succeeded'});const recovered=await store.read(key);expect(recovered.run).toEqual(before.run);expect(recovered.candidate?.model).toMatchObject({providerRequestId:'fixture-outline-1',evidence:'live_model',modeDigest:before.run.execution.modeDigest});
    expect(Buffer.byteLength(JSON.stringify(view!.candidate!.output))).toBeGreaterThan(262144);expect(view!.candidate!.output).toEqual(recovered.candidate!.output);
    expect((await admin.query('SELECT count(*)::int n FROM camery_agents.budget_allocations WHERE tenant_id=$1 AND project_id=$2',[scope.tenantId,scope.projectId])).rows[0]).toEqual({n:1});expect((await new PostgresBudgetLedger(admin).project(scope)).used.tokens).toBe('300');
    expect((await request(base+'/briefs',{briefId:'no-text-brief',expectedRevision:0,notes:'无文本配置仍可保存。',episodeCount:3,targetSeconds:90,paidEpisodeNumbers:[3],mainGenre:'rebirth-revenge',auxiliaryGenres:['suspense']})).status).toBe(201);expect((await request(base+'/briefs/no-text-brief')).status).toBe(200);expect((await request(base,{...command,runId:'new-without-text'})).status).toBe(409);
    const edited=structuredClone(view!.candidate!.output);edited.adaptation.title='容器内真实会话的人工修订';const confirm=await request(base+'/first/confirm',{candidateDigest:view!.candidate!.digest,output:edited,ablations:[{genre:'suspense',judgment:'participates',reason:'显式测试人工核对查证参与主线。'}],waivers:[]});expect(confirm.status).toBe(201);const reviewed=await confirm.json() as OutlineRunView;expect(reviewed.state).toBe('reviewed');expect(reviewed.review).toMatchObject({status:'reviewed',actorId:'human',output:edited});
    await docker([...noTextCompose,'restart','api'],env);await docker([...noTextCompose,'up','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','50','-d','api'],env);address='http://'+await docker([...noTextCompose,'port','api','3000'],env);
    expect((await(await request(base+'/first')).json() as OutlineRunView).review).toEqual(reviewed.review);expect((await stats()).calls).toBe(1);expect(await durable.get({tenantId:scope.tenantId,taskId:'unrelated-sentinel'})).toMatchObject({status:'queued',attempts:0});
    expect((await request('/api/v1/auth/sign-out',{})).status).toBe(204);expect((await request(base)).status).toBe(401);
    const logs=await docker([...noTextCompose,'logs','--no-color','api','outline-worker'],env);for(const secret of [token,session.token,privateMarker,...roles.flatMap(value=>[value.password,value.url])])expect(logs).not.toContain(secret);
    await docker([...noTextCompose,'stop','--timeout','15','outline-worker','api'],env);for(const container of [recoveredContainer,apiContainer])expect(await docker(['inspect','--format','{{.State.ExitCode}}',container])).toBe('0');
  }finally{
    const ok=await releaseResources([()=>attempted?docker([...textCompose,'down','--volumes','--timeout','15'],env):undefined,releaseBarrier,
      ...([['camery_outline',['reviews','candidates','runs','briefs']],['camery_script',['run_origins','reviews','candidates','runs','briefs']],['camery_bible',['reviews','candidates','chunks','runs']],['camery_ingest',['reading_checkpoints','documents']],['camery_agents',['budget_events','budget_allocations','budget_projects']],['camery_durable',['events','signals','steps','tasks']],['camery_access',['sessions','memberships','users']]] as const).flatMap(([schema,tables])=>tables.map(table=>()=>initialized?admin.query(`DELETE FROM ${schema}.${table} WHERE tenant_id=$1`,[scope.tenantId]):undefined)),
      ...roles.flatMap(value=>[()=>admin.query(`DROP OWNED BY ${value.name}`),()=>admin.query(`DROP ROLE ${value.name}`)]),()=>admin.end(),...files.map(file=>()=>rm(file,{force:true})),()=>rmdir(directory)]);
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Cleanup must report any owned container, role, barrier or secret left behind.
    if(!ok)throw new Error('Private outline fixture cleanup failed');
  }
});
