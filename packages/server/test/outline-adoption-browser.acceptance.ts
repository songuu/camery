/** Explicit Chromium gate: source review, authentication, project upgrades and outline writes use actual PostgreSQL stores. Model text is synthetic. */
import {fork} from 'node:child_process';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {migrateAccess} from '@camery/access/node';
import {migrateDurable,PostgresDurableStore} from '@camery/durable';
import {migrateAgents} from '@camery/agents/node';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import {migrateIngest,PostgresDocumentStore,PostgresScriptStore} from '@camery/ingest/node';
import {migrateBible} from '@camery/bible/node';
import {migrateDevelopment} from '@camery/script/node';
import {migrateOutline,migrateOutlineIdentities,PostgresOutlineStore,PostgresOutlineCatalog,PostgresOutlineBriefCatalog,PostgresOutlineSourceCatalog,grantOutlineRuntimeRole,verifyOutlineRuntimeRole} from '@camery/script/outline/node';
import {ChangeSetV07,StoryboardPackageV07,validatePackage} from '@camery/ir';
import {createApplication} from '../src/app.js';
import {migrateProjectIdentities} from '../src/projects/migrate.js';
import {migrateOutlineProjectIntents} from '../src/projects/outline-intent-migrate.js';
import {grantProjectIdentityReaderRole} from '../src/projects/identity-role.js';
import {grantProjectAdoptionRole} from '../src/projects/adoption-role.js';
import {grantOutlineProjectAdoptionRole} from '../src/projects/outline-adoption-role.js';
import {createProjectRuntime} from '../src/projects/runtime.js';
import {createOutlineAdoptionRuntime} from '../src/projects/outline-adoption-runtime.js';
import {OutlineAdoptionApplication} from '../src/projects/outline-adoption-application.js';
import {outlineAdoptionPgFixture} from './outline-adoption-pg-support.js';
import {allocateOutlineIntentId} from './outline-intent-pg-support.js';
import {formalRoleFixture} from './outline-formal-runtime-pg-support.js';
import {fixtureId,makePackage} from '../../ir/test/fixtures.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];
if(!databaseUrl)throw new Error('Explicit test PostgreSQL is required for the formal outline browser gate');
const pool=new Pool({connectionString:databaseUrl,max:10,connectionTimeoutMillis:5000}),owned:string[]=[];
beforeAll(async()=>{await migrateAccess(pool);await migrateDurable(pool);await migrateAgents(pool);await migrateVersioning(pool);await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);await migrateOutline(pool);await migrateOutlineIdentities(pool);await migrateProjectIdentities(pool);await migrateOutlineProjectIntents(pool);});
afterAll(async()=>{
  let failed=false;
  try{for(const tenant of owned){
    for(const [schema,tables] of [
      ['camery_projects',['outline_decision_receipts','outline_decision_intents','outline_candidate_receipts','outline_candidate_intents','decision_receipts','decision_intents','candidate_receipts','candidate_intents','principals','projects','tenants']],
      ['camery_outline',['identity_preparations']],['camery_script',['ir_identities']],['camery_outline',['reviews','candidates','runs','briefs']],['camery_script',['run_origins','reviews','candidates','runs','briefs']],
      ['camery_bible',['reviews','candidates','chunks','runs']],['camery_ingest',['reading_checkpoints','documents']],['camery_access',['sessions','memberships','users']],
    ] as const)for(const table of tables)try{await pool.query('DELETE FROM '+schema+'.'+table+' WHERE tenant_id=$1',[tenant]);}catch{failed=true;}
    const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query('DELETE FROM camery_versioning.'+table+' WHERE tenant_id=$1 AND project_id=$2',[fixtureId('formal-tenant-'+tenant),fixtureId('formal-project-'+tenant)]);await client.query('COMMIT');}catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}
  }}finally{await pool.end();}
  if(failed)throw new Error('Owned formal browser fixture cleanup failed');
});

it('uses the authenticated browser for two explicit upgrades, original-ID ACK recovery, formal adoption and historical reading against actual PG',async()=>{
  const f=await outlineAdoptionPgFixture(pool,owned),roles=formalRoleFixture(pool,databaseUrl!);
  let projects:Awaited<ReturnType<typeof createProjectRuntime>>|undefined,formal:Awaited<ReturnType<typeof createOutlineAdoptionRuntime>>|undefined,sourcePool:Pool|undefined,app:Awaited<ReturnType<typeof createApplication>>|undefined;
  let child:ReturnType<typeof fork>|undefined,diagnostic='',next:Awaited<ReturnType<typeof f.next>>|undefined;
  const safe=(value:string)=>[f.headers.editor,f.headers.reviewer,f.headers.viewer].reduce((text,header)=>text.replaceAll(header.authorization.slice(7),'[fixture credential]'),value);
  try{
    // This explicit installer-owned fixture starts from a valid legacy snapshot; runtime/browser code must perform both forward upgrades.
    const legacy=structuredClone(makePackage());for(const [key,value] of Object.entries(legacy))if(Array.isArray(value))(legacy as unknown as Record<string,unknown>)[key]=[];
    legacy.project.id=f.target.projectId;legacy.package_id=f.baseline.package_id;legacy.project.source_ids=[];legacy.project.rights_status='unknown';legacy.project.scope={label:'明确的浏览器升级基线',expected_episode_count:0,expected_scene_count:0,expected_required_beat_count:0};legacy.revision={number:1,status:'adopted',note:'Explicit browser fixture installation'};
    expect(validatePackage(legacy).valid).toBe(true);
    await pool.query('UPDATE camery_versioning.snapshots SET package=$1::jsonb WHERE tenant_id=$2 AND project_id=$3 AND revision=1',[JSON.stringify(legacy),f.target.tenantId,f.target.projectId]);
    await f.sessions.provisionMember({...f.scope,userId:'editor',role:'admin'});
    const reader=await roles.create('browser_reader',grantProjectIdentityReaderRole),old=await roles.create('browser_old',grantProjectAdoptionRole),adopter=await roles.create('browser_outline',grantOutlineProjectAdoptionRole),source=await roles.create('browser_source',grantOutlineRuntimeRole);
    projects=await createProjectRuntime({tenantId:f.scope.tenantId,readerDatabaseUrl:reader.url,adoptionDatabaseUrl:old.url});
    formal=await createOutlineAdoptionRuntime({tenantId:f.scope.tenantId,readerDatabaseUrl:reader.url,adoptionDatabaseUrl:adopter.url});
    sourcePool=new Pool({connectionString:source.url,max:3,connectionTimeoutMillis:5000});await verifyOutlineRuntimeRole(sourcePool);
    const sourceStore=new PostgresOutlineStore(sourcePool);
    app=await createApplication({tenantId:f.scope.tenantId,store:f.sessions,frontendDirectory:resolve('../web/dist'),
      sources:{novels:new PostgresDocumentStore(pool),scripts:new PostgresScriptStore(pool)},
      projects:projects.options,outlineAdoption:formal.adoptionOptions,outlineFormal:formal.formalOptions,
      outlines:{store:sourceStore,catalog:new PostgresOutlineCatalog(sourcePool),briefs:new PostgresOutlineBriefCatalog(sourcePool),sources:new PostgresOutlineSourceCatalog(sourcePool),tasks:new PostgresDurableStore(pool),presetFor:()=>null}});
    await app.listen(0,'127.0.0.1');
    const before=await f.store.read(f.key),calls=f.calls();
    child=fork(resolve('../../scripts/outline-adoption-browser.mjs'),[await app.getUrl()],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
    const ownedChild=child;child.stdout?.on('data',data=>{if(diagnostic.length<200000)diagnostic+=safe(String(data));});child.stderr?.on('data',data=>{if(diagnostic.length<200000)diagnostic+=safe(String(data));});
    const native=async()=>{const current=(await f.versions.read(f.target))!;return {head:current.state.head.revision.number,write:current.writeVersion,schema:current.state.head.schema_version,changes:current.state.changes.length,adoptions:current.state.adoptions.length};};
    async function control(input:unknown){
      const message=input as {id?:number;action?:string};if(!Number.isSafeInteger(message.id)||typeof message.action!=='string')return;
      let data:unknown=null;
      if(message.action==='fixture')data={projectId:f.scope.projectId,runId:f.source.runId,title:f.progress.review?.status==='reviewed'?f.progress.review.output.adaptation.title:'',editorToken:f.headers.editor.authorization.slice(7),viewerToken:f.headers.viewer.authorization.slice(7)};
      else if(message.action==='native')data=await native();
      else if(message.action==='revoke-write')await f.sessions.provisionMember({...f.scope,userId:'editor',role:'viewer'});
      else if(message.action==='restore-write')await f.sessions.provisionMember({...f.scope,userId:'editor',role:'admin'});
      else if(message.action==='next-source'){next=await f.next('browser-next-outline',4);data={runId:next.source.runId};}
      else if(message.action==='stale-source'){if(!next)throw new Error('Expected the owned next source');await f.store.putBrief({...f.put,expectedRevision:next.run.brief.revision,episodeCount:4,paidEpisodeNumbers:[4],notes:'明确修改简报使本次浏览器候选来源过期。'});}
      else if(message.action==='later-head'){
        const versions=new PostgresVersionStore(pool),current=(await versions.read(f.target))!,head=StoryboardPackageV07.parse(current.state.head),plan=head.adaptation_plans[0]!,actor=(await f.authority('reviewer')).principal;
        const request=ChangeSetV07.parse({schema_version:'0.7.0-draft',id:fixtureId('browser-native-later-'+f.scope.tenantId),author:actor,status:'candidate',base_revision:head.revision.number,base_revisions:[{id:plan.id,version:plan.version}],ops:[{op:'update',op_id:fixtureId('browser-native-later-op'),collection:'adaptation_plans',target:plan.id,set:{adaptation:{...plan.adaptation,title:'后续正式大纲',logline:'<img src=x onerror="globalThis.formalOutlineXss=1">'}}}]});
        const prepared=await versions.submit(f.target,request);expect(prepared.status).toBe('candidate');const result=await versions.adopt(f.target,request.id,{actor,scope:{kind:'project',id:f.target.projectId},at:new Date().toISOString(),authorize:()=>true,expectation:{expectedSnapshotRevision:head.revision.number,expectedWriteVersion:prepared.writeVersion}});expect(result.status).toBe('adopted');data=await native();
      }else throw new Error('Unknown owned browser control');
      if(ownedChild.connected)ownedChild.send({id:message.id,data});
    }
    child.on('message',input=>{void control(input).catch(()=>{if(ownedChild.connected)ownedChild.send({id:(input as {id?:number}).id,error:'Owned browser control failed'});});});
    const code=await new Promise<number|null>((accept,reject)=>{const timer=setTimeout(()=>{ownedChild.kill();reject(new Error('Formal browser process exceeded its owned acceptance deadline'));},150000);ownedChild.once('exit',code=>{clearTimeout(timer);accept(code);});ownedChild.once('error',error=>{clearTimeout(timer);reject(error);});});
    expect(code,diagnostic).toBe(0);
    const after=await f.store.read(f.key);expect(after.review).toEqual(before.review);expect(after.candidate).toEqual(before.candidate);expect(f.calls()).toBe(calls+1);
    const result=await native();expect(result).toMatchObject({head:5,schema:'0.7.0-draft',changes:5,adoptions:4});
    console.log(diagnostic.trim());
  }finally{
    if(child&&child.exitCode===null)child.kill();await app?.close();await formal?.close();await projects?.close();await sourcePool?.end();await roles.close();
  }
},180000);

it('reads every genuine preparation and adoption warning beyond 500 through the browser without read-side writes',async()=>{
  const f=await outlineAdoptionPgFixture(pool,owned),roles=formalRoleFixture(pool,databaseUrl!);
  let projects:Awaited<ReturnType<typeof createProjectRuntime>>|undefined,formal:Awaited<ReturnType<typeof createOutlineAdoptionRuntime>>|undefined,sourcePool:Pool|undefined,app:Awaited<ReturnType<typeof createApplication>>|undefined,child:ReturnType<typeof fork>|undefined,diagnostic='';
  let allocations=0,identityPreparations=0;
  const safe=(value:string)=>[f.headers.editor,f.headers.reviewer,f.headers.viewer].reduce((text,header)=>text.replaceAll(header.authorization.slice(7),'[fixture credential]'),value);
  try{
    await f.sessions.provisionMember({...f.scope,userId:'editor',role:'admin'});
    const reader=await roles.create('warnings_reader',grantProjectIdentityReaderRole),old=await roles.create('warnings_old',grantProjectAdoptionRole),adopter=await roles.create('warnings_outline',grantOutlineProjectAdoptionRole),source=await roles.create('warnings_source',grantOutlineRuntimeRole);
    projects=await createProjectRuntime({tenantId:f.scope.tenantId,readerDatabaseUrl:reader.url,adoptionDatabaseUrl:old.url});
    formal=await createOutlineAdoptionRuntime({tenantId:f.scope.tenantId,readerDatabaseUrl:reader.url,adoptionDatabaseUrl:adopter.url});
    const real=formal.adoptionOptions,options={...real,newId:()=>{allocations++;return real.newId();},outline:{...real.outline,identities:{prepare:async(input:Parameters<typeof real.outline.identities.prepare>[0])=>{identityPreparations++;return real.outline.identities.prepare(input);}}}};
    const application=new OutlineAdoptionApplication(options),editor=await f.subject('editor'),reviewer=await f.subject('reviewer');
    const initial=await application.prepareOutline({subject:editor,projectId:f.scope.projectId,runId:f.source.runId,command:f.command('browser-warnings-initial')});
    await application.adoptCandidate({subject:reviewer,projectId:f.scope.projectId,candidateId:initial.candidateId,requestId:'browser-warnings-initial-adopt',command:{expectedSnapshotRevision:1,expectedWriteVersion:initial.writeVersion}});
    let current=(await f.versions.read(f.target))!;
    const historicalPlan=structuredClone(StoryboardPackageV07.parse(current.state.head).adaptation_plans[0]!),actor=(await f.authority('reviewer')).principal;
    async function nativeCommit(ops:ChangeSetV07['ops']){
      const stored=(await f.versions.read(f.target))!,rows=Object.values(stored.state.head).flatMap(value=>Array.isArray(value)?value:[]) as {id:string;version:number}[];
      const request=ChangeSetV07.parse({schema_version:'0.7.0-draft',id:allocateOutlineIntentId(),author:actor,status:'candidate',base_revision:stored.state.head.revision.number,base_revisions:ops.flatMap(op=>'target' in op?[{id:op.target,version:rows.find(row=>row.id===op.target)!.version}]:[]),ops});
      const prepared=await f.versions.submit(f.target,request);expect(prepared.status).toBe('candidate');
      const result=await f.versions.adopt(f.target,request.id,{actor,scope:{kind:'project',id:f.target.projectId},at:new Date().toISOString(),authorize:()=>true,expectation:{expectedSnapshotRevision:stored.state.head.revision.number,expectedWriteVersion:prepared.writeVersion}});expect(result.status).toBe('adopted');
    }
    const character=f.prepared.identities.characters[0]!.id;
    await nativeCommit([{op:'update',op_id:allocateOutlineIntentId(),collection:'characters',target:character,set:{name:'Native temporary browser warning edit'}}]);current=(await f.versions.read(f.target))!;
    const restored=await application.prepareOutline({subject:editor,projectId:f.scope.projectId,runId:f.source.runId,command:f.command('browser-warnings-restore',f.source,current.state.head.revision.number,current.writeVersion)});
    await application.adoptCandidate({subject:reviewer,projectId:f.scope.projectId,candidateId:restored.candidateId,requestId:'browser-warnings-restore-adopt',command:{expectedSnapshotRevision:current.state.head.revision.number,expectedWriteVersion:restored.writeVersion}});
    // Valid historical pins create real dependency warnings in the native engine; no warning text or receipt is fabricated.
    await nativeCommit(Array.from({length:64},()=>({op:'add' as const,op_id:allocateOutlineIntentId(),collection:'adaptation_plans' as const,value:{...structuredClone(historicalPlan),id:allocateOutlineIntentId()}})));
    await nativeCommit([{op:'update',op_id:allocateOutlineIntentId(),collection:'characters',target:character,set:{name:'Native subsequent browser warning edit'}}]);
    sourcePool=new Pool({connectionString:source.url,max:3,connectionTimeoutMillis:5000});await verifyOutlineRuntimeRole(sourcePool);
    app=await createApplication({tenantId:f.scope.tenantId,store:f.sessions,frontendDirectory:resolve('../web/dist'),sources:{novels:new PostgresDocumentStore(pool),scripts:new PostgresScriptStore(pool)},projects:projects.options,outlineAdoption:options,outlineFormal:formal.formalOptions,outlines:{store:new PostgresOutlineStore(sourcePool),catalog:new PostgresOutlineCatalog(sourcePool),briefs:new PostgresOutlineBriefCatalog(sourcePool),sources:new PostgresOutlineSourceCatalog(sourcePool),tasks:new PostgresDurableStore(pool),presetFor:()=>null}});
    await app.listen(0,'127.0.0.1');const before=await f.store.read(f.key),calls=f.calls();
    child=fork(resolve('../../scripts/outline-adoption-browser.mjs'),[await app.getUrl(),'warnings'],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});const ownedChild=child;
    child.stdout?.on('data',data=>{if(diagnostic.length<200000)diagnostic+=safe(String(data));});child.stderr?.on('data',data=>{if(diagnostic.length<200000)diagnostic+=safe(String(data));});
    async function control(input:unknown){
      const message=input as {id?:number;action?:string;kind?:string;requestId?:string;candidateId?:string};if(!Number.isSafeInteger(message.id))return;let data:unknown;
      if(message.action==='fixture')data={projectId:f.scope.projectId,runId:f.source.runId,title:before.review?.status==='reviewed'?before.review.output.adaptation.title:'',editorToken:f.headers.editor.authorization.slice(7)};
      else if(message.action==='warning-counters'){const stored=(await f.versions.read(f.target))!;data={head:stored.state.head.revision.number,write:stored.writeVersion,changes:stored.state.changes.length,adoptions:stored.state.adoptions.length,allocations,identityPreparations,persistence:await f.persistenceCounts(),sourceCalls:f.calls()};}
      else if(message.action==='warnings-receipt'){
        if(typeof message.requestId!=='string'||typeof message.candidateId!=='string'||!['preparation','decision'].includes(message.kind??''))throw new Error('Invalid owned warning oracle');
        const receipt=message.kind==='preparation'?await f.intents.readPreparationReceipt({scope:f.scope,applicationId:message.requestId}):await f.intents.readDecisionReceipt({scope:f.scope,actorKind:'user',actorKey:'editor',requestId:message.requestId});
        if(!receipt||receipt.changeId!==message.candidateId)throw new Error('Missing actual warning receipt');
        data={warnings:receipt.warnings,status:receipt.status};
      }else throw new Error('Unknown owned warning browser control');
      if(ownedChild.connected)ownedChild.send({id:message.id,data});
    }
    child.on('message',input=>{void control(input).catch(()=>{if(ownedChild.connected)ownedChild.send({id:(input as {id?:number}).id,error:'Owned warning browser control failed'});});});
    const code=await new Promise<number|null>((accept,reject)=>{const timer=setTimeout(()=>{ownedChild.kill();reject(new Error('Warning browser process exceeded its owned acceptance deadline'));},150000);ownedChild.once('exit',code=>{clearTimeout(timer);accept(code);});ownedChild.once('error',error=>{clearTimeout(timer);reject(error);});});
    expect(code,diagnostic).toBe(0);expect(f.calls()).toBe(calls);expect((await f.store.read(f.key)).review).toEqual(before.review);console.log(diagnostic.trim());
  }finally{if(child&&child.exitCode===null)child.kill();await app?.close();await formal?.close();await projects?.close();await sourcePool?.end();await roles.close();}
},180000);
