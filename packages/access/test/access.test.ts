import { describe, expect, it, vi } from 'vitest';
import { AccessError, AccessService, authorize, issueSession, permissionsFor, type Role, type SessionIdentity } from '../src/index.js';
const identity: SessionIdentity = { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', grants: [{ projectId: 'project-a', role: 'editor' }] };
const token = `cmry_${'a'.repeat(43)}`;

describe('project role policy', () => {
  const expected = {
    viewer: ['project:read'], editor: ['project:read', 'candidate:write', 'task:run'],
    reviewer: ['project:read', 'candidate:review'], admin: ['project:read', 'candidate:write', 'candidate:review', 'task:run'],
  };
  for (const role of Object.keys(expected) as Role[]) {
    it(`${role} has exactly its declared permissions`, () => {
      const subject = { ...identity, grants: [{ projectId: 'project-a', role }] };
      expect(permissionsFor(subject, 'tenant-a', 'project-a')).toEqual(expected[role]);
      for (const permission of expected.admin) {
        if (expected[role].includes(permission)) expect(() => authorize(subject, 'tenant-a', 'project-a', permission)).not.toThrow();
        else expect(() => authorize(subject, 'tenant-a', 'project-a', permission)).toThrow(AccessError);
      }
      expect(() => authorize(subject, 'tenant-b', 'project-a', 'project:read')).toThrow(AccessError);
      expect(() => authorize(subject, 'tenant-a', 'project-b', 'project:read')).toThrow(AccessError);
    });
  }
  it.each(['__proto__', 'constructor', 'owner', ''])('rejects unknown role %s', role => {
    expect(() => permissionsFor({ ...identity, grants: [{ projectId: 'project-a', role }] }, 'tenant-a', 'project-a')).toThrow(AccessError);
  });
  it('rejects unknown actions, ambiguous grants and malformed scopes', () => {
    expect(() => authorize(identity, 'tenant-a', 'project-a', 'all')).toThrow(AccessError);
    expect(() => permissionsFor({ ...identity, grants: [...identity.grants, ...identity.grants] }, 'tenant-a', 'project-a')).toThrow(AccessError);
    expect(() => permissionsFor(identity, '', 'project-a')).toThrow(AccessError);
    expect(() => permissionsFor(null, 'tenant-a', 'project-a')).toThrow(AccessError);
  });
  it('rejects accessor and proxy identities without evaluating getters or leaking native errors', async () => {
    const getter = vi.fn(() => { throw new Error('private store diagnostic'); });
    const root = Object.defineProperty({ ...identity }, 'grants', { get: getter });
    const nested = { ...identity, grants: [Object.defineProperty({ projectId: 'p' }, 'role', { get: getter })] };
    const array = { ...identity, grants: Object.defineProperty([], '0', { get: getter }) };
    const proxy = new Proxy(identity, { ownKeys() { throw new Error('private store diagnostic'); } });
    for (const result of [root, nested, array, proxy, { ...identity, grants: 'invalid' }, { ...identity, extra: true }, { ...identity, grants: Array(1) }, { ...identity, grants: Array(10001) }]) {
      const service = new AccessService({ tenantId: 'tenant-a', store: { lookup: async () => result as SessionIdentity, revoke: vi.fn() } });
      await expect(service.authenticate(`Bearer ${token}`)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    }
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('opaque session authentication', () => {
  it('passes only tenant + token hash to storage and freezes detached verified identity', async () => {
    const raw = { ...identity, grants: identity.grants.map(grant => ({ ...grant })) }; const lookup = vi.fn(async () => raw);
    const service = new AccessService({ tenantId: 'tenant-a', store: { lookup, revoke: vi.fn() } });
    const principal = await service.authenticate(`Bearer ${token}`);
    expect(lookup).toHaveBeenCalledWith('tenant-a', expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(JSON.stringify(lookup.mock.calls)).not.toContain(token);
    raw.grants.length = 0; expect(principal.grants).toHaveLength(1);
    expect(Object.isFrozen(principal.grants[0])).toBe(true);
  });
  it.each([undefined, '', 'Basic abc', `bearer ${token}`, `Bearer ${token} `, [`Bearer ${token}`], 'Bearer cmry_short', `Bearer ${'x'.repeat(9000)}`])('rejects malformed bearer before lookup', async header => {
    const lookup = vi.fn(); const service = new AccessService({ tenantId: 'tenant-a', store: { lookup, revoke: vi.fn() } });
    await expect(service.authenticate(header)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(lookup).not.toHaveBeenCalled();
  });
  it.each([null, { ...identity, tenantId: 'tenant-b' }, { ...identity, userId: '' }, { ...identity, grants: [{ projectId: 'p', role: 'root' }] }])('fails closed on untrusted store identity', async result => {
    const service = new AccessService({ tenantId: 'tenant-a', store: { lookup: async () => result as SessionIdentity | null, revoke: vi.fn() } });
    await expect(service.authenticate(`Bearer ${token}`)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('maps storage errors without exposing secrets and revokes only verified sessions', async () => {
    const store = { lookup: vi.fn(async (): Promise<SessionIdentity> => { throw new Error(token); }), revoke: vi.fn() };
    const service = new AccessService({ tenantId: 'tenant-a', store });
    await expect(service.authenticate(`Bearer ${token}`)).rejects.toMatchObject({ code: 'STORAGE_FAILED', message: 'Access storage unavailable' });
    store.lookup.mockResolvedValue(identity);
    const principal = await service.authenticate(`Bearer ${token}`);
    await service.signOut(principal); expect(store.revoke).toHaveBeenCalledWith('tenant-a', 'session-a', 'user-a');
    await expect(service.signOut({ ...principal })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    store.revoke.mockRejectedValue(new Error(token)); await expect(service.signOut(principal)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });
  it('rejects invalid configuration and malformed issue requests', async () => {
    expect(() => new AccessService({ tenantId: '', store: { lookup: vi.fn(), revoke: vi.fn() } })).toThrow(AccessError);
    const createSession = vi.fn();
    await expect(issueSession({ tenantId: 'tenant-a', userId: 'u', ttlSeconds: 0 }, { createSession })).rejects.toThrow(AccessError);
    expect(createSession).not.toHaveBeenCalled();
    const getter = vi.fn(() => { throw new Error('private issue diagnostic'); });
    for (const input of [null, { tenantId: 't' }, Object.defineProperty({}, 'tenantId', { get: getter }), new Proxy({}, { ownKeys() { throw new Error('private'); } })]) {
      await expect(issueSession(input, { createSession })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'Invalid access request' });
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('issues independent 256-bit tokens, stores hashes only, and sanitizes failures', async () => {
    const createSession = vi.fn(async () => {}); const request = { tenantId: 'tenant-a', userId: 'u', ttlSeconds: 3600 };
    const first = await issueSession(request, { createSession }); const second = await issueSession(request, { createSession });
    expect(first.token).toMatch(/^cmry_[A-Za-z0-9_-]{43}$/); expect(first.token).not.toBe(second.token);
    expect(first.sessionId).not.toBe(second.sessionId); expect(JSON.stringify(createSession.mock.calls)).not.toContain(first.token);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', userId: 'u', sessionId: first.sessionId, ttlSeconds: 3600 }));
    createSession.mockRejectedValue(new Error('secret')); await expect(issueSession(request, { createSession })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });
});
