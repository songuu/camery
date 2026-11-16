import type { Pool } from 'pg';
import { DevelopmentError } from '../contracts.js';

/** Explicit installer helper; startup only verifies the independently provisioned LOGIN. */
export async function grantDevelopmentRuntimeRole(pool:Pool,role:string):Promise<void>{
  if(typeof role!=='string'||!/^[a-z][a-z0-9_]{0,62}$(?![\s\S])/.test(role))throw new DevelopmentError('INVALID_INPUT','development role');
  let client;let destroy=false;
  try{
    client=await pool.connect();await client.query('BEGIN');
    await client.query(`GRANT USAGE ON SCHEMA camery_script TO "${role}"`);
    await client.query(`GRANT SELECT,INSERT ON camery_script.briefs,camery_script.runs,camery_script.candidates,camery_script.reviews TO "${role}"`);await client.query('COMMIT');
  }catch{
    try{await client?.query('ROLLBACK');}catch{destroy=true;}
    throw new DevelopmentError('STORAGE_FAILED','grant development role');
  // oxlint-disable-next-line eslint/no-unsafe-finally -- Always redact release failures after the installer transaction.
  }finally{try{client?.release(destroy);}catch{throw new DevelopmentError('STORAGE_FAILED','grant development role');}}
}

/** Dedicated append-only development identity. User authentication, budgets, tasks and installation need other pools. */
export async function verifyDevelopmentRuntimeRole(pool:Pool):Promise<void>{
  try{
    // CASE guards matter: the planner may evaluate relation-specific ACL calls before WHERE filters.
    const result=await pool.query<{allowed:boolean}>(`
      SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolinherit AND NOT r.rolreplication
        AND session_user=current_user
        AND NOT EXISTS(SELECT 1 FROM pg_roles other_role WHERE other_role.oid<>r.oid AND pg_has_role(current_user,other_role.oid,'MEMBER'))
        AND NOT has_database_privilege(current_database(),'CREATE')
        AND has_schema_privilege('camery_script','USAGE')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND (n.nspowner=r.oid OR has_schema_privilege(n.oid,'CREATE') OR has_schema_privilege(n.oid,'USAGE WITH GRANT OPTION')))
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relowner=r.oid)
        AND has_table_privilege('camery_script.briefs','SELECT') AND has_table_privilege('camery_script.briefs','INSERT')
        AND has_table_privilege('camery_script.runs','SELECT') AND has_table_privilege('camery_script.runs','INSERT')
        AND has_table_privilege('camery_script.candidates','SELECT') AND has_table_privilege('camery_script.candidates','INSERT')
        AND has_table_privilege('camery_script.reviews','SELECT') AND has_table_privilege('camery_script.reviews','INSERT')
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,CASE
            WHEN n.nspname='camery_script' AND c.relname IN ('briefs','runs','candidates','reviews') THEN 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ELSE 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' END) ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION,TRUNCATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION,TRIGGER WITH GRANT OPTION') ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped THEN has_column_privilege(c.oid,a.attnum,CASE
            WHEN n.nspname='camery_script' AND c.relname IN ('briefs','runs','candidates','reviews') THEN 'UPDATE,REFERENCES'
            ELSE 'SELECT,INSERT,UPDATE,REFERENCES' END) ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped THEN has_column_privilege(c.oid,a.attnum,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION') ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE') ELSE false END) AS allowed
      FROM pg_roles r WHERE r.rolname=current_user`);
    if(result.rows[0]?.allowed!==true)throw new DevelopmentError('STORAGE_FAILED','restricted development role');
  }catch{throw new DevelopmentError('STORAGE_FAILED','restricted development role');}
}
