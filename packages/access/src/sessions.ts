import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataRecord } from './input.js';
import { AccessError, accessId, parseIdentity, type SessionIdentity } from './policy.js';

export interface SessionStore {
  lookup(tenantId: string, tokenHash: string): Promise<SessionIdentity | null>;
  revoke(tenantId: string, sessionId: string, userId: string): Promise<void>;
}
export interface SessionIssuer {
  createSession(request: { tenantId: string; userId: string; sessionId: string; tokenHash: string; ttlSeconds: number }): Promise<void>;
}
const bearer = /^Bearer (cmry_[A-Za-z0-9_-]{43})$(?![\s\S])/;
function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

export class AccessService {
  readonly tenantId: string;
  private readonly lookup: SessionStore['lookup'];
  private readonly revoke: SessionStore['revoke'];
  private readonly verified = new WeakSet<SessionIdentity>();
  constructor(options: { tenantId: string; store: SessionStore }) {
    const parsed = accessId.safeParse(options.tenantId);
    if (!parsed.success) throw new AccessError('INVALID_INPUT');
    this.tenantId = parsed.data;
    this.lookup = options.store.lookup.bind(options.store); this.revoke = options.store.revoke.bind(options.store);
  }
  async authenticate(header: unknown): Promise<SessionIdentity> {
    const match = typeof header === 'string' ? bearer.exec(header) : null;
    const token = match?.[1];
    if (!token) throw new AccessError('UNAUTHENTICATED');
    let result: unknown;
    try { result = await this.lookup(this.tenantId, tokenHash(token)); } catch { throw new AccessError('STORAGE_FAILED'); }
    const principal = parseIdentity(result);
    if (principal.tenantId !== this.tenantId) throw new AccessError('UNAUTHENTICATED');
    this.verified.add(principal); return principal;
  }
  async signOut(principal: SessionIdentity): Promise<void> {
    // A caller-supplied JSON identity must never revoke someone else's session.
    if (!this.verified.has(principal)) throw new AccessError('UNAUTHENTICATED');
    try { await this.revoke(this.tenantId, principal.sessionId, principal.userId); } catch { throw new AccessError('STORAGE_FAILED'); }
  }
}

/** Trusted installation/admin boundary only; this issuer is deliberately absent from HTTP routes. */
export async function issueSession(input: unknown, issuer: SessionIssuer): Promise<{ sessionId: string; token: string }> {
  let record: Record<string, unknown>;
  try { record = dataRecord(input, ['tenantId', 'userId', 'ttlSeconds']); } catch { throw new AccessError('INVALID_INPUT'); }
  const result = z.strictObject({ tenantId: accessId, userId: accessId, ttlSeconds: z.number().int().min(60).max(86400) }).safeParse(record);
  if (!result.success) throw new AccessError('INVALID_INPUT');
  const token = `cmry_${randomBytes(32).toString('base64url')}`; const sessionId = randomUUID();
  try { await issuer.createSession({ ...result.data, sessionId, tokenHash: tokenHash(token) }); } catch { throw new AccessError('STORAGE_FAILED'); }
  return { sessionId, token };
}
