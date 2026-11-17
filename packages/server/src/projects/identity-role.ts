import type {Pool} from 'pg';
import {ProjectIdentityError} from './contracts.js';
import {identityTransaction} from './identity-map.js';

/** Explicit provisioning only; the independently supplied runtime LOGIN receives no registration capability. */
export async function grantProjectIdentityReaderRole(pool:Pool,role:string):Promise<void>{
  if(typeof role!=='string'||!/^[a-z][a-z0-9_]{0,62}$(?![\s\S])/.test(role))throw new ProjectIdentityError('INVALID_INPUT','identity reader role');
  await identityTransaction(pool,'grant identity reader',async client=>{
    await client.query(`GRANT USAGE ON SCHEMA camery_projects TO "${role}"`);
    await client.query(`GRANT SELECT ON camery_projects.tenants,camery_projects.projects,camery_projects.principals TO "${role}"`);
  });
}
/** Inspect the effective capability closure, including column grants and inherited/PUBLIC capabilities. */
export async function verifyProjectIdentityReaderRole(pool:Pool):Promise<void>{
  try{
    const result=await pool.query<{allowed:boolean}>(`
      SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolinherit AND NOT r.rolreplication
        AND session_user=current_user
        AND NOT EXISTS(SELECT 1 FROM pg_roles other_role WHERE other_role.oid<>r.oid AND pg_has_role(current_user,other_role.oid,'MEMBER'))
        AND NOT has_database_privilege(current_database(),'CREATE')
        AND has_schema_privilege('camery_projects','USAGE')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND (n.nspowner=r.oid OR has_schema_privilege(n.oid,'CREATE') OR has_schema_privilege(n.oid,'USAGE WITH GRANT OPTION')))
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relowner=r.oid)
        AND has_table_privilege('camery_projects.tenants','SELECT') AND has_table_privilege('camery_projects.projects','SELECT') AND has_table_privilege('camery_projects.principals','SELECT')
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,CASE
            WHEN n.nspname='camery_projects' AND c.relname IN ('tenants','projects','principals') THEN 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ELSE 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' END) ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION,TRUNCATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION,TRIGGER WITH GRANT OPTION') ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped THEN has_column_privilege(c.oid,a.attnum,CASE
            WHEN n.nspname='camery_projects' AND c.relname IN ('tenants','projects','principals') THEN 'INSERT,UPDATE,REFERENCES'
            ELSE 'SELECT,INSERT,UPDATE,REFERENCES' END) ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped THEN has_column_privilege(c.oid,a.attnum,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION') ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE') ELSE false END) AS allowed
      FROM pg_roles r WHERE r.rolname=current_user`);
    if(result.rows[0]?.allowed!==true)throw new ProjectIdentityError('STORAGE_FAILED','restricted identity reader');
  }catch{throw new ProjectIdentityError('STORAGE_FAILED','restricted identity reader');}
}
