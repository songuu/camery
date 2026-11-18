import type {Pool,PoolClient} from 'pg';
import {ContinuityError} from '../contracts.js';
const writable=['candidates','reviews'];
const native=['projects','snapshots','changes','object_revisions','adoptions'];
/** Explicit installer, not role creation. The sole source UPDATE column enables PostgreSQL row locks without content/head writes. */
export async function grantContinuityRuntimeRole(pool:Pool,role:string):Promise<void>{
  if(typeof role!=='string'||!/^[a-z][a-z0-9_]{0,62}$(?![\s\S])/.test(role))throw new ContinuityError('INVALID_INPUT','runtime role','role');
  let client:PoolClient;try{client=await pool.connect();}catch{throw new ContinuityError('STORAGE_FAILED','role connection','role');}let destroy=false;
  try{
    await client.query('BEGIN');await client.query(`GRANT USAGE ON SCHEMA camery_continuity,camery_versioning TO "${role}"`);
    await client.query(`GRANT SELECT,INSERT ON ${writable.map(table=>'camery_continuity.'+table).join(',')} TO "${role}"`);
    await client.query(`GRANT SELECT ON ${native.map(table=>'camery_versioning.'+table).join(',')} TO "${role}"`);
    await client.query(`GRANT UPDATE(write_version) ON camery_versioning.projects TO "${role}"`);await client.query('COMMIT');
  }catch{try{await client.query('ROLLBACK');}catch{destroy=true;}throw new ContinuityError('STORAGE_FAILED','grant role','role');}
  // oxlint-disable-next-line eslint/no-unsafe-finally -- Installer cleanup errors must be explicit and must not disclose connection details.
  finally{try{client.release(destroy);}catch{throw new ContinuityError('STORAGE_FAILED','role release','role');}}
}
/** Append-only continuity records, native reads, and only the required projects.write_version row-lock capability. */
export async function verifyContinuityRuntimeRole(pool:Pool):Promise<void>{
  try{
    const permitted=[...writable.map(table=>['camery_continuity',table,true] as const),...native.map(table=>['camery_versioning',table,false] as const)],values=permitted.map(([schema,table,insert])=>`('${schema}','${table}',${insert})`).join(',');
    const result=await pool.query<{allowed:boolean}>(`
      WITH permitted(schema_name,table_name,can_insert) AS (VALUES ${values})
      SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolinherit AND NOT r.rolreplication
        AND session_user=current_user
        AND NOT EXISTS(SELECT 1 FROM pg_roles other_role WHERE other_role.oid<>r.oid AND pg_has_role(current_user,other_role.oid,'MEMBER'))
        AND NOT has_database_privilege(current_database(),'CREATE')
        AND has_schema_privilege('camery_continuity','USAGE') AND has_schema_privilege('camery_versioning','USAGE')
        AND has_column_privilege('camery_versioning.projects','write_version','UPDATE')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND (n.nspowner=r.oid OR has_schema_privilege(n.oid,'CREATE') OR has_schema_privilege(n.oid,'USAGE WITH GRANT OPTION')))
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relowner=r.oid)
        AND NOT EXISTS(SELECT 1 FROM permitted p LEFT JOIN pg_namespace n ON n.nspname=p.schema_name LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=p.table_name
          WHERE CASE WHEN c.oid IS NULL THEN true ELSE NOT has_table_privilege(c.oid,'SELECT') OR (p.can_insert AND NOT has_table_privilege(c.oid,'INSERT')) END)
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN permitted p ON p.schema_name=n.nspname AND p.table_name=c.relname
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,CASE
            WHEN p.can_insert THEN 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' WHEN p.can_insert=false THEN 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ELSE 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' END) ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION,TRUNCATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION,TRIGGER WITH GRANT OPTION') ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN permitted p ON p.schema_name=n.nspname AND p.table_name=c.relname
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped THEN has_column_privilege(c.oid,a.attnum,CASE
            WHEN p.can_insert THEN 'UPDATE,REFERENCES' WHEN p.can_insert=false AND p.schema_name='camery_versioning' AND p.table_name='projects' AND a.attname='write_version' THEN 'INSERT,REFERENCES'
            WHEN p.can_insert=false THEN 'INSERT,UPDATE,REFERENCES' ELSE 'SELECT,INSERT,UPDATE,REFERENCES' END) ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped THEN has_column_privilege(c.oid,a.attnum,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION') ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE') ELSE false END) AS allowed
      FROM pg_roles r WHERE r.rolname=current_user`);
    if(result.rows.length!==1||result.rows[0]?.allowed!==true)throw new Error();
  }catch{throw new ContinuityError('STORAGE_FAILED','restricted runtime role','role');}
}
