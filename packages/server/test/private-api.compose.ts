import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { issueSession } from '@camery/access';
import { migrateAccess, PostgresSessionStore } from '@camery/access/node';
import { migrateIngest } from '@camery/ingest/node';
import { docx } from '../../ingest/test/fixtures/docx.js';
import { releaseResources } from '../src/shutdown.js';
import { docker } from './fixtures/compose-probe.js';

const databaseUrl = process.env['CAMERY_TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('CAMERY_TEST_DATABASE_URL is required for private API tests');

it.each([false,true])('starts the built private API with sourceImports=%s, a file secret and least privilege', async sourceImports => {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  const suffix = randomBytes(12).toString('hex'); const project = `camery-api-smoke-${suffix}`;
  const role = `api_smoke_${suffix}`; const password = randomBytes(32).toString('hex'); const tenantId = `api-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'camery-api-smoke-'));
  const secretPath = join(directory, 'database-url'); const networkPath = join(directory, 'network.yml');
  const compose = ['compose', '--project-name', project, '--env-file', 'deploy/.env.phase0', '-f', 'deploy/compose.private.yml', '-f', 'deploy/compose.api.yml', '-f', networkPath];
  const env = { ...process.env, CAMERY_TENANT_ID: tenantId, CAMERY_API_PORT: '0', CAMERY_API_DATABASE_SECRET_FILE: secretPath, CAMERY_SOURCE_IMPORTS: sourceImports?'1':'0' };
  let roleCreated = false; let composeAttempted = false; let initialized = false; let sourcesInitialized=false;
  try {
    // Reuse the explicitly named local fixture network without restarting its database service.
    await docker(['network', 'inspect', 'camery-phase0_default', '--format', '{{.Name}}']);
    await migrateAccess(pool); initialized = true; const installer = new PostgresSessionStore(pool);
    if(sourceImports){await migrateIngest(pool);sourcesInitialized=true;}
    await installer.provisionMember({ tenantId, userId: 'user-a', projectId: 'project-a', role: 'editor' });
    const session = await issueSession({ tenantId, userId: 'user-a', ttlSeconds: 3600 }, installer);
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`); roleCreated = true;
    await pool.query(`GRANT USAGE ON SCHEMA camery_access TO ${role}`);
    await pool.query(`GRANT SELECT ON camery_access.users,camery_access.memberships,camery_access.sessions TO ${role}`);
    await pool.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO ${role}`);
    if(sourceImports){
      await pool.query(`GRANT USAGE ON SCHEMA camery_ingest TO ${role}`);
      await pool.query(`GRANT SELECT,INSERT,UPDATE ON camery_ingest.documents,camery_ingest.reading_checkpoints TO ${role}`);
      await pool.query(`GRANT SELECT,INSERT ON camery_ingest.scripts TO ${role}`);
    }
    const url = new URL(databaseUrl!); url.hostname = 'postgres'; url.port = '5432'; url.username = role; url.password = password;
    // The temp directory is private; the bind-mounted file must be readable by the image's non-root UID.
    await writeFile(secretPath, url.toString() + '\n', { mode: 0o444 });
    await writeFile(networkPath, 'networks:\n  default:\n    external: true\n    name: camery-phase0_default\n', { mode: 0o600 });
    await docker([...compose, 'config', '--quiet'], env);
    composeAttempted = true;
    await docker([...compose, 'up', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '50', '-d', 'api'], env);
    const port = await docker([...compose, 'port', 'api', '3000'], env);
    expect(port).toMatch(/^127\.0\.0\.1:\d+$/);
    const container = await docker([...compose, 'ps', '--quiet', 'api'], env);
    const properties = await docker(['inspect', '--format', '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{json .HostConfig.CapDrop}}', container]);
    expect(properties).toMatch(/^(?:node|1000(?::1000)?) true false \["ALL"\]$/);
    let address = `http://${port}`; const headers = { authorization: `Bearer ${session.token}` };
    const request = (path: string, method = 'GET') => fetch(address + path, { method, headers, signal: AbortSignal.timeout(5000) });
    expect((await request('/health')).status).toBe(200);
    const html=await(await fetch(address+'/',{signal:AbortSignal.timeout(5000)})).text();expect(html).toContain('来源工作台');
    const asset=html.match(/src="([^"]+\.js)"/);expect(asset).not.toBeNull();
    expect((await fetch(address+asset![1],{signal:AbortSignal.timeout(5000)})).status).toBe(200);
    expect((await request('/api/v1/me')).status).toBe(200);
    expect(await (await request('/api/v1/projects/project-a/access')).json()).toEqual({ projectId: 'project-a', permissions: ['project:read', 'candidate:write', 'task:run'] });
    expect((await request('/api/v1/projects/project-b/access')).status).toBe(403);
    expect((await fetch(address + '/api/v1/me', { signal: AbortSignal.timeout(5000) })).status).toBe(401);
    const source='/api/v1/projects/project-a/novels/source';
    if(sourceImports){
      const imported=await fetch(address+source+'/batches',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({batchId:'first',text:'第一章 真实容器\n甲😀乙',expectedRevision:0,title:'原文.txt'}),signal:AbortSignal.timeout(5000)});expect(imported.status).toBe(201);
      const page=await(await request(source)).json() as {sourceDigest:string};
      expect((await fetch(address+source+'/checkpoint',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({sourceDigest:page.sourceDigest,offset:3,expectedVersion:0}),signal:AbortSignal.timeout(5000)})).status).toBe(201);
      const bytes=Buffer.from(docx('<w:p><w:r><w:t>真实容器中的Word原文</w:t></w:r></w:p>'));
      expect((await fetch(address+'/api/v1/projects/project-a/scripts/word/docx?title=word.docx',{method:'PUT',headers:{...headers,'content-type':'application/octet-stream'},body:bytes,signal:AbortSignal.timeout(5000)})).status).toBe(200);
      expect(await(await request('/api/v1/projects/project-a/scripts/word')).text()).toContain('真实容器中的Word原文');
    }else expect((await request('/api/v1/projects/project-a/sources')).status).toBe(404);
    expect((await request('/api/v1/auth/sign-out', 'POST')).status).toBe(204);
    expect((await request('/api/v1/me')).status).toBe(401);
    await docker([...compose, 'restart', 'api'], env);
    await docker([...compose, 'up', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '50', '-d', 'api'], env);
    // Docker can assign a new host port after restarting a port-0 mapping.
    const resumedPort = await docker([...compose, 'port', 'api', '3000'], env);
    expect(resumedPort).toMatch(/^127\.0\.0\.1:\d+$/); address = `http://${resumedPort}`;
    expect((await request('/api/v1/me')).status).toBe(401);
    if(sourceImports){
      const fresh=await issueSession({tenantId,userId:'user-a',ttlSeconds:3600},installer);
      const resumed=await fetch(address+source,{headers:{authorization:`Bearer ${fresh.token}`},signal:AbortSignal.timeout(5000)});
      expect(await resumed.json()).toMatchObject({checkpoint:{offset:3,version:1},excerpt:{start:3}});
    }
    const logs = await docker([...compose, 'logs', '--no-color', 'api'], env);
    expect(logs).not.toContain(password); expect(logs).not.toContain(session.token); expect(logs).not.toContain(url.toString());
    await docker([...compose, 'stop', '--timeout', '10', 'api'], env);
    expect(await docker(['inspect', '--format', '{{.State.ExitCode}}', container])).toBe('0');
  } finally {
    const success = await releaseResources([
      () => composeAttempted ? docker([...compose, 'down', '--volumes', '--timeout', '10'], env) : undefined,
      () => initialized ? pool.query('DELETE FROM camery_access.sessions WHERE tenant_id=$1', [tenantId]) : undefined,
      () => initialized ? pool.query('DELETE FROM camery_access.memberships WHERE tenant_id=$1', [tenantId]) : undefined,
      () => initialized ? pool.query('DELETE FROM camery_access.users WHERE tenant_id=$1', [tenantId]) : undefined,
      () => sourcesInitialized ? pool.query('DELETE FROM camery_ingest.reading_checkpoints WHERE tenant_id=$1',[tenantId]) : undefined,
      () => sourcesInitialized ? pool.query('DELETE FROM camery_ingest.documents WHERE tenant_id=$1',[tenantId]) : undefined,
      () => sourcesInitialized ? pool.query('DELETE FROM camery_ingest.scripts WHERE tenant_id=$1',[tenantId]) : undefined,
      () => roleCreated ? pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_access FROM ${role}`) : undefined,
      () => roleCreated ? pool.query(`REVOKE USAGE ON SCHEMA camery_access FROM ${role}`) : undefined,
      () => roleCreated && sourceImports ? pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_ingest FROM ${role}`) : undefined,
      () => roleCreated && sourceImports ? pool.query(`REVOKE USAGE ON SCHEMA camery_ingest FROM ${role}`) : undefined,
      () => roleCreated ? pool.query(`DROP ROLE ${role}`) : undefined,
      () => pool.end(), () => rm(secretPath, { force: true }), () => rm(networkPath, { force: true }), () => rmdir(directory),
    ]);
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse unsafe or failed cleanup even when the test body failed.
    if (!success) throw new Error('Private API smoke cleanup failed');
  }
});
