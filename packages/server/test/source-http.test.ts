import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionIdentity, SessionStore } from '@camery/access';
import { ImportError, appendNovelBatch, advanceReading, importFountain, importNovel } from '@camery/ingest';
import type { NovelSnapshot, ReadingCheckpoint } from '@camery/ingest';
import { createApplication } from '../src/app.js';
import type { SourceStores } from '../src/ingest.js';
const token = `cmry_${'b'.repeat(43)}`;
const headers = { authorization: `Bearer ${token}` };
const principal: SessionIdentity = { tenantId: 'tenant', userId: 'reader', sessionId: 'session', grants: [{ projectId: 'project', role: 'editor' }] };
const apps: Awaited<ReturnType<typeof createApplication>>[] = [];
async function setup(role: 'editor' | 'viewer' = 'editor') {
  let snapshot: NovelSnapshot | undefined; let checkpoint: ReadingCheckpoint | undefined;
  const identity = { ...principal, grants: [{ projectId: 'project', role }] };
  const sessions = { lookup: vi.fn(async () => identity as SessionIdentity | null), revoke: vi.fn(async () => {}) } satisfies SessionStore;
  const script = importFountain('.场景\n\n@小林\n你好\n');
  const summary = { documentId: 'script', title: '剧本', kind: 'script' as const, format: 'fountain' as const, revision: 1 };
  const sources = {
    novels: { append: vi.fn(async (input: unknown) => { const result = appendNovelBatch(snapshot,input); snapshot = result.snapshot; return result; }),
      read: vi.fn(async (_input: unknown) => { if (!snapshot) throw new ImportError('NOT_FOUND','novel'); return { snapshot, document: importNovel(snapshot.text), checkpoint: checkpoint ?? null }; }),
      checkpoint: vi.fn(async (input: unknown) => { checkpoint = advanceReading(snapshot,checkpoint,input); return checkpoint; }) },
    scripts: { import: vi.fn(async (_input: unknown) => ({ summary, document: script, duplicate: false })),
      read: vi.fn(async (_input: unknown) => ({ summary, document: script })),
      list: vi.fn(async (_input: unknown) => ({ items: [], nextCursor: null })) },
  } satisfies SourceStores;
  const app = await createApplication({ tenantId: 'tenant', store: sessions, sources }); apps.push(app); return { app, sources, sessions };
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
describe('authorized source HTTP boundary', () => {
  it.each([100,101,128,129])('aligns route identifiers with the 128-character source contract (%s)',async size=>{
    const {app}=await setup();
    const response=await app.inject({method:'POST',url:`/api/v1/projects/project/novels/${'a'.repeat(size)}/batches`,headers,payload:{batchId:'first',text:'第一章 原文',expectedRevision:0}});
    expect(response.statusCode).toBe(size<=128?201:400);
  });
  it('allows valid percent-encoded source identifiers without broadening unrelated binary routes',async()=>{
    const {app}=await setup();const identifier='a'+':'.repeat(127);
    expect((await app.inject({method:'POST',url:`/api/v1/projects/project/novels/${encodeURIComponent(identifier)}/batches`,headers,payload:{batchId:'first',text:'原文',expectedRevision:0}})).statusCode).toBe(201);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/sign-out',headers:{...headers,'content-type':'application/octet-stream'},payload:Buffer.alloc(20_000)})).statusCode).toBe(413);
  });
  it('requires current project write permission before calling importer', async () => {
    const { app, sources, sessions } = await setup();
    const request = { method: 'POST' as const, url: '/api/v1/projects/project/novels/doc/batches', payload: { batchId: 'first', text: '第一章 开始\n内容', expectedRevision: 0, title: '小说' } };
    expect((await app.inject(request)).statusCode).toBe(401); expect(sources.novels.append).not.toHaveBeenCalled();
    expect((await app.inject({ ...request, headers, url: request.url.replace('/project/','/other/') })).statusCode).toBe(403);
    expect((await app.inject({ ...request, headers })).statusCode).toBe(201);
    expect(sources.novels.append).toHaveBeenCalledWith({ tenantId: 'tenant', projectId: 'project', documentId: 'doc', ...request.payload });
    sessions.lookup.mockResolvedValue({ ...principal, grants: [{ projectId: 'project', role: 'viewer' }] });
    expect((await app.inject({ ...request, headers })).statusCode).toBe(403);
  });
  it('rejects identity injection and reads only a bounded projection under the authenticated reader', async () => {
    const { app, sources } = await setup(); const url = '/api/v1/projects/project/novels/doc';
    const body = { batchId: 'first', text: '第一章 开始\n😀内容'.repeat(2000), expectedRevision: 0 };
    expect((await app.inject({ method: 'POST', url: url+'/batches', headers, payload: { ...body, tenantId: 'other' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: url+'/batches', headers, payload: body })).statusCode).toBe(201);
    const page = await app.inject({ method: 'GET', url, headers }); expect(page.statusCode).toBe(200);
    expect(page.json().excerpt.text.length).toBeLessThanOrEqual(12000); expect(page.json().snapshot).toBeUndefined();
    expect(sources.novels.read).toHaveBeenCalledWith({ tenantId: 'tenant', projectId: 'project', documentId: 'doc', readerId: 'reader' });
    const progress = { sourceDigest: page.json().sourceDigest, offset: 3, expectedVersion: 0 };
    expect((await app.inject({ method: 'POST', url: url+'/checkpoint', headers, payload: { ...progress, readerId: 'victim' } })).statusCode).toBe(400);
    const saved = await app.inject({ method: 'POST', url: url+'/checkpoint', headers, payload: progress });
    expect(saved.json()).toEqual({ offset: 3, version: 1 }); expect(saved.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: url+'?tenantId=other', headers })).statusCode).toBe(400);
  });
  it('accepts binary scripts only after authorization and keeps ordinary JSON endpoints small', async () => {
    const { app, sources } = await setup(); const binary = Buffer.from('.场景\n');
    const route = '/api/v1/projects/project/scripts/script/fountain?title=source.fountain';
    expect((await app.inject({ method: 'PUT', url: route, headers: { 'content-type': 'application/octet-stream' }, payload: binary })).statusCode).toBe(401);
    expect(sources.scripts.import).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'PUT', url: route, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: binary })).statusCode).toBe(200);
    expect(sources.scripts.import).toHaveBeenCalledWith({ tenantId: 'tenant', projectId: 'project', documentId: 'script', format: 'fountain', title: 'source.fountain', bytes: binary });
    expect((await app.inject({ method: 'PUT', url: route, headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/project/scripts/script', headers })).json().format).toBe('fountain');
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/sign-out', headers, payload: { data: 'x'.repeat(20_000) } })).statusCode).toBe(413);
  });
  it('allows viewers to read and save their own position, never import, and observes revoked sessions', async () => {
    const { app, sources, sessions } = await setup('viewer');
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/project/sources', headers })).statusCode).toBe(200);
    expect(sources.scripts.list).toHaveBeenCalledWith({ tenantId: 'tenant', projectId: 'project' });
    expect((await app.inject({ method: 'PUT', url: '/api/v1/projects/project/scripts/s/docx?title=doc', headers: { ...headers,'content-type':'application/octet-stream' }, payload: Buffer.from('invalid') })).statusCode).toBe(403);
    expect(sources.scripts.import).not.toHaveBeenCalled(); sessions.lookup.mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/project/sources', headers })).statusCode).toBe(401);
  });
  it.each([['INVALID_INPUT',400],['INPUT_LIMIT',413],['UNSUPPORTED_FORMAT',415],['MALFORMED_DOCUMENT',422],['CONFLICT',409],['NOT_FOUND',404],['STORAGE_FAILED',503]] as const)('maps %s to safe HTTP %s', async (code,status) => {
    const { app,sources } = await setup(); sources.scripts.list.mockRejectedValue(new ImportError(code,'private source path'));
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/project/sources', headers });
    expect(response.statusCode).toBe(status); expect(response.json()).toEqual({ code, requestId: expect.any(String) }); expect(response.body).not.toContain('private');
  });
});
