import { z } from 'zod';
import { dataArray, dataRecord } from './input.js';

const messages = {
  INVALID_INPUT: 'Invalid access request', UNAUTHENTICATED: 'Authentication required', FORBIDDEN: 'Access denied',
  STORAGE_FAILED: 'Access storage unavailable', MIGRATION_CONFLICT: 'Access migration history mismatch',
} as const;
export class AccessError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = 'AccessError'; }
}
export const accessId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/);
export const roleSchema = z.enum(['viewer', 'editor', 'reviewer', 'admin']);
export type Role = z.infer<typeof roleSchema>;
export const permissionSchema = z.enum(['project:read', 'candidate:write', 'candidate:review', 'task:run']);
export type Permission = z.infer<typeof permissionSchema>;
const identitySchema = z.strictObject({
  tenantId: accessId, userId: accessId, sessionId: accessId,
  grants: z.array(z.strictObject({ projectId: accessId, role: roleSchema })).max(10000),
}).refine(value => new Set(value.grants.map(grant => grant.projectId)).size === value.grants.length);
export interface SessionIdentity {
  readonly tenantId: string; readonly userId: string; readonly sessionId: string;
  readonly grants: readonly { readonly projectId: string; readonly role: Role }[];
}
const policy: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  viewer: Object.freeze(['project:read'] as const),
  editor: Object.freeze(['project:read', 'candidate:write', 'task:run'] as const),
  reviewer: Object.freeze(['project:read', 'candidate:review'] as const),
  admin: Object.freeze(['project:read', 'candidate:write', 'candidate:review', 'task:run'] as const),
});

/** Store results are detached so later callback mutation cannot change the authenticated request. */
export function parseIdentity(value: unknown): SessionIdentity {
  try {
    const record = dataRecord(value, ['tenantId', 'userId', 'sessionId', 'grants']);
    record['grants'] = dataArray(record['grants'], 10000).map(grant => dataRecord(grant, ['projectId', 'role']));
    const result = identitySchema.safeParse(record);
    if (!result.success) throw new AccessError('UNAUTHENTICATED');
    return Object.freeze({ ...result.data, grants: Object.freeze(result.data.grants.map(grant => Object.freeze(grant))) });
  } catch { throw new AccessError('UNAUTHENTICATED'); }
}
export function permissionsFor(subject: unknown, tenantId: string, projectId: string): readonly Permission[] {
  const principal = parseIdentity(subject);
  if (!accessId.safeParse(tenantId).success || !accessId.safeParse(projectId).success || principal.tenantId !== tenantId) throw new AccessError('FORBIDDEN');
  const grant = principal.grants.find(item => item.projectId === projectId);
  if (!grant) throw new AccessError('FORBIDDEN');
  return policy[grant.role];
}
export function authorize(subject: unknown, tenantId: string, projectId: string, permission: unknown): void {
  const parsed = permissionSchema.safeParse(permission);
  if (!parsed.success || !permissionsFor(subject, tenantId, projectId).includes(parsed.data)) throw new AccessError('FORBIDDEN');
}
