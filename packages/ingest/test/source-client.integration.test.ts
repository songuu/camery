import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSourceDocument } from '../src/node/source.js';
import { PostgresDocumentStore } from '../src/node/store.js';
import { PostgresScriptStore } from '../src/node/scripts.js';
import { migrateIngest } from '../src/node/migrate.js';
import { docx } from './fixtures/docx.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];
if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL is required for same-client source tests');
describe('same-transaction source reads',()=>{
  const pool=new Pool({connectionString:databaseUrl});const tenantId='source-client-'+randomUUID();
  const scope={tenantId,projectId:'project',documentId:'novel'};const novels=new PostgresDocumentStore(pool);const scripts=new PostgresScriptStore(pool);
  const formats=['fountain','csv','tsv','docx'] as const;
  const documents=new Map<string,Awaited<ReturnType<typeof readSourceDocument>>>();
  async function locked<T>(input:{tenantId:string;projectId:string;documentId:string},action:(client:PoolClient)=>Promise<T>) {
    const client=await pool.connect();
    try{
      await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='1500ms'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_ingest',input.tenantId,input.projectId,input.documentId])]);
      const result=await action(client);await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  beforeAll(async()=>{
    await migrateIngest(pool);
    const novel=await novels.append({...scope,batchId:'first',expectedRevision:0,text:'\uFEFF第一章 开始\r\n小林😀'});
    documents.set('novel',{document:novel.document,revision:1});
    for(const format of formats){
      const bytes=format==='docx'?Buffer.from(docx('<w:p><w:r><w:t>小林😀来到车站。</w:t></w:r></w:p>')):
        Buffer.from(format==='fountain'?'.内景 车站\n\n@小林\n你好。\n':format==='csv'?'角色,对白\n小林,你好。\n':'角色\t对白\n小林\t你好。\n');
      const value=await scripts.import({...scope,documentId:format,title:'来源.'+format,format,bytes});documents.set(format,{document:value.document,revision:1});
    }
  });
  afterAll(async()=>{
    await pool.query('DELETE FROM camery_ingest.reading_checkpoints WHERE tenant_id=$1',[tenantId]);
    await pool.query('DELETE FROM camery_ingest.documents WHERE tenant_id=$1',[tenantId]);
    await pool.query('DELETE FROM camery_ingest.scripts WHERE tenant_id=$1',[tenantId]);await pool.end();
  });
  it('reads a novel and each real script format using the already locked transaction client',async()=>{
    for(const kind of ['novel',...formats]){
      const input={...scope,documentId:kind};
      const actual=await locked(input,client=>readSourceDocument(client,{...input,kind:kind==='novel'?'novel':'script'}));
      expect(actual).toEqual(documents.get(kind));expect(Object.keys(actual).sort()).toEqual(['document','revision']);
    }
    expect(documents.get('docx')!.document.originalDigest).not.toBe(documents.get('docx')!.document.sourceDigest);
  });
  it('requires only SELECT on source tables, without granting row-lock UPDATE or a new connection',async()=>{
    const role='source_reader_'+randomBytes(8).toString('hex');const password=randomBytes(24).toString('hex');let runtime:Pool|undefined;let created=false;
    try{
      await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT`);created=true;
      await pool.query(`GRANT USAGE ON SCHEMA camery_ingest TO ${role}`);
      await pool.query(`GRANT SELECT ON camery_ingest.documents,camery_ingest.scripts TO ${role}`);
      const url=new URL(databaseUrl!);url.username=role;url.password=password;runtime=new Pool({connectionString:url.toString(),max:1});
      const client=await runtime.connect();
      try{
        await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='1500ms'");
        for(const name of ['novel','docx']){
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_ingest',scope.tenantId,scope.projectId,name])]);
          expect(await readSourceDocument(client,{...scope,documentId:name,kind:name==='novel'?'novel':'script'})).toEqual(documents.get(name));
        }
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }finally{
      await runtime?.end();if(created){await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_ingest FROM ${role}`);await pool.query(`REVOKE ALL ON SCHEMA camery_ingest FROM ${role}`);await pool.query(`DROP ROLE ${role}`);}
    }
  });
  it('keeps tenant/project/document/kind isolation and detects corrupted persisted state on the same connection',async()=>{
    await locked(scope,async client=>{
      for(const field of ['tenantId','projectId','documentId'])
        await expect(readSourceDocument(client,{...scope,[field]:'absent',kind:'novel'})).rejects.toMatchObject({code:'NOT_FOUND'});
      await expect(readSourceDocument(client,{...scope,kind:'script'})).rejects.toMatchObject({code:'NOT_FOUND'});
      await client.query('SAVEPOINT novel_integrity');
      await client.query('UPDATE camery_ingest.documents SET revision=2 WHERE tenant_id=$1 AND project_id=$2 AND document_id=$3',Object.values(scope));
      await expect(readSourceDocument(client,{...scope,kind:'novel'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
      await client.query('ROLLBACK TO SAVEPOINT novel_integrity');
      expect(await readSourceDocument(client,{...scope,kind:'novel'})).toEqual(documents.get('novel'));
    });
    await locked({...scope,documentId:'fountain'},async client=>{
      await client.query('SAVEPOINT script_integrity');
      await client.query('UPDATE camery_ingest.scripts SET original=$4 WHERE tenant_id=$1 AND project_id=$2 AND document_id=$3',[tenantId,scope.projectId,'fountain',Buffer.from('corrupted')]);
      await expect(readSourceDocument(client,{...scope,documentId:'fountain',kind:'script'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
      await client.query('ROLLBACK TO SAVEPOINT script_integrity');
    });
  });
});
