import { randomBytes,randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll,afterAll,expect,it,vi } from 'vitest';
import { migrateIngest } from '../../ingest/src/node/index.js';
import { migrateBible } from '@camery/bible/node';
import { migrateDevelopment,PostgresDevelopmentStore } from '../src/node/index.js';
import { PostgresOutlineStore,migrateOutline,outlineCallId,grantOutlineRuntimeRole,verifyOutlineRuntimeRole,createOutlineSourceTransaction } from '../src/outline/node/index.js';
import { PostgresDocumentStore } from '../../ingest/src/node/index.js';
import { createDevelopmentSourceFixture,createBibleSourceFixture,createOutlineProposal } from './outline-source-pg-support.js';

const url=process.env['CAMERY_TEST_DATABASE_URL'];if(!url)throw new Error('CAMERY_TEST_DATABASE_URL is required for outline persistence tests');
const pool=new Pool({connectionString:url,max:6,connectionTimeoutMillis:5000});const tenants:string[]=[];
beforeAll(async()=>{await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);await migrateOutline(pool);await migrateOutline(pool);});
afterAll(async()=>{
  let failed=false;
  try{for(const tenant of tenants)for(const [schema,tables] of [['camery_outline',['reviews','candidates','runs','briefs']],['camery_script',['run_origins','reviews','candidates','runs','briefs']],['camery_bible',['reviews','candidates','chunks','runs']],['camery_ingest',['reading_checkpoints','documents']]] as const)
    for(const table of tables)try{await pool.query(`DELETE FROM ${schema}.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
  }finally{await pool.end();}if(failed)throw new Error('Outline persistence fixture cleanup failed');
});
function gate<T>(){let resolve!:(value:T)=>void;return {promise:new Promise<T>(done=>{resolve=done;}),resolve:(value:T)=>resolve(value)};}
async function fixture(kind:'development'|'bible'='development'){
  const target={tenantId:'outline-persist-'+randomUUID(),projectId:'project'};tenants.push(target.tenantId);
  const source=kind==='development'?await createDevelopmentSourceFixture(pool,target):await createBibleSourceFixture(pool,target);
  const store=new PostgresOutlineStore(pool),key={...target,runId:'outline'};
  const put={...target,briefId:'adaptation',expectedRevision:0,actorId:'fixture-editor',notes:'保持已审阅港城故事。',episodeCount:3,targetSeconds:90,paidEpisodeNumbers:[3],mainGenre:'rebirth-revenge',auxiliaryGenres:['suspense']};
  const brief=(await store.putBrief(put)).brief;
  const execution={connectionId:'outline-source-fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture/outline',evidence:'synthetic_replay',modelTier:'balanced',currency:'CNY',reservation:{tokens:300,costMicros:0},limits:{steps:1,tokens:300,costMicros:0}};
  const command={...key,briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest,source:source.descriptor,execution};
  const run=await store.start(command);const proposal=await createOutlineProposal(run.source,{brief:run.brief,callId:outlineCallId(key)});
  const decision={candidateDigest:proposal.candidate.digest,output:proposal.output,ablations:proposal.review.ablations,waivers:proposal.review.waivers};
  return {target,key,source,store,put,command,run,...proposal,decision};
}
it.each(['development','bible'] as const)('persists %s sourced outlines and exact concurrent decisions, then restores from another pool',async kind=>{
  const f=await fixture(kind);const starts=await Promise.all(Array.from({length:3},()=>f.store.start({...f.command,runId:'concurrent'})));expect(starts.every(run=>run.digest===starts[0]!.digest)).toBe(true);
  expect(await Promise.all([f.store.saveCandidate(f.key,f.candidate),f.store.saveCandidate(f.key,f.candidate)])).toEqual([f.candidate,f.candidate]);
  const reviews=await Promise.all([f.store.review(f.key,f.decision,f.host),f.store.review(f.key,f.decision,{...f.host,at:'2026-11-17T12:00:00.000Z'})]);expect(reviews[0]).toEqual(reviews[1]);
  const replacement=new Pool({connectionString:url,max:1});try{const restored=await new PostgresOutlineStore(replacement).read(f.key);expect(restored).toEqual({run:f.run,candidate:f.candidate,review:reviews[0]});}finally{await replacement.end();}
  await expect(f.store.read({...f.key,tenantId:'unrelated'})).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('keeps paid old results, rejects first stale review and allows explicit historical rejection',async()=>{
  const f=await fixture();if(!('put' in f.source))throw new Error('Development fixture expected');
  await f.source.store.putBrief({...f.source.put,expectedRevision:1,idea:'已变更的原始创意。'});expect(await f.store.isCurrent(f.key)).toBe(false);
  await f.store.saveCandidate(f.key,f.candidate);await expect(f.store.review(f.key,f.decision,f.host)).rejects.toMatchObject({code:'CONFLICT'});
  const rejected=await f.store.reject(f.key,'旧来源需要重做。',f.host);expect((await f.store.read(f.key)).review).toEqual(rejected);
});
it('recovers an actual commit whose acknowledgement was lost and preserves current authorization on retry',async()=>{
  const f=await fixture();let lost=false;
  const wrapped={query:pool.query.bind(pool),async connect(){const client=await pool.connect();return {async query(sql:string,values?:unknown[]){const result=await client.query(sql,values);if(sql==='COMMIT'&&!lost){lost=true;throw new Error('private commit acknowledgement');}return result;},release:client.release.bind(client)};}} as unknown as Pool;
  await expect(new PostgresOutlineStore(wrapped).saveCandidate(f.key,f.candidate)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(await f.store.saveCandidate(f.key,f.candidate)).toEqual(f.candidate);
  lost=false;await expect(new PostgresOutlineStore(wrapped).review(f.key,f.decision,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const stored=(await f.store.read(f.key)).review;await f.store.putBrief({...f.put,expectedRevision:1,notes:'新的改编目标。'});
  expect(await f.store.review(f.key,f.decision,{...f.host,at:'2026-11-17T13:00:00.000Z'})).toEqual(stored);
  await expect(f.store.review(f.key,f.decision,{...f.host,authorize:()=>false})).rejects.toMatchObject({code:'FORBIDDEN'});
});
it('refuses damaged stored candidate columns and rolls back a new review when the source reader fails',async()=>{
  const f=await fixture();await f.store.saveCandidate(f.key,f.candidate);
  const broken=new PostgresOutlineStore(pool,async()=>{throw new Error('private source failure');});await expect(broken.review(f.key,f.decision,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  expect((await f.store.read(f.key)).review).toBeNull();
  await pool.query('UPDATE camery_outline.candidates SET digest=$4 WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',[f.key.tenantId,f.key.projectId,f.key.runId,'b'.repeat(64)]);
  await expect(f.store.read(f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('forces READ COMMITTED before waiting on a changed source even when the reader default is repeatable read',async()=>{
  const f=await fixture();if(!('put' in f.source))throw new Error('Development fixture expected');await f.store.saveCandidate(f.key,f.candidate);
  const held=gate<number>(),release=gate<void>();const writerPool=new Pool({connectionString:url,max:1});const name='outline_rr_'+randomUUID();const readerPool=new Pool({connectionString:url,max:1,application_name:name});
  const writerWrapped={query:writerPool.query.bind(writerPool),async connect(){const client=await writerPool.connect();return {async query(sql:string,values?:unknown[]){if(sql==='COMMIT'){held.resolve((await client.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid);await release.promise;}return client.query(sql,values);},release:client.release.bind(client)};}} as unknown as Pool;
  const readerWrapped={query:readerPool.query.bind(readerPool),async connect(){const client=await readerPool.connect();await client.query("SET default_transaction_isolation='repeatable read'");return client;}} as unknown as Pool;
  const write=new PostgresDevelopmentStore(writerWrapped).putBrief({...f.source.put,expectedRevision:1,idea:'先提交的来源修订。'});const pid=await held.promise;
  const review=new PostgresOutlineStore(readerWrapped).review(f.key,f.decision,f.host);void review.catch(()=>{});
  try{
    await vi.waitFor(async()=>{const activity=await pool.query<{blockers:number[]}>('SELECT pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE application_name=$1',[name]);expect(activity.rows.some(row=>row.blockers.includes(pid))).toBe(true);},{timeout:5000,interval:20});
    release.resolve();await write;await expect(review).rejects.toMatchObject({code:'CONFLICT'});expect((await f.store.read(f.key)).review).toBeNull();
  }finally{release.resolve();await write.catch(()=>{});await review.catch(()=>{});await writerPool.end();await readerPool.end();}
});
it.each(['development','bible'] as const)('holds actual %s source locks through the new outline review commit',async kind=>{
  const f=await fixture(kind);await f.store.saveCandidate(f.key,f.candidate);const sourceRead=createOutlineSourceTransaction(pool),held=gate<number>(),release=gate<void>();
  const protectedStore=new PostgresOutlineStore(pool,async(client,descriptor)=>{const source=await sourceRead(client,descriptor);held.resolve((await client.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid);await release.promise;return source;});
  const review=protectedStore.review(f.key,f.decision,f.host);void review.catch(()=>{});const pid=await held.promise;
  const name='outline_source_writer_'+randomUUID(),writerPool=new Pool({connectionString:url,max:1,application_name:name});
  const write='put' in f.source?new PostgresDevelopmentStore(writerPool).putBrief({...f.source.put,expectedRevision:1,idea:'审阅提交后的新来源。'}):new PostgresDocumentStore(writerPool).append({...f.target,documentId:'book',batchId:'next',expectedRevision:1,text:'审阅后追加。'});void write.catch(()=>{});
  try{
    await vi.waitFor(async()=>{const activity=await pool.query<{blockers:number[]}>('SELECT pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE application_name=$1',[name]);expect(activity.rows.some(row=>row.blockers.includes(pid))).toBe(true);},{timeout:5000,interval:20});
    release.resolve();const reviewed=await review;await write;expect(await f.store.isCurrent(f.key)).toBe(false);expect(await f.store.review(f.key,f.decision,f.host)).toEqual(reviewed);
  }finally{release.resolve();await review.catch(()=>{});await write.catch(()=>{});await writerPool.end();}
});
it('uses a dedicated LOGIN for outline appends and source reads, rejecting missing or expanded privileges',async()=>{
  const f=await fixture(),suffix=randomBytes(8).toString('hex'),role='outline_'+suffix,member='outline_member_'+suffix,password=randomBytes(24).toString('hex');
  const table='public.outline_probe_'+suffix,sequence='public.outline_sequence_'+suffix;let runtime:Pool|undefined,roleCreated=false,memberCreated=false,tableCreated=false,sequenceCreated=false;
  if(!('put' in f.source))throw new Error('Development fixture expected');
  try{
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);roleCreated=true;await grantOutlineRuntimeRole(pool,role);
    const targetUrl=new URL(url!);targetUrl.username=role;targetUrl.password=password;runtime=new Pool({connectionString:targetUrl.toString(),max:2});await verifyOutlineRuntimeRole(runtime);await expect(verifyOutlineRuntimeRole(pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    const store=new PostgresOutlineStore(runtime),brief=(await store.putBrief({...f.put,briefId:'runtime'})).brief,key={...f.key,runId:'runtime'};
    const run=await store.start({...f.command,...key,briefId:brief.briefId,expectedBriefDigest:brief.digest});const proposal=await createOutlineProposal(run.source,{brief:run.brief,callId:outlineCallId(key)});await store.saveCandidate(key,proposal.candidate);
    const reviewed=await store.review(key,{candidateDigest:proposal.candidate.digest,output:proposal.output,ablations:proposal.review.ablations,waivers:[]},proposal.host);expect((await store.read(key)).review).toEqual(reviewed);
    const bible=await createBibleSourceFixture(pool,f.target),bibleKey={...key,runId:'runtime-bible'};
    const bibleRun=await store.start({...f.command,...bibleKey,briefId:brief.briefId,expectedBriefDigest:brief.digest,source:bible.descriptor});
    const bibleProposal=await createOutlineProposal(bibleRun.source,{brief:bibleRun.brief,callId:outlineCallId(bibleKey)});await store.saveCandidate(bibleKey,bibleProposal.candidate);
    const bibleReview=await store.review(bibleKey,{candidateDigest:bibleProposal.candidate.digest,output:bibleProposal.output,ablations:bibleProposal.review.ablations,waivers:[]},bibleProposal.host);
    expect((await store.read(bibleKey)).review).toEqual(bibleReview);expect(await store.isCurrent(bibleKey)).toBe(true);
    const denied:[string,unknown[]][]=[
      ['UPDATE camery_outline.briefs SET record=record WHERE tenant_id=$1 AND project_id=$2 AND brief_id=$3',[f.target.tenantId,f.target.projectId,brief.briefId]],
      ['DELETE FROM camery_outline.reviews WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',[key.tenantId,key.projectId,key.runId]],
      ['SELECT * FROM camery_outline.migrations',[]],
      ["INSERT INTO camery_script.briefs(tenant_id,project_id,brief_id,revision,actor_id,digest,request_digest,record) SELECT tenant_id,project_id,'outline-denied-probe',revision,actor_id,digest,request_digest,record FROM camery_script.briefs WHERE tenant_id=$1 AND project_id=$2 AND brief_id=$3 AND revision=1",[f.target.tenantId,f.target.projectId,f.source.put.briefId]],
    ];
    for(const [query,values] of denied)await expect(runtime.query(query,values)).rejects.toMatchObject({code:'42501'});
    const permissions=[...['briefs','runs','candidates','reviews'].flatMap(name=>['SELECT','INSERT'].map(privilege=>['camery_outline.'+name,privilege])),...['camery_script.briefs','camery_script.runs','camery_script.candidates','camery_script.reviews','camery_script.run_origins','camery_bible.runs','camery_bible.chunks','camery_bible.candidates','camery_bible.reviews','camery_ingest.documents','camery_ingest.scripts'].map(name=>[name,'SELECT'])];
    for(const [relation,privilege] of permissions){await pool.query(`REVOKE ${privilege} ON ${relation} FROM ${role}`);try{await expect(verifyOutlineRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await pool.query(`GRANT ${privilege} ON ${relation} TO ${role}`);}}
    await pool.query(`CREATE TABLE ${table}(value integer)`);tableCreated=true;await pool.query(`CREATE SEQUENCE ${sequence}`);sequenceCreated=true;
    const probes=[['camery_outline.briefs','UPDATE(record)'],['camery_outline.reviews','REFERENCES(record)'],['camery_bible.reviews','INSERT'],['camery_script.briefs','UPDATE(record)'],['camery_outline.migrations','SELECT'],...[ 'SELECT','INSERT','UPDATE','SELECT(value)','INSERT(value)','UPDATE(value)','REFERENCES(value)'].map(privilege=>[table,privilege])];
    for(const [relation,privilege] of probes){await pool.query(`GRANT ${privilege} ON ${relation} TO ${role}`);try{await expect(verifyOutlineRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await pool.query(`REVOKE ${privilege} ON ${relation} FROM ${role}`);}}
    for(const object of ['camery_outline.briefs','camery_bible.reviews']){await pool.query(`GRANT SELECT ON ${object} TO ${role} WITH GRANT OPTION`);try{await expect(verifyOutlineRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await pool.query(`REVOKE GRANT OPTION FOR SELECT ON ${object} FROM ${role}`);}}
    await pool.query(`GRANT SELECT(record) ON camery_outline.briefs TO ${role} WITH GRANT OPTION`);try{await expect(verifyOutlineRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await pool.query(`REVOKE SELECT(record) ON camery_outline.briefs FROM ${role}`);}
    for(const privilege of ['USAGE','SELECT','UPDATE']){await pool.query(`GRANT ${privilege} ON SEQUENCE ${sequence} TO ${role}`);try{await expect(verifyOutlineRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await pool.query(`REVOKE ${privilege} ON SEQUENCE ${sequence} FROM ${role}`);}}
    for(const privilege of ['CREATE','USAGE WITH GRANT OPTION']){await pool.query(`GRANT ${privilege==='CREATE'?'CREATE':'USAGE'} ON SCHEMA camery_outline TO ${role}${privilege==='CREATE'?'':' WITH GRANT OPTION'}`);try{await expect(verifyOutlineRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await pool.query(`REVOKE ${privilege==='CREATE'?'CREATE':'GRANT OPTION FOR USAGE'} ON SCHEMA camery_outline FROM ${role}`);}}
    await pool.query(`CREATE ROLE ${member} NOLOGIN`);memberCreated=true;await pool.query(`GRANT ${member} TO ${role}`);try{await expect(verifyOutlineRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await pool.query(`REVOKE ${member} FROM ${role}`);}
    for(const [expanded,normal] of [['INHERIT','NOINHERIT'],['NOLOGIN','LOGIN'],['REPLICATION','NOREPLICATION']]){await pool.query(`ALTER ROLE ${role} ${expanded}`);try{await expect(verifyOutlineRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await pool.query(`ALTER ROLE ${role} ${normal}`);}}
    await verifyOutlineRuntimeRole(runtime);
  }finally{
    await runtime?.end();let failed=false;
    for(const cleanup of [...(roleCreated?[()=>pool.query(`DROP OWNED BY ${role}`),()=>pool.query(`DROP ROLE ${role}`)]:[]),...(memberCreated?[()=>pool.query(`DROP ROLE ${member}`)]:[]),...(tableCreated?[()=>pool.query(`DROP TABLE ${table}`)]:[]),...(sequenceCreated?[()=>pool.query(`DROP SEQUENCE ${sequence}`)]:[])])try{await cleanup();}catch{failed=true;}
    // oxlint-disable-next-line eslint/no-unsafe-finally -- A failed cleanup must fail this isolated role fixture as well as its assertions.
    if(failed)throw new Error('Outline LOGIN fixture cleanup failed');
  }
});
