import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { issueSession } from '@camery/access';
import { migrateAccess,PostgresSessionStore,verifyRuntimeRole } from '@camery/access/node';
import { migrateIngest,PostgresDocumentStore,PostgresScriptStore,verifyIngestRuntimeRole } from '@camery/ingest/node';
import { docx } from '../../ingest/test/fixtures/docx.js';
import { createApplication } from '../src/app.js';
const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];
if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL is required for source HTTP integration');
describe('real source HTTP and least privilege storage',()=>{
  it('imports all supported formats, resumes per reader, survives restart and enforces current roles',async()=>{
    const admin=new Pool({connectionString:databaseUrl});const tenantId=`source-api-${randomUUID()}`;
    const role=`source_api_${randomBytes(8).toString('hex')}`;const password=randomBytes(24).toString('hex');
    let runtime:Pool|undefined;let app:Awaited<ReturnType<typeof createApplication>>|undefined;let created=false;
    try{
      await migrateAccess(admin);await migrateIngest(admin);const installer=new PostgresSessionStore(admin);
      for(const [userId,access] of [['editor','editor'],['reader','viewer']] as const)await installer.provisionMember({tenantId,projectId:'project',userId,role:access});
      const editor=await issueSession({tenantId,userId:'editor',ttlSeconds:3600},installer);
      const viewer=await issueSession({tenantId,userId:'reader',ttlSeconds:3600},installer);
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);created=true;
      await admin.query(`GRANT USAGE ON SCHEMA camery_access,camery_ingest TO ${role}`);
      await admin.query(`GRANT SELECT ON camery_access.users,camery_access.memberships,camery_access.sessions TO ${role}`);
      await admin.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO ${role}`);
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON camery_ingest.documents,camery_ingest.reading_checkpoints TO ${role}`);
      await admin.query(`GRANT SELECT,INSERT ON camery_ingest.scripts TO ${role}`);
      const url=new URL(databaseUrl!);url.username=role;url.password=password;runtime=new Pool({connectionString:url.toString()});
      await verifyRuntimeRole(runtime);await verifyIngestRuntimeRole(runtime);
      const open=()=>createApplication({tenantId,store:new PostgresSessionStore(runtime!),sources:{novels:new PostgresDocumentStore(runtime!),scripts:new PostgresScriptStore(runtime!)}});
      app=await open();const write={authorization:`Bearer ${editor.token}`};const read={authorization:`Bearer ${viewer.token}`};
      const novel='/api/v1/projects/project/novels/source';const text='前言\r\n第一章 到站\r\n甲😀说：你好。\r\n第二章 回信\r\n乙打开信。';
      const batch={batchId:'first',text,expectedRevision:0,title:'雾港来信.txt'};
      const posted=await app.inject({method:'POST',url:novel+'/batches',headers:write,payload:batch});expect(posted.statusCode).toBe(201);expect(posted.json().revision).toBe(1);
      expect((await app.inject({method:'POST',url:novel+'/batches',headers:write,payload:batch})).json().duplicate).toBe(true);
      expect((await app.inject({method:'POST',url:novel+'/batches',headers:read,payload:batch})).statusCode).toBe(403);
      const page=await app.inject({method:'GET',url:novel,headers:read});expect(page.json().excerpt.text).toBe(text);expect(page.json().checkpoint).toBeNull();
      expect((await app.inject({method:'POST',url:novel+'/checkpoint',headers:read,payload:{sourceDigest:page.json().sourceDigest,offset:3,expectedVersion:0}})).json()).toEqual({offset:3,version:1});
      expect((await app.inject({method:'GET',url:novel,headers:write})).json().checkpoint).toBeNull();
      const inputs={fountain:Buffer.from('.内景 车站\n\n@小林\n你好\n'),csv:Buffer.from('场景,角色,对白\n车站,小林,你好\n'),tsv:Buffer.from('场景\t角色\t对白\n车站\t小林\t你好\n'),
        docx:Buffer.from(docx('<w:p><w:pPr><w:pStyle w:val="SceneHeading"/></w:pPr><w:r><w:t>内景 车站</w:t></w:r></w:p><w:p><w:r><w:t>你好</w:t></w:r></w:p>'))};
      for(const [format,bytes] of Object.entries(inputs)){
        const route=`/api/v1/projects/project/scripts/${format}/${format}?title=${format}`;const binary={...write,'content-type':'application/octet-stream'};
        expect((await app.inject({method:'PUT',url:route,headers:binary,payload:bytes})).statusCode).toBe(200);
        expect((await app.inject({method:'PUT',url:route,headers:binary,payload:bytes})).json().duplicate).toBe(true);
        const projected=(await app.inject({method:'GET',url:`/api/v1/projects/project/scripts/${format}`,headers:read})).json();
        expect(projected.format).toBe(format);expect(projected.excerpt.text).toContain('你好');expect(projected.original).toBeUndefined();expect(projected.snapshot).toBeUndefined();
        const raw=await admin.query('SELECT original FROM camery_ingest.scripts WHERE tenant_id=$1 AND document_id=$2',[tenantId,format]);expect(raw.rows[0].original).toEqual(bytes);
      }
      expect((await app.inject({method:'GET',url:'/api/v1/projects/project/sources',headers:read})).json().items).toHaveLength(5);
      expect((await app.inject({method:'GET',url:novel.replace('/project/','/other/'),headers:read})).statusCode).toBe(403);
      await app.close();app=await open();
      expect((await app.inject({method:'GET',url:novel,headers:read})).json()).toMatchObject({checkpoint:{offset:3,version:1},excerpt:{start:3}});
      await installer.provisionMember({tenantId,projectId:'project',userId:'editor',role:'viewer'});
      expect((await app.inject({method:'POST',url:novel+'/batches',headers:write,payload:{batchId:'next',text:'新正文',expectedRevision:1}})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:'/api/v1/auth/sign-out',headers:read})).statusCode).toBe(204);
      expect((await app.inject({method:'GET',url:novel,headers:read})).statusCode).toBe(401);
    }finally{
      await app?.close();await runtime?.end();
      await admin.query('DELETE FROM camery_ingest.reading_checkpoints WHERE tenant_id=$1',[tenantId]);await admin.query('DELETE FROM camery_ingest.documents WHERE tenant_id=$1',[tenantId]);await admin.query('DELETE FROM camery_ingest.scripts WHERE tenant_id=$1',[tenantId]);
      await admin.query('DELETE FROM camery_access.sessions WHERE tenant_id=$1',[tenantId]);await admin.query('DELETE FROM camery_access.memberships WHERE tenant_id=$1',[tenantId]);await admin.query('DELETE FROM camery_access.users WHERE tenant_id=$1',[tenantId]);
      if(created){await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_access,camery_ingest FROM ${role}`);await admin.query(`REVOKE ALL ON SCHEMA camery_access,camery_ingest FROM ${role}`);await admin.query(`DROP ROLE ${role}`);}await admin.end();
    }
  });
});
