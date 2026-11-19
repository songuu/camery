import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {PoolClient} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {migrateBible} from '@camery/bible/node';
import {migrateIngest} from '../../ingest/src/node/index.js';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {migrateDevelopment,PostgresDevelopmentIrIdentities} from '../src/node/index.js';
import {migrateOutline} from '../src/outline/node/migrate.js';
import {migrateOutlineIdentities} from '../src/outline/node/identity-migrate.js';
import {createDevelopmentSourceFixture} from './outline-source-pg-support.js';
import {readIdentityEpisodeExtents} from '../src/node/identity-extents.js';
import {testDatabaseConnections} from './postgres-disconnect-support.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for isolated Outline identity migration');
const database='camery_outline_ids_'+randomBytes(8).toString('hex');
function identifier():string{if(!/^camery_outline_ids_[a-f0-9]{16}$/.test(database))throw new Error('Unowned migration test database');return '"'+database+'"';}
const admin=new Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:5000});
const {createPool:migrationPool,waitForDisconnects}=testDatabaseConnections();
const address=new URL(databaseUrl);address.pathname='/'+database;const pool=migrationPool({connectionString:address.toString(),max:5,connectionTimeoutMillis:5000});let created=false;
beforeAll(async()=>{await admin.query('CREATE DATABASE '+identifier());created=true;await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);await migrateOutline(pool);});
afterAll(async()=>{try{
  await pool.end();
  await waitForDisconnects();
  if(created)await admin.query('DROP DATABASE '+identifier());
}finally{await admin.end();}});

const columns='tenant_id,project_id,kind,owner_key,owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id';
const records=async()=>(await pool.query(`SELECT ${columns} FROM camery_script.ir_identities ORDER BY kind,local_key`)).rows;
const constraints=async()=>(await pool.query("SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='camery_script.ir_identities'::regclass ORDER BY conname")).rows;
function interrupted(phase:'ddl'|'commit'):Pool{
  let fired=false;
  return new Proxy(pool,{get(target,property){if(property==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(connection,key){if(key==='query')return async(sql:string,values?:unknown[])=>{const result=await connection.query(sql,values);if(!fired&&(phase==='ddl'?sql.includes('ALTER TABLE camery_script.ir_identities ADD COLUMN'):sql==='COMMIT')){fired=true;throw new Error('Synthetic identity migration interruption');}return result;};const value:unknown=Reflect.get(connection,key);return typeof value==='function'?value.bind(connection):value;}}) as PoolClient;};const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
}
it('rolls back actual extension DDL, preserves old identities, then recovers a committed migration after acknowledgement loss',async()=>{
  const source=await createDevelopmentSourceFixture(pool,{tenantId:'migration-old-source',projectId:'project'}),{kind:_kind,...descriptor}=source.descriptor;
  const target={tenantId:id('migration-tenant'),projectId:id('migration-project')};
  const first=await new PostgresDevelopmentIrIdentities(pool,source.store,()=>id(randomUUID())).prepare({source:descriptor,target}),oldRows=await records(),oldConstraints=await constraints();
  const role='outline_legacy_extent_'+randomBytes(8).toString('hex'),password=randomBytes(24).toString('hex');
  await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION`);
  const limitedUrl=new URL(address);limitedUrl.username=role;limitedUrl.password=password;const limited=migrationPool({connectionString:limitedUrl.toString(),max:1,connectionTimeoutMillis:5000});
  try{await pool.query(`GRANT USAGE ON SCHEMA camery_script TO ${role}`);await pool.query(`GRANT SELECT ON camery_script.ir_identities,camery_script.runs,camery_script.briefs TO ${role}`);
    expect((await limited.query("SELECT has_schema_privilege('camery_outline','USAGE') AS allowed")).rows).toEqual([{allowed:false}]);
    const reader=await limited.connect();try{expect(await readIdentityEpisodeExtents(reader,source.target,target)).toEqual({development:3,outline:0});}finally{reader.release();}
  }finally{await limited.end();await pool.query(`DROP OWNED BY ${role}`);await pool.query(`DROP ROLE ${role}`);}
  const ledgers={development:(await pool.query('SELECT version,checksum FROM camery_script.migrations ORDER BY version')).rows,outline:(await pool.query('SELECT version,checksum FROM camery_outline.migrations ORDER BY version')).rows};
  await expect(migrateOutlineIdentities(interrupted('ddl'))).rejects.toMatchObject({code:'STORAGE_FAILED'});
  expect((await pool.query("SELECT to_regclass('camery_outline.identity_migrations') ledger,to_regclass('camery_outline.identity_preparations') preparations")).rows).toEqual([{ledger:null,preparations:null}]);
  expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='camery_script' AND table_name='ir_identities' AND column_name='outline_owner_run_id'")).rows).toEqual([]);expect(await constraints()).toEqual(oldConstraints);expect(await records()).toEqual(oldRows);
  await expect(migrateOutlineIdentities(interrupted('commit'))).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const reopened=migrationPool({connectionString:address.toString(),max:4,connectionTimeoutMillis:5000});
  try{await Promise.all(Array.from({length:4},()=>migrateOutlineIdentities(reopened)));}finally{await reopened.end();}
  expect((await pool.query('SELECT version FROM camery_outline.identity_migrations')).rows).toEqual([{version:1}]);expect(await records()).toEqual(oldRows);
  expect((await pool.query("SELECT outline_owner_run_id FROM camery_script.ir_identities")).rows.every(row=>row.outline_owner_run_id===null)).toBe(true);
  await migrateDevelopment(pool);await migrateOutline(pool);
  expect((await pool.query('SELECT version,checksum FROM camery_script.migrations ORDER BY version')).rows).toEqual(ledgers.development);expect((await pool.query('SELECT version,checksum FROM camery_outline.migrations ORDER BY version')).rows).toEqual(ledgers.outline);
  expect((await new PostgresDevelopmentIrIdentities(pool,source.store,()=>{throw new Error('An old identity was reallocated');}).prepare({source:descriptor,target})).identities).toEqual(first.identities);
  const checksum=ledgers.development[3]!.checksum as string;
  try{await pool.query("UPDATE camery_script.migrations SET checksum=$1 WHERE version=4",['0'.repeat(64)]);await expect(migrateOutlineIdentities(pool)).rejects.toMatchObject({code:'CONFLICT'});}finally{await pool.query('UPDATE camery_script.migrations SET checksum=$1 WHERE version=4',[checksum]);}
  expect(await records()).toEqual(oldRows);expect((await pool.query('SELECT count(*)::integer total FROM camery_outline.identity_preparations')).rows).toEqual([{total:0}]);
  const customPath=migrationPool({connectionString:address.toString(),max:1,options:'-c search_path=camery_script,camery_outline,public'});
  try{await migrateOutlineIdentities(customPath);}finally{await customPath.end();}
});
