import { randomBytes,randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect,it } from 'vitest';
import { captureBrief } from '../src/brief.js';
import { hash } from '../src/data.js';
import { migrateDevelopment } from '../src/node/migrate.js';
import { grantDevelopmentRuntimeRole,verifyDevelopmentRuntimeRole } from '../src/node/runtime-role.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];
if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL is required for development role tests');

it('uses a dedicated append-only LOGIN and rejects missing, expanded and grantable capabilities across every user schema',async()=>{
  const admin=new Pool({connectionString:databaseUrl});const suffix=randomBytes(8).toString('hex');const role=`development_${suffix}`;const member=`development_member_${suffix}`;
  const table=`public.development_probe_${suffix}`;const sequence=`public.development_sequence_${suffix}`;const schema=`development_schema_${suffix}`;
  const password=randomBytes(24).toString('hex');const tenantId=`development-role-${randomUUID()}`;let runtime:Pool|undefined;let roleCreated=false;let tableCreated=false;let sequenceCreated=false;let schemaCreated=false;let memberCreated=false;
  try{
    await migrateDevelopment(admin);await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);roleCreated=true;
    await grantDevelopmentRuntimeRole(admin,role);const url=new URL(databaseUrl!);url.username=role;url.password=password;runtime=new Pool({connectionString:url.toString()});
    await verifyDevelopmentRuntimeRole(runtime);await expect(verifyDevelopmentRuntimeRole(admin)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    const brief=captureBrief({tenantId,projectId:'project',briefId:'idea',revision:1,idea:'修钟学徒收到来自明天的回信。',episodeCount:10,targetSeconds:120});
    await runtime.query('INSERT INTO camery_script.briefs(tenant_id,project_id,brief_id,revision,actor_id,digest,request_digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[tenantId,'project','idea',1,'fixture-human',brief.digest,hash('fixture-write'),JSON.stringify(brief)]);
    expect((await runtime.query('SELECT record FROM camery_script.briefs WHERE tenant_id=$1',[tenantId])).rows[0]?.record).toEqual(brief);
    await expect(runtime.query('UPDATE camery_script.briefs SET record=record WHERE tenant_id=$1',[tenantId])).rejects.toMatchObject({code:'42501'});
    await expect(runtime.query('DELETE FROM camery_script.briefs WHERE tenant_id=$1',[tenantId])).rejects.toMatchObject({code:'42501'});
    await expect(runtime.query('SELECT * FROM camery_script.migrations')).rejects.toMatchObject({code:'42501'});
    for(const relation of ['briefs','runs','candidates','reviews','run_origins'])for(const privilege of ['SELECT','INSERT']){
      await admin.query(`REVOKE ${privilege} ON camery_script.${relation} FROM ${role}`);
      try{await expect(verifyDevelopmentRuntimeRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await admin.query(`GRANT ${privilege} ON camery_script.${relation} TO ${role}`);}
    }
    await admin.query(`CREATE TABLE ${table}(value integer)`);tableCreated=true;await admin.query(`CREATE SEQUENCE ${sequence}`);sequenceCreated=true;await admin.query(`CREATE SCHEMA ${schema}`);schemaCreated=true;
    const probes:{name:string;rejected:boolean}[]=[];
    for(const [relation,privilege] of [['camery_script.briefs','UPDATE(record)'],['camery_script.reviews','REFERENCES(record)'],['camery_script.runs','DELETE'],['camery_script.candidates','TRUNCATE'],['camery_script.migrations','SELECT'],
      ...['SELECT','INSERT','UPDATE','SELECT(value)','INSERT(value)','UPDATE(value)','REFERENCES(value)'].map(privilege=>[table,privilege])]){
      await admin.query(`GRANT ${privilege} ON ${relation} TO ${role}`);
      try{probes.push({name:`${relation} ${privilege}`,rejected:await verifyDevelopmentRuntimeRole(runtime).then(()=>false,()=>true)});}finally{await admin.query(`REVOKE ${privilege} ON ${relation} FROM ${role}`);}
    }
    await admin.query(`GRANT SELECT ON camery_script.briefs TO ${role} WITH GRANT OPTION`);
    try{probes.push({name:'allowed table grant option',rejected:await verifyDevelopmentRuntimeRole(runtime).then(()=>false,()=>true)});}finally{await admin.query(`REVOKE GRANT OPTION FOR SELECT ON camery_script.briefs FROM ${role}`);}
    await admin.query(`GRANT SELECT(record) ON camery_script.briefs TO ${role} WITH GRANT OPTION`);
    try{probes.push({name:'allowed column grant option',rejected:await verifyDevelopmentRuntimeRole(runtime).then(()=>false,()=>true)});}finally{await admin.query(`REVOKE SELECT(record) ON camery_script.briefs FROM ${role}`);}
    for(const privilege of ['USAGE','SELECT','UPDATE']){
      await admin.query(`GRANT ${privilege} ON SEQUENCE ${sequence} TO ${role}`);
      try{probes.push({name:`sequence ${privilege}`,rejected:await verifyDevelopmentRuntimeRole(runtime).then(()=>false,()=>true)});}finally{await admin.query(`REVOKE ${privilege} ON SEQUENCE ${sequence} FROM ${role}`);}
    }
    for(const relation of [schema,'camery_script']){
      await admin.query(`GRANT CREATE ON SCHEMA ${relation} TO ${role}`);
      try{probes.push({name:`schema ${relation} CREATE`,rejected:await verifyDevelopmentRuntimeRole(runtime).then(()=>false,()=>true)});}finally{await admin.query(`REVOKE CREATE ON SCHEMA ${relation} FROM ${role}`);}
    }
    await admin.query(`GRANT USAGE ON SCHEMA camery_script TO ${role} WITH GRANT OPTION`);
    try{probes.push({name:'allowed schema USAGE grant option',rejected:await verifyDevelopmentRuntimeRole(runtime).then(()=>false,()=>true)});}finally{await admin.query(`REVOKE GRANT OPTION FOR USAGE ON SCHEMA camery_script FROM ${role}`);}
    await admin.query(`CREATE ROLE ${member} NOLOGIN`);memberCreated=true;await admin.query(`GRANT ${member} TO ${role}`);
    try{probes.push({name:'role membership',rejected:await verifyDevelopmentRuntimeRole(runtime).then(()=>false,()=>true)});}finally{await admin.query(`REVOKE ${member} FROM ${role}`);}
    for(const [expanded,restored] of [['INHERIT','NOINHERIT'],['NOLOGIN','LOGIN'],['REPLICATION','NOREPLICATION']]){
      await admin.query(`ALTER ROLE ${role} ${expanded}`);
      try{probes.push({name:`identity ${expanded}`,rejected:await verifyDevelopmentRuntimeRole(runtime).then(()=>false,()=>true)});}finally{await admin.query(`ALTER ROLE ${role} ${restored}`);}
    }
    expect(probes).toEqual(probes.map(probe=>({...probe,rejected:true})));expect(probes).toHaveLength(24);await verifyDevelopmentRuntimeRole(runtime);
  }finally{
    let failed=false;for(const cleanup of [()=>runtime?.end(),()=>admin.query('DELETE FROM camery_script.briefs WHERE tenant_id=$1',[tenantId]),
      ...(roleCreated?[()=>admin.query(`DROP OWNED BY ${role}`),()=>admin.query(`DROP ROLE ${role}`)]:[]),
      ...(tableCreated?[()=>admin.query(`DROP TABLE ${table}`)]:[]),...(sequenceCreated?[()=>admin.query(`DROP SEQUENCE ${sequence}`)]:[]),...(schemaCreated?[()=>admin.query(`DROP SCHEMA ${schema}`)]:[]),
      ...(memberCreated?[()=>admin.query(`DROP ROLE ${member}`)]:[]),()=>admin.end()]){try{await cleanup();}catch{failed=true;}}
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Cleanup must finish for every owned resource and report any failure.
    if(failed)throw new Error('Development role fixture cleanup failed');
  }
});

it('enforces scoped revision and stage foreign keys, identity formats, object records and stage upstream shape',async()=>{
  const admin=new Pool({connectionString:databaseUrl});const tenantId=`development-ddl-${randomUUID()}`;const digest='a'.repeat(64);
  const briefSql='INSERT INTO camery_script.briefs(tenant_id,project_id,brief_id,revision,actor_id,digest,request_digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)';
  const runSql='INSERT INTO camery_script.runs(tenant_id,project_id,run_id,brief_id,brief_revision,brief_digest,methods,execution,digest,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)';
  try{
    await migrateDevelopment(admin);
    const values=[tenantId,'project','idea',1,'human',digest,digest,'{}'];await admin.query(briefSql,values);
    for(const [index,bad] of [[0,'tenant\n'],[1,'_project'],[2,'x'.repeat(129)],[3,0],[3,'9007199254740992'],[4,'human\n'],[5,digest+'\n'],[7,'[]']] as const){const invalid=[...values];invalid[index]=bad;await expect(admin.query(briefSql,invalid)).rejects.toMatchObject({code:'23514'});}
    const run=[tenantId,'project','research','idea',1,digest,'{}','{}',digest,digest];
    for(const [index,bad] of [[0,tenantId+'other'],[1,'other'],[3,'missing'],[4,2]] as const){const invalid=[...run];invalid[index]=bad;await expect(admin.query(runSql,invalid)).rejects.toMatchObject({code:'23503'});}
    await admin.query(runSql,run);
    const candidateSql='INSERT INTO camery_script.candidates(tenant_id,project_id,run_id,stage,upstream_digest,digest,record) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)';
    await expect(admin.query(candidateSql,[tenantId,'other','research','foundation',null,digest,'{}'])).rejects.toMatchObject({code:'23503'});
    for(const [stage,upstream] of [['foundation',digest],['episodes',null],['unknown',null]])await expect(admin.query(candidateSql,[tenantId,'project','research',stage,upstream,digest,'{}'])).rejects.toMatchObject({code:'23514'});
    await admin.query(candidateSql,[tenantId,'project','research','foundation',null,digest,'{}']);
    const reviewSql='INSERT INTO camery_script.reviews(tenant_id,project_id,run_id,stage,status,request_digest,digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)';
    await expect(admin.query(reviewSql,[tenantId,'project','research','episodes','reviewed',digest,digest,'{}'])).rejects.toMatchObject({code:'23503'});
    await expect(admin.query(reviewSql,[tenantId,'project','research','foundation','adopted',digest,digest,'{}'])).rejects.toMatchObject({code:'23514'});
    await admin.query(reviewSql,[tenantId,'project','research','foundation','reviewed',digest,digest,'{}']);
    await admin.query(runSql,[tenantId,'project','child','idea',1,digest,'{}','{}',digest,digest]);
    const originSql='INSERT INTO camery_script.run_origins(tenant_id,project_id,run_id,source_run_id,source_run_digest,stage,actor_id,foundation_run_id,foundation_stage,foundation_review_status,foundation_review_digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)';
    const origin:unknown[]=[tenantId,'project','child','research',digest,'episodes','human','research','foundation','reviewed',digest,'{}'];
    for(const [index,bad] of [[0,tenantId+'other'],[1,'other'],[2,'missing'],[3,'missing'],[4,'b'.repeat(64)],[7,'missing'],[10,'b'.repeat(64)]] as const){const invalid=[...origin];invalid[index]=bad;await expect(admin.query(originSql,invalid)).rejects.toMatchObject({code:'23503'});}
    for(const [index,bad] of [[3,'child'],[5,'unknown'],[6,'human\n'],[7,'child'],[7,null],[8,null],[9,null],[10,null],[8,'episodes'],[9,'rejected'],[11,'[]']] as const){const invalid=[...origin];invalid[index]=bad;await expect(admin.query(originSql,invalid)).rejects.toMatchObject({code:'23514'});}
    await expect(admin.query(originSql,[...origin.slice(0,5),'foundation',...origin.slice(6)])).rejects.toMatchObject({code:'23514'});
    await admin.query(originSql,origin);
    const index=await admin.query("SELECT indexdef FROM pg_indexes WHERE schemaname='camery_script' AND indexname='development_runs_catalog_idx'");expect(index.rows[0]?.indexdef).toContain('run_id COLLATE "C" DESC');
    const briefIndex=await admin.query("SELECT indexdef FROM pg_indexes WHERE schemaname='camery_script' AND indexname='development_runs_brief_idx'");expect(briefIndex.rows[0]?.indexdef).toContain('(tenant_id, project_id, brief_id, brief_revision)');
    expect((await admin.query('SELECT version FROM camery_script.migrations ORDER BY version')).rows).toEqual([{version:1},{version:2},{version:3}]);
  }finally{
    let failed=false;for(const cleanup of [...['run_origins','reviews','candidates','runs','briefs'].map(table=>()=>admin.query(`DELETE FROM camery_script.${table} WHERE tenant_id=$1`,[tenantId])),()=>admin.end()]){try{await cleanup();}catch{failed=true;}}
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse to hide leaked scoped fixture records.
    if(failed)throw new Error('Development schema fixture cleanup failed');
  }
});
