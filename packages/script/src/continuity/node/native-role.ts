import type {Pool,PoolClient} from 'pg';
import {ContinuityError} from '../contracts.js';

type Profile='review'|'native_review'|'adopter';
const native=['projects','snapshots','changes','object_revisions','adoptions'];
function profileTables(profile:Profile):readonly (readonly [string,string,boolean])[]{
  const adopter=profile==='adopter',proofs=profile==='review'?[]:[['camery_continuity','native_bindings',adopter],['camery_continuity','native_adoptions',adopter]] as const;
  const base=[['camery_continuity','candidates',!adopter],['camery_continuity','reviews',!adopter]] as const;
  const versions=native.map(table=>['camery_versioning',table,adopter&&table!=='projects'] as const);
  return adopter?[...base,...proofs,...versions]:[...base,...versions,...proofs];
}
const updates=(profile:Profile)=>profile==='adopter'?[['projects','head_revision'],['projects','write_version'],['changes','status'],['changes','record']]:[['projects','write_version']];
function sequence(input:unknown):string{
  if(typeof input!=='string'||!/^camery_versioning\.[a-z][a-z0-9_]{0,62}$(?![\s\S])/.test(input))throw new ContinuityError('STORAGE_FAILED','native identity sequence','role');
  return '"camery_versioning"."'+input.slice('camery_versioning.'.length)+'"';
}
/** Explicit installer-only profile. It never creates a LOGIN or changes the legacy profile implicitly. */
export async function grantContinuityProfile(pool:Pool,role:string,profile:Profile):Promise<void>{
  if(typeof role!=='string'||!/^[a-z][a-z0-9_]{0,62}$(?![\s\S])/.test(role))throw new ContinuityError('INVALID_INPUT','runtime role','role');
  let client:PoolClient;try{client=await pool.connect();}catch{throw new ContinuityError('STORAGE_FAILED','role connection','role');}
  let destroy=false,broken=false,listening=false;const onError=()=>{broken=true;};
  try{
    client.on('error',onError);listening=true;await client.query('BEGIN');await client.query('SET LOCAL search_path = pg_catalog');
    const tables=profileTables(profile),writable=tables.filter(([, ,insert])=>insert).map(([schema,table])=>schema+'.'+table),readable=tables.filter(([, ,insert])=>!insert).map(([schema,table])=>schema+'.'+table);
    await client.query(`GRANT USAGE ON SCHEMA camery_continuity,camery_versioning TO "${role}"`);
    await client.query(`GRANT SELECT,INSERT ON ${writable.join(',')} TO "${role}"`);await client.query(`GRANT SELECT ON ${readable.join(',')} TO "${role}"`);
    for(const table of ['projects','changes']){const columns=updates(profile).filter(([name])=>name===table).map(([,column])=>column);if(columns.length)await client.query(`GRANT UPDATE(${columns.join(',')}) ON camery_versioning.${table} TO "${role}"`);}
    if(profile==='adopter'){
      const result=await client.query<{changes:unknown;history:unknown}>("SELECT pg_catalog.pg_get_serial_sequence('camery_versioning.changes','sequence') AS changes,pg_catalog.pg_get_serial_sequence('camery_versioning.object_revisions','sequence') AS history");
      if(result.rows.length!==1)throw new Error();const first=sequence(result.rows[0]!.changes),second=sequence(result.rows[0]!.history);if(first===second)throw new Error();await client.query(`GRANT USAGE ON SEQUENCE ${first},${second} TO "${role}"`);
    }
    if(broken)throw new Error();await client.query('COMMIT');if(broken)throw new Error();
  }catch{if(!listening)destroy=true;try{await client.query('ROLLBACK');}catch{destroy=true;}throw new ContinuityError('STORAGE_FAILED','grant role','role');}
  finally{
    let failed=false;try{client.removeListener('error',onError);}catch{destroy=true;failed=true;}try{client.release(destroy||broken);}catch{failed=true;}
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Always attempt release, then report cleanup without exposing driver data.
    if(failed)throw new ContinuityError('STORAGE_FAILED','role release','role');
  }
}
/** Effective privileges include PUBLIC, column grants, grant options, membership and unexpected identity sequences. */
export async function verifyContinuityProfile(pool:Pool,profile:Profile):Promise<void>{
  try{
    const permitted=profileTables(profile).map(([schema,table,insert])=>`('${schema}','${table}',${insert})`).join(','),columns=updates(profile).map(([table,column])=>`('camery_versioning','${table}','${column}')`).join(','),adopter=profile==='adopter';
    const result=await pool.query<{allowed:boolean}>(`
      WITH permitted(schema_name,table_name,can_insert) AS (VALUES ${permitted}),
      writable_columns(schema_name,table_name,column_name) AS (VALUES ${columns}),
      expected_sequences(sequence_id) AS (
        SELECT pg_catalog.pg_get_serial_sequence('camery_versioning.changes','sequence')::pg_catalog.regclass WHERE ${adopter}
        UNION ALL SELECT pg_catalog.pg_get_serial_sequence('camery_versioning.object_revisions','sequence')::pg_catalog.regclass WHERE ${adopter})
      SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolinherit AND NOT r.rolreplication
        AND (pg_catalog.current_schemas(true))[1] OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.name
        AND session_user OPERATOR(pg_catalog.=) current_user AND NOT pg_catalog.has_database_privilege(pg_catalog.current_database(),'CREATE,CONNECT WITH GRANT OPTION,TEMPORARY WITH GRANT OPTION')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles other_role WHERE other_role.oid OPERATOR(pg_catalog.<>) r.oid AND pg_catalog.pg_has_role(current_user,other_role.oid,'MEMBER'))
        AND pg_catalog.has_schema_privilege('camery_continuity','USAGE') AND pg_catalog.has_schema_privilege('camery_versioning','USAGE')
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
        AND (${profile==='review'} OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) p.pronamespace WHERE n.nspname  OPERATOR(pg_catalog.!~)  '^pg_' AND n.nspname OPERATOR(pg_catalog.<>) 'information_schema' AND p.prosecdef AND pg_catalog.has_function_privilege(p.oid,'EXECUTE')))
        AS allowed FROM pg_catalog.pg_roles r WHERE r.rolname OPERATOR(pg_catalog.=) current_user`);
    if(result.rows.length!==1||result.rows[0]?.allowed!==true)throw new Error();
  }catch{throw new ContinuityError('STORAGE_FAILED','restricted runtime role','role');}
}
export async function grantContinuityAdoptionRole(pool:Pool,role:string):Promise<void>{await grantContinuityProfile(pool,role,'adopter');}
export async function verifyContinuityAdoptionRole(pool:Pool):Promise<void>{await verifyContinuityProfile(pool,'adopter');}
