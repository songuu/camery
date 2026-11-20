import type {Pool} from 'pg';
import {ProjectIdentityError} from './contracts.js';
import {identityTransaction} from './identity-map.js';

const permitted=[
  ['camery_script','briefs',false],['camery_script','runs',false],['camery_script','candidates',false],['camery_script','reviews',false],['camery_script','run_origins',false],
  ['camery_bible','runs',false],['camery_bible','chunks',false],['camery_bible','candidates',false],['camery_bible','reviews',false],['camery_ingest','documents',false],['camery_ingest','scripts',false],
  ['camery_outline','briefs',false],['camery_outline','runs',false],['camery_outline','candidates',false],['camery_outline','reviews',false],
  ['camery_continuity','candidates',false],['camery_continuity','reviews',false],['camery_continuity','native_bindings',false],['camery_continuity','native_adoptions',false],
  ['camery_screenplay','candidates',false],['camery_screenplay','reviews',false],['camery_screenplay','generation_runs',false],['camery_screenplay','generation_candidates',false],['camery_screenplay','generation_deliveries',false],
  ['camery_screenplay','native_bindings',true],['camery_screenplay','native_adoptions',true],
  ['camery_projects','tenants',false],['camery_projects','projects',false],['camery_projects','principals',false],
  ['camery_projects','screenplay_candidate_intents',true],['camery_projects','screenplay_candidate_receipts',true],['camery_projects','screenplay_decision_intents',true],['camery_projects','screenplay_decision_receipts',true],
  ['camery_versioning','projects',false],['camery_versioning','snapshots',true],['camery_versioning','changes',true],['camery_versioning','object_revisions',true],['camery_versioning','adoptions',true],
] as const;
type Profile='reader'|'adopter';
const readerTables=permitted.filter(([schema,table])=>schema==='camery_projects'&&['tenants','projects','principals'].includes(table));
const writableColumns=[['camery_versioning','projects','head_revision'],['camery_versioning','projects','write_version'],['camery_versioning','changes','status'],['camery_versioning','changes','record']] as const;
function sequence(input:unknown):string{if(typeof input!=='string')throw new ProjectIdentityError('STORAGE_FAILED','version identity sequence');const match=/^camery_versioning\.([a-z][a-z0-9_]{0,62})$(?![\s\S])/.exec(input);if(!match)throw new ProjectIdentityError('STORAGE_FAILED','version identity sequence');return '"camery_versioning"."'+match[1]+'"';}
/** Installer-only grants. Runtime startup verifies its independently provisioned LOGIN and never escalates itself. */
export async function grantScreenplayProjectAdoptionRole(pool:Pool,role:string):Promise<void>{
  if(typeof role!=='string'||!/^[a-z][a-z0-9_]{0,62}$(?![\s\S])/.test(role))throw new ProjectIdentityError('INVALID_INPUT','screenplay project adoption role');
  try{await identityTransaction(pool,'grant screenplay project adoption',async client=>{
    await client.query('SET LOCAL search_path = pg_catalog');
    const result=await client.query<{changes:string|null;history:string|null}>("SELECT pg_catalog.pg_get_serial_sequence('camery_versioning.changes','sequence') AS changes,pg_catalog.pg_get_serial_sequence('camery_versioning.object_revisions','sequence') AS history");
    if(result.rows.length!==1)throw new ProjectIdentityError('STORAGE_FAILED','screenplay version identity sequences');const row=result.rows[0]!,changes=sequence(row.changes),history=sequence(row.history);if(changes===history)throw new ProjectIdentityError('STORAGE_FAILED','screenplay version identity sequences');
    await client.query(`GRANT USAGE ON SCHEMA camery_script,camery_outline,camery_bible,camery_ingest,camery_projects,camery_versioning,camery_screenplay,camery_continuity TO "${role}"`);
    for(const [schema,table,insert] of permitted)await client.query(`GRANT ${insert?'SELECT,INSERT':'SELECT'} ON ${schema}.${table} TO "${role}"`);
    await client.query(`GRANT SELECT ON camery_versioning.projects TO "${role}"`);await client.query(`GRANT UPDATE(head_revision,write_version) ON camery_versioning.projects TO "${role}"`);await client.query(`GRANT UPDATE(status,record) ON camery_versioning.changes TO "${role}"`);await client.query(`GRANT USAGE ON SEQUENCE ${changes},${history} TO "${role}"`);
  });}catch(error){let known=false;try{known=error instanceof ProjectIdentityError;}catch{/* Opaque driver prototypes cannot expose connection diagnostics. */}if(known)throw error;throw new ProjectIdentityError('STORAGE_FAILED','grant screenplay project adoption');}
}
/** Every authority lookup pins catalogue objects and operators, including the read-only identity profile. */
async function verifyProfile(pool:Pool,profile:Profile):Promise<void>{
  try{
    const adopter=profile==='adopter',tables=adopter?permitted:readerTables;
    const permittedSql=tables.map(([schema,table,insert])=>`('${schema}','${table}',${insert})`).join(','),columns=writableColumns.map(([schema,table,column])=>`('${schema}','${table}','${column}')`).join(',');
    const result=await pool.query<{allowed:boolean}>(`
      WITH permitted(schema_name,table_name,can_insert) AS (VALUES ${permittedSql}),
      writable_columns(schema_name,table_name,column_name) AS (SELECT * FROM (VALUES ${columns}) AS writable(schema_name,table_name,column_name) WHERE ${adopter}),
      expected_sequences(sequence_id) AS (
        SELECT pg_catalog.pg_get_serial_sequence('camery_versioning.changes','sequence')::pg_catalog.regclass WHERE ${adopter}
        UNION ALL SELECT pg_catalog.pg_get_serial_sequence('camery_versioning.object_revisions','sequence')::pg_catalog.regclass WHERE ${adopter})
      SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolinherit AND NOT r.rolreplication
        AND (pg_catalog.current_schemas(true))[1] OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.name
        AND session_user OPERATOR(pg_catalog.=) current_user AND NOT pg_catalog.has_database_privilege(pg_catalog.current_database(),'CREATE,CONNECT WITH GRANT OPTION,TEMPORARY WITH GRANT OPTION')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles other_role WHERE other_role.oid OPERATOR(pg_catalog.<>) r.oid AND pg_catalog.pg_has_role(current_user,other_role.oid,'MEMBER'))
        AND NOT EXISTS(SELECT 1 FROM permitted p WHERE NOT pg_catalog.has_schema_privilege(p.schema_name,'USAGE'))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname  OPERATOR(pg_catalog.!~)  '^pg_' AND n.nspname OPERATOR(pg_catalog.<>) 'information_schema' AND (n.nspowner OPERATOR(pg_catalog.=) r.oid OR pg_catalog.has_schema_privilege(n.oid,'CREATE') OR pg_catalog.has_schema_privilege(n.oid,'USAGE WITH GRANT OPTION')))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE n.nspname  OPERATOR(pg_catalog.!~)  '^pg_' AND n.nspname OPERATOR(pg_catalog.<>) 'information_schema' AND c.relowner OPERATOR(pg_catalog.=) r.oid)
        AND NOT EXISTS(SELECT 1 FROM permitted p LEFT JOIN pg_catalog.pg_namespace n ON n.nspname OPERATOR(pg_catalog.=) p.schema_name LEFT JOIN pg_catalog.pg_class c ON c.relnamespace OPERATOR(pg_catalog.=) n.oid AND c.relname OPERATOR(pg_catalog.=) p.table_name WHERE CASE WHEN c.oid IS NULL THEN true ELSE NOT pg_catalog.has_table_privilege(c.oid,'SELECT') OR p.can_insert AND NOT pg_catalog.has_table_privilege(c.oid,'INSERT') END)
        AND NOT EXISTS(SELECT 1 FROM writable_columns w WHERE NOT pg_catalog.has_column_privilege(pg_catalog.format('%I.%I',w.schema_name,w.table_name),w.column_name,'UPDATE'))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace LEFT JOIN permitted p ON p.schema_name OPERATOR(pg_catalog.=) n.nspname AND p.table_name OPERATOR(pg_catalog.=) c.relname WHERE n.nspname  OPERATOR(pg_catalog.!~)  '^pg_' AND n.nspname OPERATOR(pg_catalog.<>) 'information_schema' AND CASE WHEN c.relkind OPERATOR(pg_catalog.=) ANY(ARRAY['r','p','v','m','f']::pg_catalog."char"[]) THEN pg_catalog.has_table_privilege(c.oid,CASE WHEN p.can_insert THEN 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' WHEN p.can_insert OPERATOR(pg_catalog.=) false THEN 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' ELSE 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' END) ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE n.nspname  OPERATOR(pg_catalog.!~)  '^pg_' AND n.nspname OPERATOR(pg_catalog.<>) 'information_schema' AND CASE WHEN c.relkind OPERATOR(pg_catalog.=) ANY(ARRAY['r','p','v','m','f']::pg_catalog."char"[]) THEN pg_catalog.has_table_privilege(c.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION,TRUNCATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION,TRIGGER WITH GRANT OPTION') ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace LEFT JOIN permitted p ON p.schema_name OPERATOR(pg_catalog.=) n.nspname AND p.table_name OPERATOR(pg_catalog.=) c.relname LEFT JOIN writable_columns w ON w.schema_name OPERATOR(pg_catalog.=) n.nspname AND w.table_name OPERATOR(pg_catalog.=) c.relname AND w.column_name OPERATOR(pg_catalog.=) a.attname WHERE n.nspname  OPERATOR(pg_catalog.!~)  '^pg_' AND n.nspname OPERATOR(pg_catalog.<>) 'information_schema' AND CASE WHEN c.relkind OPERATOR(pg_catalog.=) ANY(ARRAY['r','p','v','m','f']::pg_catalog."char"[]) AND a.attnum OPERATOR(pg_catalog.>) 0 AND NOT a.attisdropped THEN pg_catalog.has_column_privilege(c.oid,a.attnum,'REFERENCES') OR p.table_name IS NULL AND pg_catalog.has_column_privilege(c.oid,a.attnum,'SELECT,INSERT,UPDATE') OR p.can_insert OPERATOR(pg_catalog.=) false AND pg_catalog.has_column_privilege(c.oid,a.attnum,'INSERT') OR w.column_name IS NULL AND pg_catalog.has_column_privilege(c.oid,a.attnum,'UPDATE') ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE n.nspname  OPERATOR(pg_catalog.!~)  '^pg_' AND n.nspname OPERATOR(pg_catalog.<>) 'information_schema' AND CASE WHEN c.relkind OPERATOR(pg_catalog.=) ANY(ARRAY['r','p','v','m','f']::pg_catalog."char"[]) AND a.attnum OPERATOR(pg_catalog.>) 0 AND NOT a.attisdropped THEN pg_catalog.has_column_privilege(c.oid,a.attnum,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION') ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM expected_sequences s WHERE s.sequence_id IS NULL OR NOT pg_catalog.has_sequence_privilege(s.sequence_id,'USAGE'))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace LEFT JOIN expected_sequences s ON s.sequence_id OPERATOR(pg_catalog.=) c.oid WHERE n.nspname  OPERATOR(pg_catalog.!~)  '^pg_' AND n.nspname OPERATOR(pg_catalog.<>) 'information_schema' AND CASE WHEN c.relkind OPERATOR(pg_catalog.=) 'S' THEN pg_catalog.has_sequence_privilege(c.oid,CASE WHEN s.sequence_id IS NULL THEN 'USAGE,SELECT,UPDATE' ELSE 'SELECT,UPDATE,USAGE WITH GRANT OPTION' END) ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) p.pronamespace WHERE n.nspname  OPERATOR(pg_catalog.!~)  '^pg_' AND n.nspname OPERATOR(pg_catalog.<>) 'information_schema' AND p.prosecdef AND pg_catalog.has_function_privilege(p.oid,'EXECUTE'))
        AS allowed FROM pg_catalog.pg_roles r WHERE r.rolname OPERATOR(pg_catalog.=) current_user`);
    if(result.rows.length!==1||result.rows[0]?.allowed!==true)throw new Error();
  }catch{throw new ProjectIdentityError('STORAGE_FAILED','restricted screenplay project '+profile);}
}
export async function verifyScreenplayProjectAdoptionRole(pool:Pool):Promise<void>{await verifyProfile(pool,'adopter');}
export async function verifyScreenplayProjectIdentityReaderRole(pool:Pool):Promise<void>{await verifyProfile(pool,'reader');}
