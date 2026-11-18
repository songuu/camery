import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {OUTLINE_COLLECTIONS,ChangeSetV07,StoryboardPackageV07,upgradeV05Package,upgradeV06Package} from '@camery/ir';
import {OutlineFormalObjectSchema,OutlineFormalSectionPageSchema,OutlineFormalRowsSchema,OUTLINE_FORMAL_SECTIONS} from '@camery/ir/outline-formal';
import type {OutlineFormalObject,OutlineFormalRef,OutlineFormalSection,OutlineFormalRows,OutlineFormalRow} from '@camery/ir/outline-formal';
import {migrateAccess} from '@camery/access/node';
import {migrateAgents} from '@camery/agents/node';
import {migrateDurable} from '@camery/durable';
import {migrateBible} from '@camery/bible/node';
import {migrateIngest} from '@camery/ingest/node';
import {migrateDevelopment} from '@camery/script/node';
import {migrateOutline,migrateOutlineIdentities,grantOutlineRuntimeRole} from '@camery/script/outline/node';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import {migrateProjectIdentities} from '../src/projects/migrate.js';
import {migrateOutlineProjectIntents} from '../src/projects/outline-intent-migrate.js';
import {grantProjectIdentityReaderRole} from '../src/projects/identity-role.js';
import {grantProjectAdoptionRole} from '../src/projects/adoption-role.js';
import {grantOutlineProjectAdoptionRole} from '../src/projects/outline-adoption-role.js';
import {grantOutlineTaskRuntimeRole} from '../src/outline-task-role.js';
import {readOutlineAdoptionConfig,resolveOutlineAdoptionDeployment} from '../src/projects/outline-adoption-config.js';
import {createOutlineAdoptionRuntime} from '../src/projects/outline-adoption-runtime.js';
import {PostgresOutlineFormalReadStore} from '../src/projects/outline-formal-store.js';
import {createApplication} from '../src/app.js';
import {fixtureId,makePackage} from '../../ir/test/fixtures.js';
import {outlineAdoptionPgFixture} from './outline-adoption-pg-support.js';
import {outlineVersionCounts} from './outline-intent-pg-support.js';
import {formalRoleFixture,formalFreePort,formalBuiltProcess} from './outline-formal-runtime-pg-support.js';
import {outlineFormalReadCapacityPlan} from './outline-formal-read-support.js';
import {buildServer} from '../scripts/build.mjs';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for complete formal Outline reads');
const pool=new Pool({connectionString:databaseUrl,max:12,connectionTimeoutMillis:5000}),owned:string[]=[],extraTargets:{tenantId:string;projectId:string}[]=[];
beforeAll(async()=>{await migrateAccess(pool);await migrateDurable(pool);await migrateAgents(pool);await migrateVersioning(pool);await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);await migrateOutline(pool);await migrateOutlineIdentities(pool);await migrateProjectIdentities(pool);await migrateOutlineProjectIntents(pool);});
afterAll(async()=>{
  let failed=false;try{
    for(const tenant of owned)for(const [schema,tables] of [
      ['camery_projects',['outline_decision_receipts','outline_decision_intents','outline_candidate_receipts','outline_candidate_intents','principals','projects','tenants']],
      ['camery_outline',['identity_preparations']],['camery_script',['ir_identities']],['camery_outline',['reviews','candidates','runs','briefs']],['camery_script',['run_origins','reviews','candidates','runs','briefs']],
      ['camery_bible',['reviews','candidates','chunks','runs']],['camery_ingest',['reading_checkpoints','documents']],['camery_access',['sessions','memberships','users']],
    ] as const)for(const table of tables)try{await pool.query(`DELETE FROM ${schema}.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
    for(const target of [...extraTargets,...owned.map(tenant=>({tenantId:fixtureId('formal-tenant-'+tenant),projectId:fixtureId('formal-project-'+tenant)}))]){
      const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[target.tenantId,target.projectId]);await client.query('COMMIT');}catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}
    }
  }finally{await pool.end();}if(failed)throw new Error('Formal Outline read fixture cleanup failed');
});
const fixture=(capacity=false)=>outlineAdoptionPgFixture(pool,owned,capacity);
type Fixture=Awaited<ReturnType<typeof fixture>>;
const base=(f:Fixture)=>'/api/v1/projects/'+f.scope.projectId+'/formal-outline';
const rowKey=(ref:OutlineFormalRef)=>ref.collection+':'+ref.id;
function putSection(value:Record<string,unknown>,section:OutlineFormalSection,items:unknown[]){const parts=OUTLINE_FORMAL_SECTIONS[section].path;let record=value;for(const name of parts.slice(0,-1))record=record[name] as Record<string,unknown>;record[parts.at(-1)!]=items;}
function sectionedDetail(page:{projectKey:string;projectId:string;snapshotRevision:number;headRevision:number;writeVersion:number},row:{ref:OutlineFormalRef;plan:{id:string;version:number};overview:OutlineFormalObject['overview'];sections:OutlineFormalObject['sections']}):OutlineFormalObject{return OutlineFormalObjectSchema.parse({contractVersion:1,schemaVersion:'0.7.0-draft',projectKey:page.projectKey,projectId:page.projectId,snapshotRevision:page.snapshotRevision,headRevision:page.headRevision,writeVersion:page.writeVersion,ref:row.ref,plan:row.plan,overview:row.overview,sections:row.sections});}
async function withHost<T>(f:Fixture,action:(host:Awaited<ReturnType<typeof createOutlineAdoptionRuntime>>,urls:{reader:string;adopter:string})=>Promise<T>){
  const roles=formalRoleFixture(pool,databaseUrl!);let host:Awaited<ReturnType<typeof createOutlineAdoptionRuntime>>|undefined;
  try{const reader=await roles.create('reader',grantProjectIdentityReaderRole),adopter=await roles.create('adopter',grantOutlineProjectAdoptionRole);host=await createOutlineAdoptionRuntime({tenantId:f.scope.tenantId,readerDatabaseUrl:reader.url,adoptionDatabaseUrl:adopter.url});return await action(host,{reader:reader.url,adopter:adopter.url});}finally{await host?.close();await roles.close();}
}
async function adopted(f:Fixture,host:Awaited<ReturnType<typeof createOutlineAdoptionRuntime>>,applicationId='formal-reader-prepare'){
  const app=new (await import('../src/projects/outline-adoption-application.js')).OutlineAdoptionApplication(host.adoptionOptions),prepared=await app.prepareOutline({subject:await f.subject('editor'),projectId:f.scope.projectId,runId:f.source.runId,command:f.command(applicationId)});
  const receipt=await app.adoptCandidate({subject:await f.subject('reviewer'),projectId:f.scope.projectId,candidateId:prepared.candidateId,requestId:applicationId+'-adopt',command:{expectedSnapshotRevision:1,expectedWriteVersion:2}});expect(receipt.status).toBe('adopted');return receipt;
}
async function importCapacityPlan(f:Fixture){
  const current=(await f.versions.read(f.target))!,head=StoryboardPackageV07.parse(current.state.head),plan=head.adaptation_plans[0]!,imported=outlineFormalReadCapacityPlan(plan),actor=(await f.authority('reviewer')).principal;
  expect(current.state.changes.at(-1)!.request.ops).toHaveLength(1249);
  // The trusted importer extends typed capacity data; the original provider and human-review evidence remain explicit and unchanged.
  expect(imported.source.review_digest).toBe(plan.source.review_digest);expect(imported.review).toEqual(plan.review);
  const request=ChangeSetV07.parse({schema_version:'0.7.0-draft',id:fixtureId('formal-capacity-import-'+randomBytes(10).toString('hex')),author:actor,status:'candidate',base_revision:head.revision.number,base_revisions:[{id:plan.id,version:plan.version}],ops:[{op:'update',op_id:fixtureId('formal-capacity-import-op'),collection:'adaptation_plans',target:plan.id,set:{source:imported.source,recipe:imported.recipe}}]});
  const submitted=await f.versions.submit(f.target,request);expect(submitted.status).toBe('candidate');
  const result=await f.versions.adopt(f.target,request.id,{actor,scope:{kind:'project',id:f.target.projectId},at:new Date().toISOString(),authorize:()=>true,expectation:{expectedSnapshotRevision:head.revision.number,expectedWriteVersion:submitted.writeVersion}});expect(result.status).toBe('adopted');return StoryboardPackageV07.parse(result.state.head);
}

it('reads every full-capacity formal object over HTTP through the configured low-privilege host and reconstructs the oversized plan without losing a field',async()=>{
  const started=performance.now(),phase=(name:string)=>console.info('Formal capacity phase '+name+': '+Math.round(performance.now()-started)+'ms');
  const f=await fixture(true);phase('fixture done');await withHost(f,async(host,urls)=>{
    phase('roles/runtime done');await adopted(f,host);phase('actual adopt done');const snapshot=await importCapacityPlan(f);phase('trusted import done');const revision=String(snapshot.revision.number),before=await f.persistenceCounts(),versionsBefore=await outlineVersionCounts(pool,f.target),calls=f.calls(),generated=f.generated();
    expect(Buffer.byteLength(JSON.stringify(snapshot.adaptation_plans[0]))).toBeGreaterThan(1048576);
    const app=await createApplication({tenantId:f.scope.tenantId,store:f.sessions,outlineAdoption:host.adoptionOptions,outlineFormal:host.formalOptions});
    try{
      const get=async(url:string)=>{const response=await app.inject({url,headers:f.headers.viewer});expect(response.statusCode,response.body.length<1000?response.body:'Bounded formal page failed').toBe(200);expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(983040);return response.json().data as unknown;};
      const restored=new Map<string,Record<string,unknown>>(),seenRows=new Set<string>(),seenSections=new Set<OutlineFormalSection>(),deferred:{page:OutlineFormalRows;row:Extract<OutlineFormalRow,{kind:'sectioned'}>}[]=[];let cursor:string|null=null;
      do{
        const query=new URLSearchParams({limit:'50'});if(cursor)query.set('cursor',cursor);const page=OutlineFormalRowsSchema.parse(await get(base(f)+'/rows?'+query));expect(page.snapshotRevision).toBe(snapshot.revision.number);
        for(const row of page.rows){
          expect(seenRows.has(rowKey(row.ref))).toBe(false);seenRows.add(rowKey(row.ref));
          if(row.kind==='complete'){expect(row.record.collection).toBe(row.ref.collection);restored.set(rowKey(row.ref),structuredClone(row.record.value) as Record<string,unknown>);continue;}
          deferred.push({page,row});
        }
        cursor=page.nextCursor;
      }while(cursor!==null);
      phase('bulk rows done');
      for(const {page,row} of deferred){
          const detail=sectionedDetail(page,row),record=structuredClone(detail.overview.value) as Record<string,unknown>;
          const address=base(f)+'/'+row.ref.collection+'/'+row.ref.id;expect(OutlineFormalObjectSchema.parse(await get(address+'?revision='+revision))).toEqual(detail);
          for(const descriptor of detail.sections){
            const items:unknown[]=[];let next:string|null=null;do{const selection=new URLSearchParams({revision,section:descriptor.section,limit:'50'});if(next)selection.set('cursor',next);const part=OutlineFormalSectionPageSchema.parse(await get(address+'/sections?'+selection));expect(part.snapshotRevision).toBe(snapshot.revision.number);expect(part.ref).toEqual(row.ref);expect(part.total).toBe(descriptor.total);items.push(...part.items);next=part.nextCursor;}while(next!==null);
            expect(items).toHaveLength(descriptor.total);putSection(record,descriptor.section,items);seenSections.add(descriptor.section);
          }
          restored.set(rowKey(row.ref),record);
      }
      expect(deferred.length).toBeGreaterThan(0);expect(restored.size).toBe(1085);
      for(const collection of OUTLINE_COLLECTIONS)for(const value of snapshot[collection])expect(restored.get(collection+':'+value.id)).toEqual(value);
      // Complete small rows carry their arrays too; exercise the remaining typed section endpoints explicitly.
      for(const [section,definition] of Object.entries(OUTLINE_FORMAL_SECTIONS) as [OutlineFormalSection,(typeof OUTLINE_FORMAL_SECTIONS)[OutlineFormalSection]][]){
        if(seenSections.has(section))continue;const row=snapshot[definition.collection][0]!,address=base(f)+'/'+definition.collection+'/'+row.id,items:unknown[]=[];let next:string|null=null;
        do{const selection=new URLSearchParams({revision,section,limit:'50'});if(next)selection.set('cursor',next);const part=OutlineFormalSectionPageSchema.parse(await get(address+'/sections?'+selection));items.push(...part.items);next=part.nextCursor;}while(next!==null);
        let expected:unknown=row;for(const field of definition.path)expected=(expected as Record<string,unknown>)[field];expect(items).toEqual(expected);seenSections.add(section);
      }
      phase('sections done');
      expect(seenSections.size).toBe(22);expect(await f.persistenceCounts()).toEqual(before);expect(await outlineVersionCounts(pool,f.target)).toEqual(versionsBefore);expect(f.calls()).toBe(calls);expect(f.generated()).toBe(generated);
      const fresh=new Pool({connectionString:urls.adopter,max:2,connectionTimeoutMillis:5000});try{expect((await new PostgresOutlineFormalReadStore(fresh).snapshot({target:f.target,revision:snapshot.revision.number}))?.snapshot).toEqual(snapshot);}finally{await fresh.end();}
    }finally{await app.close();}
  });
});

it('keeps old immutable row and section pages pinned after another adopted outline changes the head and rejects changed cursor authorities',async()=>{
  const f=await fixture();await withHost(f,async(host,urls)=>{
    await adopted(f,host);const old=StoryboardPackageV07.parse((await f.versions.read(f.target))!.state.head),plan=old.adaptation_plans[0]!;let app=await createApplication({tenantId:f.scope.tenantId,store:f.sessions,outlineFormal:host.formalOptions}),replacement:Awaited<ReturnType<typeof createOutlineAdoptionRuntime>>|undefined;
    try{
      const firstResponse=await app.inject({url:base(f)+'/rows?limit=1',headers:f.headers.viewer});expect(firstResponse.statusCode).toBe(200);const first=OutlineFormalRowsSchema.parse(firstResponse.json().data);expect(first.nextCursor).not.toBeNull();
      const sectionName='adaptation_plans.beats',address=base(f)+'/adaptation_plans/'+plan.id,firstSectionResponse=await app.inject({url:address+'/sections?section='+sectionName+'&limit=1',headers:f.headers.viewer});expect(firstSectionResponse.statusCode).toBe(200);const firstSection=OutlineFormalSectionPageSchema.parse(firstSectionResponse.json().data);expect(firstSection.nextCursor).not.toBeNull();
      const next=await f.next('formal-reader-new-head',3),applicant=new (await import('../src/projects/outline-adoption-application.js')).OutlineAdoptionApplication(host.adoptionOptions),prepared=await applicant.prepareOutline({subject:await f.subject('editor'),projectId:f.scope.projectId,runId:next.source.runId,command:f.command('new-head',next.source,2,3)});
      expect((await applicant.adoptCandidate({subject:await f.subject('reviewer'),projectId:f.scope.projectId,candidateId:prepared.candidateId,requestId:'new-head-adopt',command:{expectedSnapshotRevision:2,expectedWriteVersion:4}})).status).toBe('adopted');
      await app.close();await host.close();replacement=await createOutlineAdoptionRuntime({tenantId:f.scope.tenantId,readerDatabaseUrl:urls.reader,adoptionDatabaseUrl:urls.adopter});app=await createApplication({tenantId:f.scope.tenantId,store:f.sessions,outlineFormal:replacement.formalOptions});
      const rows=await app.inject({url:base(f)+'/rows?'+new URLSearchParams({cursor:first.nextCursor!,limit:'50'}),headers:f.headers.viewer});expect(rows.statusCode).toBe(200);const pinned=OutlineFormalRowsSchema.parse(rows.json().data);expect(pinned.snapshotRevision).toBe(2);expect(pinned.headRevision).toBe(3);expect(pinned.writeVersion).toBe(5);
      const second=await app.inject({url:address+'/sections?'+new URLSearchParams({section:sectionName,cursor:firstSection.nextCursor!,limit:'50'}),headers:f.headers.viewer});expect(second.statusCode).toBe(200);const pinnedSection=OutlineFormalSectionPageSchema.parse(second.json().data);expect(pinnedSection.snapshotRevision).toBe(2);expect(pinnedSection.headRevision).toBe(3);expect(pinnedSection.items).toEqual(plan.beats.slice(1));
      const historic=await app.inject({url:address+'?revision=2',headers:f.headers.viewer});expect(OutlineFormalObjectSchema.parse(historic.json().data).overview.value).toMatchObject({source:expect.objectContaining({run_id:f.source.runId})});
      const fresh=await app.inject({url:address,headers:f.headers.viewer});expect(OutlineFormalObjectSchema.parse(fresh.json().data).overview.value).toMatchObject({source:expect.objectContaining({run_id:next.source.runId})});
      for(const [suffix,headers] of [
        ['/rows?'+new URLSearchParams({cursor:first.nextCursor!,revision:'3'}),f.headers.viewer],
        ['/rows?'+new URLSearchParams({cursor:first.nextCursor!}),f.headers.reviewer],
        ['/adaptation_plans/'+plan.id+'/sections?'+new URLSearchParams({section:'adaptation_plans.assets',cursor:firstSection.nextCursor!}),f.headers.viewer],
        ['/adaptation_plans/'+plan.id+'/sections?'+new URLSearchParams({section:sectionName,cursor:firstSection.nextCursor!,revision:'3'}),f.headers.viewer],
      ] as const)expect((await app.inject({url:base(f)+suffix,headers})).statusCode).toBe(400);
      expect((await app.inject({url:base(f)+'/rows?revision=999',headers:f.headers.viewer})).statusCode).toBe(404);
      const viewer=await f.subject('viewer');await f.sessions.revoke(viewer.tenantId,viewer.sessionId,viewer.userId);expect((await app.inject({url:base(f)+'/rows?cursor='+encodeURIComponent(first.nextCursor!),headers:f.headers.viewer})).statusCode).toBe(401);
    }finally{await app.close();await replacement?.close();}
  });
});

it('does not confuse identical project IDs in different formal tenants and rejects missing, legacy and corrupted native snapshot facts',async()=>{
  const f=await fixture(),store=new PostgresOutlineFormalReadStore(pool),other={tenantId:fixtureId('formal-other-'+randomBytes(10).toString('hex')),projectId:f.target.projectId};extraTargets.push(other);
  const baseline=upgradeV06Package(upgradeV05Package(makePackage()));baseline.project.id=other.projectId;baseline.package_id=fixtureId('formal-other-package');await new PostgresVersionStore(pool).initialize(other,baseline);
  expect((await store.snapshot({target:other}))?.packageId).toBe(baseline.package_id);expect((await store.snapshot({target:f.target}))?.packageId).toBe(f.baseline.package_id);expect(await store.snapshot({target:{tenantId:fixtureId('not-present'),projectId:f.target.projectId}})).toBeNull();
  await expect(store.snapshot({target:f.target,revision:999})).rejects.toMatchObject({code:'NOT_FOUND'});
  const old=structuredClone(f.baseline) as unknown as Record<string,unknown>;for(const collection of OUTLINE_COLLECTIONS)delete old[collection];old['schema_version']='0.6.0-draft';
  try{await pool.query('UPDATE camery_versioning.snapshots SET package=$1::jsonb WHERE tenant_id=$2 AND project_id=$3 AND revision=1',[JSON.stringify(old),f.target.tenantId,f.target.projectId]);await expect(store.snapshot({target:f.target})).rejects.toMatchObject({code:'SCHEMA_UPGRADE_REQUIRED'});}
  finally{await pool.query('UPDATE camery_versioning.snapshots SET package=$1::jsonb WHERE tenant_id=$2 AND project_id=$3 AND revision=1',[JSON.stringify(f.baseline),f.target.tenantId,f.target.projectId]);}
  try{await pool.query('UPDATE camery_versioning.projects SET package_id=$1 WHERE tenant_id=$2 AND project_id=$3',[fixtureId('wrong-formal-package'),f.target.tenantId,f.target.projectId]);await expect(store.snapshot({target:f.target})).rejects.toMatchObject({code:'STORAGE_FAILED'});}
  finally{await pool.query('UPDATE camery_versioning.projects SET package_id=$1 WHERE tenant_id=$2 AND project_id=$3',[f.baseline.package_id,f.target.tenantId,f.target.projectId]);}
});

it('starts the built main with explicit secret-backed host configuration and keeps disabled or mismatched hosts closed',async()=>{
  const f=await fixture(),roles=formalRoleFixture(pool,databaseUrl!),dist=path.resolve(import.meta.dirname,'../dist');await mkdir(dist,{recursive:true});const directory=await mkdtemp(path.join(dist,'formal-host-')),output=path.join(directory,'application');
  const resolved=path.resolve(directory);if(path.dirname(resolved)!==dist||!path.basename(resolved).startsWith('formal-host-'))throw new Error('Unsafe owned built fixture cleanup');
  const processes:ReturnType<typeof formalBuiltProcess>[]=[];
  try{
    const reader=await roles.create('reader',grantProjectIdentityReaderRole),adopter=await roles.create('adopter',grantOutlineProjectAdoptionRole),old=await roles.create('old',grantProjectAdoptionRole),data=await roles.create('data',grantOutlineRuntimeRole),tasks=await roles.create('tasks',grantOutlineTaskRuntimeRole),auth=await roles.create('auth',async(admin,name)=>{await admin.query(`GRANT USAGE ON SCHEMA camery_access TO "${name}"`);await admin.query(`GRANT SELECT ON camery_access.users,camery_access.memberships,camery_access.sessions TO "${name}"`);await admin.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO "${name}"`);}),wrong=await roles.create('wrong',grantProjectIdentityReaderRole);
    const files=new Map<string,string>();for(const item of roles.owned){const file=path.join(directory,item.name);await writeFile(file,item.url+'\n',{mode:0o600});files.set(item.name,file);}
    const config=await readOutlineAdoptionConfig({CAMERY_TENANT_ID:f.scope.tenantId,CAMERY_OUTLINE_ADOPTION_ENABLED:'1',CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE:files.get(adopter.name)!});
    const deployment=resolveOutlineAdoptionDeployment(config!,{tenantId:f.scope.tenantId,readerDatabaseUrl:reader.url,adoptionDatabaseUrl:old.url},{tenantId:f.scope.tenantId,projectId:f.scope.projectId,outlineDatabaseUrl:data.url,taskDatabaseUrl:tasks.url,text:null,workerId:'formal-test',pollMs:1000,runsPerRound:1});
    const host=await createOutlineAdoptionRuntime(deployment!);try{await adopted(f,host,'built-read-source');}finally{await host.close();}
    await buildServer(output);const entry=path.join(output,'main.mjs');
    const common={CAMERY_TENANT_ID:f.scope.tenantId,CAMERY_DATABASE_URL_FILE:files.get(auth.name)!,CAMERY_API_HOST:'127.0.0.1',CAMERY_SOURCE_IMPORTS:'0'};
    const start=async(extra:Record<string,string|undefined>)=>{const port=await formalFreePort(),process=formalBuiltProcess(entry,{...common,CAMERY_API_PORT:String(port),...extra});processes.push(process);return {process,address:'http://127.0.0.1:'+port};};
    const ready=async(value:Awaited<ReturnType<typeof start>>)=>vi.waitFor(async()=>{expect(value.process.closed()).toBe(false);expect((await fetch(value.address+'/health',{signal:AbortSignal.timeout(1000)})).status).toBe(200);},{timeout:10000,interval:100});
    const off=await start({CAMERY_OUTLINE_ADOPTION_ENABLED:'0'});await ready(off);expect((await fetch(off.address+base(f)+'/rows',{headers:f.headers.viewer,signal:AbortSignal.timeout(2000)})).status).toBe(404);await off.process.stop();
    const enabled={CAMERY_PROJECTS_ENABLED:'1',CAMERY_PROJECTS_READER_DATABASE_URL_FILE:files.get(reader.name)!,CAMERY_PROJECTS_ADOPTION_DATABASE_URL_FILE:files.get(old.name)!,CAMERY_OUTLINE_ENABLED:'1',CAMERY_OUTLINE_PROJECT_ID:f.scope.projectId,CAMERY_OUTLINE_DATABASE_URL_FILE:files.get(data.name)!,CAMERY_OUTLINE_TASK_DATABASE_URL_FILE:files.get(tasks.name)!,CAMERY_OUTLINE_ADOPTION_ENABLED:'1',CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE:files.get(adopter.name)!};
    const on=await start(enabled);await ready(on);const formal=await fetch(on.address+base(f)+'/rows?limit=50',{headers:f.headers.viewer,signal:AbortSignal.timeout(5000)});expect(formal.status).toBe(200);expect(OutlineFormalRowsSchema.parse((await formal.json() as {data:unknown}).data).snapshotRevision).toBe(2);expect((await fetch(on.address+'/api/v1/projects/'+f.scope.projectId+'/outlines/capabilities',{headers:f.headers.viewer,signal:AbortSignal.timeout(3000)})).status).toBe(200);
    const stopped=await on.process.stop();expect(on.process.closed()).toBe(true);if(process.platform!=='win32')expect(stopped).toEqual({code:0,signal:null});
    const rejected=await start({...enabled,CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE:files.get(wrong.name)!});const failed=await Promise.race([rejected.process.exit,new Promise<never>((_resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Built host did not reject invalid role')),10000);timer.unref();})]);expect(failed.code).toBe(1);expect(rejected.process.log()).toContain('API startup failed');
    for(const child of processes)for(const role of roles.owned)for(const secret of [role.password,role.url])expect(child.log()).not.toContain(secret);
  }finally{
    await Promise.all(processes.map(process=>process.stop()));await roles.close();await rm(resolved,{recursive:true,force:true});
  }
});

it('reuses only a verified immutable payload while every actual PG read refreshes head and write counters',async()=>{
  const f=await fixture();await withHost(f,async host=>{
    const reader=host.formalOptions.store,before=await f.persistenceCounts(),versionsBefore=await outlineVersionCounts(pool,f.target),initial=await reader.snapshot({target:f.target,revision:1});
    expect(initial).not.toBeNull();expect(initial!.snapshot).toEqual(f.baseline);expect(Object.isFrozen(initial!.snapshot)).toBe(true);expect(Object.isFrozen(initial!.snapshot.project)).toBe(true);
    const repeated=await reader.snapshot({target:f.target});expect(repeated!.snapshot).toBe(initial!.snapshot);expect(repeated).toMatchObject({headRevision:1,writeVersion:1,revision:1});
    expect(await f.persistenceCounts()).toEqual(before);expect(await outlineVersionCounts(pool,f.target)).toEqual(versionsBefore);
    const submitted=await f.submit();expect(submitted.status).toBe('candidate');const pending=await reader.snapshot({target:f.target});expect(pending!.snapshot).toBe(initial!.snapshot);expect(pending).toMatchObject({headRevision:1,writeVersion:submitted.writeVersion,revision:1});
    const decision=await f.decision(),adoption=await f.versions.adopt(f.target,f.candidate.request!.id,decision.options);expect(adoption.status).toBe('adopted');
    const after=await f.persistenceCounts(),versionsAfter=await outlineVersionCounts(pool,f.target),historic=await reader.snapshot({target:f.target,revision:1});
    expect(historic!.snapshot).toBe(initial!.snapshot);expect(historic).toMatchObject({revision:1,headRevision:2,writeVersion:adoption.writeVersion});
    const historicAgain=await reader.snapshot({target:f.target,revision:1});expect(historicAgain!.snapshot).toBe(initial!.snapshot);expect(historicAgain).toMatchObject({revision:1,headRevision:2,writeVersion:adoption.writeVersion});
    const current=await reader.snapshot({target:f.target});expect(current!.snapshot).toEqual(adoption.state.head);expect(current!.snapshot).not.toBe(initial!.snapshot);expect(current).toMatchObject({revision:2,headRevision:2,writeVersion:adoption.writeVersion});
    expect(initial!.snapshot).toEqual(f.baseline);expect(await f.persistenceCounts()).toEqual(after);expect(await outlineVersionCounts(pool,f.target)).toEqual(versionsAfter);
  });
});

it('fingerprints the actual selected PG snapshot before cache reuse and rejects corruption even at the same revision',async()=>{
  const f=await fixture();await withHost(f,async host=>{
    const reader=host.formalOptions.store,initial=await reader.snapshot({target:f.target,revision:1}),before=await f.persistenceCounts(),versionsBefore=await outlineVersionCounts(pool,f.target),changed=structuredClone(f.baseline);
    expect(initial).not.toBeNull();expect((await reader.snapshot({target:f.target,revision:1}))!.snapshot).toBe(initial!.snapshot);
    changed.project.scope.label+=' Explicit administrator-owned cache fixture update.';
    try{
      await pool.query('UPDATE camery_versioning.snapshots SET package=$1::jsonb WHERE tenant_id=$2 AND project_id=$3 AND revision=1',[JSON.stringify(changed),f.target.tenantId,f.target.projectId]);
      const refreshed=await reader.snapshot({target:f.target,revision:1});expect(refreshed!.snapshot).toEqual(changed);expect(refreshed!.snapshot).not.toBe(initial!.snapshot);expect((await reader.snapshot({target:f.target,revision:1}))!.snapshot).toBe(refreshed!.snapshot);expect(initial!.snapshot).toEqual(f.baseline);
      const corrupted=structuredClone(changed);corrupted.project.scope.expected_episode_count=-1;
      await pool.query('UPDATE camery_versioning.snapshots SET package=$1::jsonb WHERE tenant_id=$2 AND project_id=$3 AND revision=1',[JSON.stringify(corrupted),f.target.tenantId,f.target.projectId]);
      await expect(reader.snapshot({target:f.target,revision:1})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(refreshed!.snapshot).toEqual(changed);
    }finally{await pool.query('UPDATE camery_versioning.snapshots SET package=$1::jsonb WHERE tenant_id=$2 AND project_id=$3 AND revision=1',[JSON.stringify(f.baseline),f.target.tenantId,f.target.projectId]);}
    const restored=await reader.snapshot({target:f.target,revision:1});expect(restored!.snapshot).toEqual(f.baseline);
    try{
      await pool.query('UPDATE camery_versioning.projects SET package_id=$1 WHERE tenant_id=$2 AND project_id=$3',[fixtureId('corrupted-cached-formal-package'),f.target.tenantId,f.target.projectId]);
      await expect(reader.snapshot({target:f.target,revision:1})).rejects.toMatchObject({code:'STORAGE_FAILED'});
    }finally{await pool.query('UPDATE camery_versioning.projects SET package_id=$1 WHERE tenant_id=$2 AND project_id=$3',[f.baseline.package_id,f.target.tenantId,f.target.projectId]);}
    expect((await reader.snapshot({target:f.target,revision:1}))!.snapshot).toEqual(f.baseline);expect(await f.persistenceCounts()).toEqual(before);expect(await outlineVersionCounts(pool,f.target)).toEqual(versionsBefore);
  });
});
