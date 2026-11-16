import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { importNovel } from '@camery/ingest';
import { migrateIngest, PostgresDocumentStore } from '@camery/ingest/node';
import { migrateBible } from '../src/node/migrate.js';
import { verifyBibleRuntimeRole } from '../src/node/runtime-role.js';
import { PostgresBibleStore } from '../src/node/store.js';
import { hash } from '../src/data.js';
const url=process.env['CAMERY_TEST_DATABASE_URL'];if(!url)throw new Error('CAMERY_TEST_DATABASE_URL is required for Bible role tests');
it('runs Bible writes through an independent append-only LOGIN and rejects privilege expansion',async()=>{
  const admin=new Pool({connectionString:url});const suffix=randomBytes(8).toString('hex');const role='bible_'+suffix;const member=role+'_member';const probeTable='public.bible_permission_probe_'+suffix;const probeSequence='public.bible_permission_sequence_'+suffix;const probeSchema='bible_permission_schema_'+suffix;
  const password=randomBytes(24).toString('hex');let runtime:Pool|undefined;let created=false;let memberCreated=false;let tableCreated=false;let sequenceCreated=false;let schemaCreated=false;
  const key={tenantId:'bible-role-'+randomUUID(),projectId:'project',runId:'research'};
  try{
    await migrateIngest(admin);await migrateBible(admin);await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);created=true;
    await admin.query(`GRANT USAGE ON SCHEMA camery_ingest,camery_bible TO ${role}`);await admin.query(`GRANT SELECT ON camery_ingest.documents,camery_ingest.scripts TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT ON camery_bible.runs,camery_bible.chunks,camery_bible.candidates,camery_bible.reviews TO ${role}`);
    const runtimeUrl=new URL(url!);runtimeUrl.username=role;runtimeUrl.password=password;runtime=new Pool({connectionString:runtimeUrl.toString()});await verifyBibleRuntimeRole(runtime);
    const text='第一章 原文\n小林来到车站。';await new PostgresDocumentStore(admin).append({tenantId:key.tenantId,projectId:'project',documentId:'book',text,batchId:'first',expectedRevision:0});
    const store=new PostgresBibleStore(runtime);const run=await store.start({...key,documentId:'book',kind:'novel',expectedRevision:1,expectedSourceDigest:importNovel(text).sourceDigest,method:{id:'story-bible-extract',version:'1.0.0',digest:hash('role-method')},
      execution:{connectionId:'fixture',modeDigest:hash('mode'),modelIdentity:'fixture',evidence:'synthetic_replay',modelTier:'economy',currency:'CNY',reservation:{tokens:10,costMicros:0},limits:{steps:1,tokens:10,costMicros:0}}});expect(run.source.document.text).toBe(text);expect(await store.isCurrent(key)).toBe(true);
    for(const [table,privilege] of [['camery_ingest.documents','SELECT'],['camery_ingest.scripts','SELECT'],...['runs','chunks','candidates','reviews'].flatMap(table=>[[`camery_bible.${table}`,'SELECT'],[`camery_bible.${table}`,'INSERT']])]){
      await admin.query(`REVOKE ${privilege} ON ${table} FROM ${role}`);await expect(verifyBibleRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});await admin.query(`GRANT ${privilege} ON ${table} TO ${role}`);
    }
    for(const [table,privilege] of [['camery_ingest.documents','UPDATE(snapshot)'],['camery_ingest.scripts','INSERT'],['camery_ingest.reading_checkpoints','SELECT'],['camery_ingest.migrations','SELECT'],['camery_bible.chunks','UPDATE(record)'],['camery_bible.runs','DELETE'],['camery_bible.candidates','TRUNCATE'],['camery_bible.reviews','REFERENCES(record)'],['camery_bible.migrations','SELECT']]){
      await admin.query(`GRANT ${privilege} ON ${table} TO ${role}`);await expect(verifyBibleRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});await admin.query(`REVOKE ${privilege} ON ${table} FROM ${role}`);
    }
    // These objects belong only to this test: an otherwise valid LOGIN must reject privileges outside its whitelist.
    await admin.query(`CREATE TABLE ${probeTable}(value integer)`);tableCreated=true;
    await admin.query(`CREATE SEQUENCE ${probeSequence}`);sequenceCreated=true;
    await admin.query(`CREATE SCHEMA ${probeSchema}`);schemaCreated=true;
    const probes:{privilege:string;rejected:boolean}[]=[];
    for(const privilege of ['SELECT','INSERT','UPDATE','SELECT(value)','INSERT(value)','UPDATE(value)','REFERENCES(value)']){
      await admin.query(`GRANT ${privilege} ON ${probeTable} TO ${role}`);
      try{probes.push({privilege:'table '+privilege,rejected:await verifyBibleRuntimeRole(runtime).then(()=>false,()=>true)});}
      finally{await admin.query(`REVOKE ${privilege} ON ${probeTable} FROM ${role}`);}
    }
    for(const privilege of ['USAGE','SELECT','UPDATE']){
      await admin.query(`GRANT ${privilege} ON SEQUENCE ${probeSequence} TO ${role}`);
      try{probes.push({privilege:'sequence '+privilege,rejected:await verifyBibleRuntimeRole(runtime).then(()=>false,()=>true)});}
      finally{await admin.query(`REVOKE ${privilege} ON SEQUENCE ${probeSequence} FROM ${role}`);}
    }
    await admin.query(`GRANT CREATE ON SCHEMA ${probeSchema} TO ${role}`);
    try{probes.push({privilege:'external schema CREATE',rejected:await verifyBibleRuntimeRole(runtime).then(()=>false,()=>true)});}
    finally{await admin.query(`REVOKE CREATE ON SCHEMA ${probeSchema} FROM ${role}`);}
    expect(probes).toEqual(probes.map(probe=>({...probe,rejected:true})));await verifyBibleRuntimeRole(runtime);
    await admin.query(`GRANT CREATE ON SCHEMA camery_bible TO ${role}`);await expect(verifyBibleRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});await admin.query(`REVOKE CREATE ON SCHEMA camery_bible FROM ${role}`);
    await admin.query(`CREATE ROLE ${member} NOLOGIN`);memberCreated=true;await admin.query(`GRANT ${member} TO ${role}`);await expect(verifyBibleRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});await admin.query(`REVOKE ${member} FROM ${role}`);
    await admin.query(`ALTER ROLE ${role} INHERIT`);await expect(verifyBibleRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});await admin.query(`ALTER ROLE ${role} NOINHERIT`);await verifyBibleRuntimeRole(runtime);
  }finally{
    await runtime?.end();for(const table of ['reviews','candidates','chunks','runs'])await admin.query(`DELETE FROM camery_bible.${table} WHERE tenant_id=$1`,[key.tenantId]);await admin.query('DELETE FROM camery_ingest.documents WHERE tenant_id=$1',[key.tenantId]);
    if(tableCreated)await admin.query(`DROP TABLE ${probeTable}`);if(sequenceCreated)await admin.query(`DROP SEQUENCE ${probeSequence}`);if(schemaCreated)await admin.query(`DROP SCHEMA ${probeSchema}`);
    if(created){
      // Table REVOKE does not remove independent column grants when an assertion interrupts a negative test.
      for(const [table,privilege] of [['camery_ingest.documents','UPDATE(snapshot)'],['camery_bible.chunks','UPDATE(record)'],['camery_bible.reviews','REFERENCES(record)']])await admin.query(`REVOKE ${privilege} ON ${table} FROM ${role}`);
      await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_ingest,camery_bible FROM ${role}`);await admin.query(`REVOKE ALL ON SCHEMA camery_ingest,camery_bible FROM ${role}`);if(memberCreated)await admin.query(`REVOKE ${member} FROM ${role}`);await admin.query(`DROP ROLE ${role}`);
    }
    if(memberCreated)await admin.query(`DROP ROLE ${member}`);await admin.end();
  }
});
