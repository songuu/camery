import type {Pool} from 'pg';
import {ProjectIdentityError} from './contracts.js';
import {identityTransaction} from './identity-map.js';

const allowed=`('camery_script','briefs',false),('camery_script','runs',false),('camery_script','candidates',false),('camery_script','reviews',false),('camery_script','run_origins',false),('camery_script','ir_identities',true),('camery_projects','candidate_intents',true),('camery_projects','candidate_receipts',true),('camery_projects','decision_intents',true),('camery_projects','decision_receipts',true),('camery_versioning','projects',false),('camery_versioning','snapshots',true),('camery_versioning','changes',true),('camery_versioning','object_revisions',true),('camery_versioning','adoptions',true)`;
const outlineExtentColumns=[['runs',['tenant_id','project_id','run_id','brief_id','brief_revision','brief_digest','digest']],['briefs',['tenant_id','project_id','brief_id','revision','digest','record']],['reviews',['tenant_id','project_id','run_id','status','digest']]] as const;
const extentColumnValues=outlineExtentColumns.flatMap(([table,columns])=>columns.map(column=>`('camery_outline','${table}','${column}')`)).join(',');
const outlineInstalled="EXISTS(SELECT 1 FROM pg_catalog.pg_class installed_class JOIN pg_catalog.pg_namespace installed_schema ON installed_schema.oid=installed_class.relnamespace WHERE installed_schema.nspname='camery_outline' AND installed_class.relname='identity_preparations' AND installed_class.relkind IN ('r','p'))";
function sequence(input:unknown):string{if(typeof input!=='string')throw new ProjectIdentityError('STORAGE_FAILED','version identity sequence');const match=/^camery_versioning\.([a-z][a-z0-9_]{0,62})$(?![\s\S])/.exec(input);if(!match)throw new ProjectIdentityError('STORAGE_FAILED','version identity sequence');return '"camery_versioning"."'+match[1]+'"';}
/** Installer-only grants. Runtime startup verifies its independently provisioned LOGIN and never escalates itself. */
export async function grantProjectAdoptionRole(pool:Pool,role:string):Promise<void>{
  if(typeof role!=='string'||!/^[a-z][a-z0-9_]{0,62}$(?![\s\S])/.test(role))throw new ProjectIdentityError('INVALID_INPUT','project adoption role');
  await identityTransaction(pool,'grant project adoption',async client=>{
    const result=await client.query<{changes:string|null;history:string|null;outline_extents:boolean}>(`SELECT pg_get_serial_sequence('camery_versioning.changes','sequence') AS changes,pg_get_serial_sequence('camery_versioning.object_revisions','sequence') AS history,${outlineInstalled} AS outline_extents`);
    if(result.rows.length!==1)throw new ProjectIdentityError('STORAGE_FAILED','version identity sequences');const row=result.rows[0]!;const changes=sequence(row.changes);const history=sequence(row.history);if(changes===history)throw new ProjectIdentityError('STORAGE_FAILED','version identity sequences');
    if(typeof row.outline_extents!=='boolean')throw new ProjectIdentityError('STORAGE_FAILED','identity extent installation');
    await client.query(`GRANT USAGE ON SCHEMA camery_script,camery_projects,camery_versioning TO "${role}"`);
    // Only committed identity metadata is shared; Outline candidates and human review bodies remain outside this LOGIN.
    if(row.outline_extents){await client.query(`GRANT USAGE ON SCHEMA camery_outline TO "${role}"`);await client.query(`GRANT SELECT ON camery_outline.identity_preparations TO "${role}"`);for(const [table,columns] of outlineExtentColumns)await client.query(`GRANT SELECT(${columns.join(',')}) ON camery_outline.${table} TO "${role}"`);}
    await client.query(`GRANT SELECT ON camery_script.briefs,camery_script.runs,camery_script.candidates,camery_script.reviews,camery_script.run_origins TO "${role}"`);
    await client.query(`GRANT SELECT,INSERT ON camery_script.ir_identities,camery_projects.candidate_intents,camery_projects.candidate_receipts,camery_projects.decision_intents,camery_projects.decision_receipts,camery_versioning.snapshots,camery_versioning.changes,camery_versioning.object_revisions,camery_versioning.adoptions TO "${role}"`);
    await client.query(`GRANT SELECT ON camery_versioning.projects TO "${role}"`);await client.query(`GRANT UPDATE(head_revision,write_version) ON camery_versioning.projects TO "${role}"`);await client.query(`GRANT UPDATE(status,record) ON camery_versioning.changes TO "${role}"`);await client.query(`GRANT USAGE ON SEQUENCE ${changes},${history} TO "${role}"`);
  });
}
/** Validate effective privileges, including column-only grants and privileges inherited through PUBLIC. */
export async function verifyProjectAdoptionRole(pool:Pool):Promise<void>{
  try{const result=await pool.query<{allowed:boolean}>(`
    WITH base_allowed(schema_name,table_name,can_insert) AS (VALUES ${allowed}),
    allowed AS (SELECT * FROM base_allowed UNION ALL SELECT 'camery_outline','identity_preparations',false WHERE ${outlineInstalled}),
    extent_columns(schema_name,table_name,column_name) AS (SELECT * FROM (VALUES ${extentColumnValues}) AS expected(schema_name,table_name,column_name) WHERE ${outlineInstalled})
    SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolinherit AND NOT r.rolreplication
      AND session_user=current_user AND NOT has_database_privilege(current_database(),'CREATE,CONNECT WITH GRANT OPTION,TEMPORARY WITH GRANT OPTION')
      AND NOT EXISTS(SELECT 1 FROM pg_roles other_role WHERE other_role.oid<>r.oid AND pg_has_role(current_user,other_role.oid,'MEMBER'))
      AND has_schema_privilege('camery_script','USAGE') AND has_schema_privilege('camery_projects','USAGE') AND has_schema_privilege('camery_versioning','USAGE')
      AND CASE WHEN NOT (${outlineInstalled}) THEN true ELSE has_schema_privilege('camery_outline','USAGE') END
      AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND (n.nspowner=r.oid OR has_schema_privilege(n.oid,'CREATE') OR has_schema_privilege(n.oid,'USAGE WITH GRANT OPTION')))
      AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relowner=r.oid)
      AND NOT EXISTS(SELECT 1 FROM allowed a WHERE NOT has_table_privilege(format('%I.%I',a.schema_name,a.table_name),'SELECT') OR a.can_insert AND NOT has_table_privilege(format('%I.%I',a.schema_name,a.table_name),'INSERT'))
      AND NOT EXISTS(SELECT 1 FROM extent_columns e WHERE NOT has_column_privilege(format('%I.%I',e.schema_name,e.table_name),e.column_name,'SELECT'))
      AND has_column_privilege('camery_versioning.projects','head_revision','UPDATE') AND has_column_privilege('camery_versioning.projects','write_version','UPDATE')
      AND has_column_privilege('camery_versioning.changes','status','UPDATE') AND has_column_privilege('camery_versioning.changes','record','UPDATE')
      AND has_sequence_privilege(pg_get_serial_sequence('camery_versioning.changes','sequence'),'USAGE') AND has_sequence_privilege(pg_get_serial_sequence('camery_versioning.object_revisions','sequence'),'USAGE')
      AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN allowed a ON a.schema_name=n.nspname AND a.table_name=c.relname
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,CASE WHEN a.table_name IS NULL THEN 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' WHEN a.can_insert THEN 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' ELSE 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' END) ELSE false END)
      AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION,TRUNCATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION,TRIGGER WITH GRANT OPTION') ELSE false END)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute attr JOIN pg_class c ON c.oid=attr.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN allowed a ON a.schema_name=n.nspname AND a.table_name=c.relname LEFT JOIN extent_columns e ON e.schema_name=n.nspname AND e.table_name=c.relname AND e.column_name=attr.attname
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind IN ('r','p','v','m','f') AND attr.attnum>0 AND NOT attr.attisdropped THEN
          has_column_privilege(c.oid,attr.attnum,'REFERENCES') OR a.table_name IS NULL AND (has_column_privilege(c.oid,attr.attnum,'INSERT,UPDATE') OR e.column_name IS NULL AND has_column_privilege(c.oid,attr.attnum,'SELECT'))
          OR a.table_name IS NOT NULL AND NOT a.can_insert AND has_column_privilege(c.oid,attr.attnum,'INSERT')
          OR NOT (n.nspname='camery_versioning' AND c.relname='projects' AND attr.attname IN ('head_revision','write_version') OR n.nspname='camery_versioning' AND c.relname='changes' AND attr.attname IN ('status','record')) AND has_column_privilege(c.oid,attr.attnum,'UPDATE') ELSE false END)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute attr JOIN pg_class c ON c.oid=attr.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind IN ('r','p','v','m','f') AND attr.attnum>0 AND NOT attr.attisdropped THEN has_column_privilege(c.oid,attr.attnum,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION') ELSE false END)
      AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(c.oid,CASE WHEN c.oid IN (pg_get_serial_sequence('camery_versioning.changes','sequence')::regclass,pg_get_serial_sequence('camery_versioning.object_revisions','sequence')::regclass) THEN 'SELECT,UPDATE' ELSE 'USAGE,SELECT,UPDATE' END) OR has_sequence_privilege(c.oid,'USAGE WITH GRANT OPTION,SELECT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') ELSE false END) AS allowed
    FROM pg_roles r WHERE r.rolname=current_user`);if(result.rows[0]?.allowed!==true)throw new ProjectIdentityError('STORAGE_FAILED','restricted project adopter');}
  catch{throw new ProjectIdentityError('STORAGE_FAILED','restricted project adopter');}
}
