import 'reflect-metadata';
import { BadRequestException, Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessError, type SessionIdentity, type SessionStore } from '@camery/access';
import { AccessModule, RequireAccess, createApplication } from '../src/app.js';

const token = `cmry_${'a'.repeat(43)}`;
const identity: SessionIdentity = { tenantId: 't1', userId: 'u1', sessionId: 's1', grants: [{ projectId: 'p1', role: 'editor' }] };
const apps: NestFastifyApplication[] = [];
async function setup(result: SessionIdentity | null = identity) {
  const store = { lookup: vi.fn(async () => result), revoke: vi.fn(async () => {}) } satisfies SessionStore;
  const app = await createApplication({ tenantId: 't1', store }); apps.push(app); return { app, store };
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
describe('Nest/Fastify authentication boundary', () => {
  it('starts with a public health endpoint and refuses identity headers without bearer', async () => {
    const { app, store } = await setup();
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    const response = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'x-user-id': 'u1', 'x-tenant-id': 't1', 'x-role': 'admin' } });
    expect(response.statusCode).toBe(401); expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED', requestId: expect.any(String) });
    expect(store.lookup).not.toHaveBeenCalled();
  });
  it('returns server verified identity, ignores tenant query/header and never echoes bearer', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/v1/me?tenantId=other', headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'other' } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ tenantId: 't1', userId: 'u1', grants: identity.grants });
    expect(response.body).not.toContain(token); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
  it('filters project access by current role and rejects missing or cross project access', async () => {
    const { app } = await setup(); const headers = { authorization: `Bearer ${token}` };
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/p1/access', headers });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ projectId: 'p1', permissions: ['project:read', 'candidate:write', 'task:run'] });
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/p2/access', headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/p1/access' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/__proto__/access', headers })).statusCode).toBe(403);
  });
  it('does not trust a valid session belonging to another deployment tenant', async () => {
    const { app } = await setup({ ...identity, tenantId: 't2' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });
  it('revokes the authenticated session and observes revocation on the next request', async () => {
    const { app, store } = await setup(); const headers = { authorization: `Bearer ${token}` };
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-out', headers, payload: { userId: 'victim', tenantId: 'other', sessionId: 'victim' } });
    expect(response.statusCode).toBe(204); expect(store.revoke).toHaveBeenCalledWith('t1', 's1', 'u1');
    store.lookup.mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers })).statusCode).toBe(401);
  });
  it('uses uniform safe errors for storage failures and missing credentials', async () => {
    const { app, store } = await setup(null);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    store.lookup.mockRejectedValue(new Error(`postgresql://password ${token}`));
    const response = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain(token); expect(response.body).not.toContain('postgresql');
  });
  it('does not authenticate via cookies or query credentials; rejects ambiguous authorization', async () => {
    const { app, store } = await setup();
    for (const headers of [{ cookie: `session=${token}` }, { authorization: `Bearer ${token}, Bearer ${token}` }]) {
      expect((await app.inject({ method: 'GET', url: `/api/v1/me?token=${token}`, headers })).statusCode).toBe(401);
    }
    expect(store.lookup).not.toHaveBeenCalled();
    for (const values of [[`Bearer ${token}`, 'Bearer invalid'], ['Bearer invalid', `Bearer ${token}`]]) {
      expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { Authorization: values } })).statusCode).toBe(401);
    }
    expect(store.lookup).not.toHaveBeenCalled();
  });
  it('global guard denies routes without an explicit policy and applies project checks to consumer controllers', async () => {
    @Controller('boundary') class Consumer {
      @Get('unclassified') unclassified() { return { bad: 'must not execute' }; }
      @Get(':projectId/write') @RequireAccess('candidate:write') write() { return { ok: true }; }
      @Get(':projectId/review') @RequireAccess('candidate:review') review() { return { ok: true }; }
      @Get('throw') @RequireAccess('authenticated') failure() { throw new Error(token); }
      @Get('bad') @RequireAccess('authenticated') bad() { throw new BadRequestException(token); }
      @Get('invalid') @RequireAccess('authenticated') invalid() { throw new AccessError('INVALID_INPUT'); }
      @Get('denied') @RequireAccess('candidate:write') missingScope() { return { bad: true }; }
    }
    const store = { lookup: async () => identity, revoke: async () => {} };
    @Module({ imports: [AccessModule.register({ tenantId: 't1', store })], controllers: [Consumer] }) class ConsumerModule {}
    const app = await NestFactory.create<NestFastifyApplication>(ConsumerModule, new FastifyAdapter(), { logger: false, abortOnError: false });
    // The module owns the guard and safe error mapping even when embedded in another host.
    await app.init(); await app.getHttpAdapter().getInstance().ready(); apps.push(app);
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/boundary/unclassified', headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/boundary/p1/write', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/boundary/p1/review', headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/boundary/p2/write', headers })).statusCode).toBe(403);
    const error = await app.inject({ method: 'GET', url: '/boundary/throw', headers });
    expect(error.statusCode).toBe(500); expect(error.body).not.toContain(token);
    const bad = await app.inject({ method: 'GET', url: '/boundary/bad', headers });
    expect(bad.statusCode).toBe(400); expect(bad.body).not.toContain(token);
    expect((await app.inject({ method: 'GET', url: '/boundary/invalid', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/boundary/denied', headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/missing', headers })).json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});
