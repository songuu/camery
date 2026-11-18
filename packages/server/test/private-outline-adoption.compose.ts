import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {expect,it} from 'vitest';
import {migrateAccess,verifyRuntimeRole} from '@camery/access/node';
import {migrateAgents} from '@camery/agents/node';
import {migrateDurable} from '@camery/durable';
import {migrateIngest} from '@camery/ingest/node';
import {migrateBible} from '@camery/bible/node';
import {migrateDevelopment} from '@camery/script/node';
import {migrateOutline,migrateOutlineIdentities,grantOutlineRuntimeRole,verifyOutlineRuntimeRole} from '@camery/script/outline/node';
import {migrateVersioning} from '@camery/versioning/node';
import {StoryboardPackageV07} from '@camery/ir';
import {OutlineCandidateSchema,OutlineReceiptSchema} from '@camery/ir/outline-adoption';
import {OutlineFormalRowsSchema,OutlineFormalSectionPageSchema,OutlineFormalObjectSchema} from '@camery/ir/outline-formal';
import {migrateProjectIdentities} from '../src/projects/migrate.js';
import {migrateOutlineProjectIntents} from '../src/projects/outline-intent-migrate.js';
import {grantProjectIdentityReaderRole,verifyProjectIdentityReaderRole} from '../src/projects/identity-role.js';
import {grantProjectAdoptionRole,verifyProjectAdoptionRole} from '../src/projects/adoption-role.js';
import {grantOutlineProjectAdoptionRole,verifyOutlineProjectAdoptionRole} from '../src/projects/outline-adoption-role.js';
import {grantOutlineTaskRuntimeRole,verifyOutlineTaskRuntimeRole} from '../src/outline-task-role.js';
import {releaseResources} from '../src/shutdown.js';
import {outlineAdoptionPgFixture} from './outline-adoption-pg-support.js';
import {outlineVersionCounts} from './outline-intent-pg-support.js';
import {fixtureId} from '../../ir/test/fixtures.js';
import {docker} from './fixtures/compose-probe.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];
if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for private outline adoption tests');

it('uses the built private API for explicit outline adoption, original-ID restart replay and immutable historical reads with restricted LOGINs',async()=>{
  const admin=new Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000}),suffix=randomBytes(10).toString('hex'),project='camery-outline-adopt-'+suffix;
  const directory=await mkdtemp(join(tmpdir(),'camery-outline-adopt-')),files:string[]=[],owned:string[]=[];
  const roles:{name:string;password:string;url:string;internalUrl:string}[]=[];
  const networkFile=join(directory,'network.json');files.push(networkFile);
  const baseCompose=['compose','--project-name',project,'--env-file','deploy/.env.phase0','-f','deploy/compose.private.yml','-f','deploy/compose.api.yml','-f','deploy/compose.outline.yml'];
  const offCompose=[...baseCompose,'-f',networkFile],onCompose=[...baseCompose,'-f','deploy/compose.outline-adoption.yml','-f',networkFile];
  let env:NodeJS.ProcessEnv={...process.env},attempted=false,initialized=false;
  async function role(label:string,grant:(pool:Pool,name:string)=>Promise<void>,verify:(pool:Pool)=>Promise<void>){
    const name='oa_'+label+'_'+suffix,password=randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
    const local=new URL(databaseUrl!);local.username=name;local.password=password;const internal=new URL(local);internal.hostname='postgres';internal.port='5432';const record={name,password,url:local.href,internalUrl:internal.href};roles.push(record);await grant(admin,name);
    const login=new Pool({connectionString:local.href,max:1,connectionTimeoutMillis:5000});try{await verify(login);}finally{await login.end();}
    const file=join(directory,label+'-url');files.push(file);await writeFile(file,record.internalUrl+'\n',{mode:0o444});return file;
  }
  try{
    await docker(['network','inspect','camery-phase0_default','--format','{{.Name}}']);
    await migrateAccess(admin);await migrateDurable(admin);await migrateAgents(admin);await migrateIngest(admin);await migrateBible(admin);await migrateDevelopment(admin);await migrateOutline(admin);await migrateOutlineIdentities(admin);await migrateVersioning(admin);await migrateProjectIdentities(admin);await migrateOutlineProjectIntents(admin);initialized=true;
    const f=await outlineAdoptionPgFixture(admin,owned),privateTitle=f.progress.review?.status==='reviewed'?f.progress.review.output.adaptation.title:'';
    const auth=await role('auth',async(pool,name)=>{await pool.query(`GRANT USAGE ON SCHEMA camery_access TO "${name}"`);await pool.query(`GRANT SELECT ON camery_access.users,camery_access.memberships,camery_access.sessions TO "${name}"`);await pool.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO "${name}"`);},verifyRuntimeRole);
    const source=await role('source',grantOutlineRuntimeRole,verifyOutlineRuntimeRole),tasks=await role('tasks',grantOutlineTaskRuntimeRole,verifyOutlineTaskRuntimeRole),reader=await role('reader',grantProjectIdentityReaderRole,verifyProjectIdentityReaderRole),old=await role('old',grantProjectAdoptionRole,verifyProjectAdoptionRole),adopter=await role('adopter',grantOutlineProjectAdoptionRole,verifyOutlineProjectAdoptionRole);
    env={...env,CAMERY_TENANT_ID:f.scope.tenantId,CAMERY_API_PORT:'0',CAMERY_SOURCE_IMPORTS:'0',CAMERY_API_DATABASE_SECRET_FILE:auth,CAMERY_OUTLINE_PROJECT_ID:f.scope.projectId,CAMERY_OUTLINE_DATABASE_SECRET_FILE:source,CAMERY_OUTLINE_TASK_DATABASE_SECRET_FILE:tasks,CAMERY_PROJECTS_READER_DATABASE_SECRET_FILE:reader,CAMERY_PROJECTS_ADOPTION_DATABASE_SECRET_FILE:old,CAMERY_OUTLINE_ADOPTION_DATABASE_SECRET_FILE:adopter};
    await writeFile(networkFile,JSON.stringify({networks:{default:{external:true,name:'camery-phase0_default'}}}),{mode:0o600});
    await docker([...offCompose,'config','--quiet'],env);await docker([...onCompose,'config','--quiet'],env);attempted=true;
    const up=async(compose:string[])=>{await docker([...compose,'up','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','50','-d','api'],env);const port=await docker([...compose,'port','api','3000'],env);expect(port).toMatch(/^127\.0\.0\.1:\d+$/);return 'http://'+port;};
    let address=await up(offCompose);
    const base='/api/v1/projects/'+f.scope.projectId,formal=base+'/formal-outline',preparePath=base+'/outline/'+f.source.runId+'/candidates';
    const request=(path:string,headers:Record<string,string>=f.headers.viewer,body?:unknown,idempotency?:string)=>fetch(address+path,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{...headers,'content-type':'application/json',...(idempotency?{'idempotency-key':idempotency}:{})},signal:AbortSignal.timeout(5000)});
    const data=async(response:Response,status=200)=>{expect(response.status).toBe(status);return (await response.json() as {data:unknown}).data;};
    expect(await(await request(base+'/outlines/capabilities')).json()).toMatchObject({canStart:false,formalAdoption:false});
    expect((await request(formal+'/rows')).status).toBe(404);expect((await request(preparePath,f.headers.editor,f.command('disabled'),'disabled')).status).toBe(404);
    await docker([...offCompose,'stop','--timeout','15','api'],env);address=await up(onCompose);
    expect(await(await request(base+'/outlines/capabilities')).json()).toMatchObject({canStart:false,formalAdoption:true});
    const container=await docker([...onCompose,'ps','--quiet','api'],env);expect(container).toBeTruthy();
    expect(await docker(['inspect','--format','{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{json .HostConfig.CapDrop}}',container])).toMatch(/^(?:node|1000(?::1000)?) true false \["ALL"\]$/);
    const runtimeEnv=await docker(['inspect','--format','{{json .Config.Env}}',container]);expect(runtimeEnv).not.toContain('CAMERY_OUTLINE_TEXT_CONFIG_FILE');expect(runtimeEnv).not.toContain('CAMERY_OUTLINE_TEXT_TOKEN_FILE');
    const sourceBefore=await f.store.read(f.key),calls=f.calls(),command=f.command('container-prepare');
    const prepared=OutlineCandidateSchema.parse(await data(await request(preparePath,f.headers.editor,command,command.applicationId),201));expect(prepared.preparation).toMatchObject({status:'candidate',issueCount:0,snapshotRevision:1,writeVersion:2});
    const candidatePath=base+'/outline-adoption/candidates/'+prepared.candidateId,decision={expectedSnapshotRevision:1,expectedWriteVersion:2},decisionId='container-adopt';
    const receipt=OutlineReceiptSchema.parse(await data(await request(candidatePath+'/adopt',f.headers.reviewer,decision,decisionId),201));expect(receipt).toMatchObject({status:'adopted',issueCount:0,snapshotRevision:2,writeVersion:3,adoption:{change_set_id:prepared.candidateId,actor_id:fixtureId(f.scope.tenantId+'reviewer')}});
    const stored=await f.versions.read(f.target);expect(stored?.state.head.revision.number).toBe(receipt.snapshotRevision);expect(stored?.writeVersion).toBe(receipt.writeVersion);expect(stored?.state.adoptions).toContainEqual(receipt.adoption);
    const counts=await f.persistenceCounts(),native=await outlineVersionCounts(admin,f.target),head=StoryboardPackageV07.parse(stored!.state.head),plan=head.adaptation_plans[0]!;
    const rows=OutlineFormalRowsSchema.parse(await data(await request(formal+'/rows?limit=1'))),sectionAddress=formal+'/adaptation_plans/'+plan.id+'/sections',sectionQuery={section:'adaptation_plans.beats',limit:'1'};
    expect(rows.snapshotRevision).toBe(2);expect(rows.nextCursor).not.toBeNull();const firstSection=OutlineFormalSectionPageSchema.parse(await data(await request(sectionAddress+'?'+new URLSearchParams(sectionQuery))));expect(firstSection.nextCursor).not.toBeNull();
    await docker([...onCompose,'restart','api'],env);address=await up(onCompose);
    const replay=OutlineCandidateSchema.parse(await data(await request(preparePath,f.headers.editor,command,command.applicationId),201));expect(replay.candidateId).toBe(prepared.candidateId);expect(replay.preparation).toEqual(prepared.preparation);
    expect(OutlineReceiptSchema.parse(await data(await request(candidatePath+'/adopt',f.headers.reviewer,decision,decisionId),201))).toEqual(receipt);
    expect(await f.persistenceCounts()).toEqual(counts);expect(await outlineVersionCounts(admin,f.target)).toEqual(native);expect(await f.versions.read(f.target)).toEqual(stored);expect(f.calls()).toBe(calls);
    const next=await f.next('container-next-source',4),nextCommand=f.command('container-next-prepare',next.source,2,3),nextPrepared=OutlineCandidateSchema.parse(await data(await request(base+'/outline/'+next.source.runId+'/candidates',f.headers.editor,nextCommand,nextCommand.applicationId),201));
    const nextReceipt=OutlineReceiptSchema.parse(await data(await request(base+'/outline-adoption/candidates/'+nextPrepared.candidateId+'/adopt',f.headers.reviewer,{expectedSnapshotRevision:2,expectedWriteVersion:4},'container-next-adopt'),201));expect(nextReceipt).toMatchObject({status:'adopted',issueCount:0,snapshotRevision:3,writeVersion:5});
    const beforeReads=await f.persistenceCounts(),beforeNative=await outlineVersionCounts(admin,f.target),sourceCalls=f.calls();
    const oldSection=OutlineFormalSectionPageSchema.parse(await data(await request(sectionAddress+'?'+new URLSearchParams({section:sectionQuery.section,cursor:firstSection.nextCursor!,limit:'50'}))));expect(oldSection).toMatchObject({snapshotRevision:2,headRevision:3,writeVersion:5,nextCursor:null});expect(oldSection.items).toEqual(plan.beats.slice(1));
    const oldRows=[...rows.rows];let cursor=rows.nextCursor;const visited=new Set<string>();while(cursor){expect(visited.has(cursor)).toBe(false);visited.add(cursor);const page=OutlineFormalRowsSchema.parse(await data(await request(formal+'/rows?'+new URLSearchParams({cursor,limit:'50'}))));expect(page).toMatchObject({snapshotRevision:2,headRevision:3,writeVersion:5});oldRows.push(...page.rows);cursor=page.nextCursor;}
    const rowKeys=new Set<string>();for(const row of oldRows){expect(row.kind).toBe('complete');expect(rowKeys.has(row.ref.collection+':'+row.ref.id)).toBe(false);rowKeys.add(row.ref.collection+':'+row.ref.id);if(row.kind==='complete')expect(row.record.value).toEqual(head[row.ref.collection].find(value=>value.id===row.ref.id));}expect(oldRows).toHaveLength(rows.counts.reduce((sum,value)=>sum+value.count,0));
    const historic=OutlineFormalObjectSchema.parse(await data(await request(formal+'/adaptation_plans/'+plan.id+'?revision=2'))),current=OutlineFormalObjectSchema.parse(await data(await request(formal+'/adaptation_plans/'+plan.id)));expect(historic.overview.value).toMatchObject({source:{run_id:f.source.runId}});expect(current.overview.value).toMatchObject({source:{run_id:next.source.runId}});
    expect((await request(formal+'/rows?'+new URLSearchParams({cursor:rows.nextCursor!}),f.headers.reviewer)).status).toBe(400);
    expect((await request('/api/v1/projects/unrelated-project/formal-outline/rows')).status).toBe(403);expect((await request(candidatePath+'/adopt',f.headers.viewer,decision,'viewer-forbidden')).status).toBe(403);
    const viewer=await f.subject('viewer');await f.sessions.revoke(viewer.tenantId,viewer.sessionId,viewer.userId);expect((await request(formal+'/rows')).status).toBe(401);
    const reviewer=await f.subject('reviewer');await f.sessions.provisionMember({...f.scope,userId:reviewer.userId,role:'viewer'});expect((await request(candidatePath+'/adopt',f.headers.reviewer,decision,decisionId)).status).toBe(403);
    expect(await f.persistenceCounts()).toEqual(beforeReads);expect(await outlineVersionCounts(admin,f.target)).toEqual(beforeNative);expect(f.calls()).toBe(sourceCalls);expect((await f.store.read(f.key)).review).toEqual(sourceBefore.review);
    const logs=await docker([...onCompose,'logs','--no-color','api'],env);for(const secret of [privateTitle,...Object.values(f.headers).map(value=>value.authorization.slice(7)),...roles.flatMap(value=>[value.password,value.url,value.internalUrl])])if(secret)expect(logs).not.toContain(secret);
    await docker([...onCompose,'stop','--timeout','15','api'],env);expect(await docker(['inspect','--format','{{.State.ExitCode}}',container])).toBe('0');
  }finally{
    const clearNative=async(tenant:string)=>{const client=await admin.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query('DELETE FROM camery_versioning.'+table+' WHERE tenant_id=$1 AND project_id=$2',[fixtureId('formal-tenant-'+tenant),fixtureId('formal-project-'+tenant)]);await client.query('COMMIT');}catch{await client.query('ROLLBACK');throw new Error('Owned outline adoption native fixture cleanup failed');}finally{client.release();}};
    const clean=await releaseResources([()=>attempted?docker([...onCompose,'down','--volumes','--timeout','15'],env):undefined,
      ...owned.flatMap(tenant=>([['camery_projects',['outline_decision_receipts','outline_decision_intents','outline_candidate_receipts','outline_candidate_intents','decision_receipts','decision_intents','candidate_receipts','candidate_intents','principals','projects','tenants']],['camery_outline',['identity_preparations']],['camery_script',['ir_identities']],['camery_outline',['reviews','candidates','runs','briefs']],['camery_script',['run_origins','reviews','candidates','runs','briefs']],['camery_bible',['reviews','candidates','chunks','runs']],['camery_ingest',['reading_checkpoints','documents']],['camery_access',['sessions','memberships','users']]] as const).flatMap(([schema,tables])=>tables.map(table=>()=>initialized?admin.query('DELETE FROM '+schema+'.'+table+' WHERE tenant_id=$1',[tenant]):undefined))),
      ...owned.map(tenant=>()=>clearNative(tenant)),...roles.flatMap(value=>[()=>admin.query(`DROP OWNED BY "${value.name}"`),()=>admin.query(`DROP ROLE "${value.name}"`)]),()=>admin.end(),...files.map(file=>()=>rm(file,{force:true})),()=>rmdir(directory)]);
    // oxlint-disable-next-line eslint/no-unsafe-finally -- A failed cleanup must report owned containers, LOGINs or secret files left behind.
    if(!clean)throw new Error('Private outline adoption fixture cleanup failed');
  }
},180000);
