import {z} from 'zod';
import {StableId} from '@camery/ir';
import {freeze} from '@camery/methods';
import {snapshotJson} from '@camery/methods/json';
import type {VersionProjectKey} from '@camery/versioning/node';
import type {Principal} from '@camery/versioning';

const ordinaryId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
// The shared registry is also a boundary for stored driver values; require the exact canonical representation.
const stableId=StableId.refine(value=>value.length===26);
export const ProjectIdentityScopeSchema=z.strictObject({tenantId:ordinaryId,projectId:ordinaryId});
export const PrincipalIdentityScopeSchema=z.strictObject({tenantId:ordinaryId,kind:z.enum(['user','agent_run','system']),key:ordinaryId});
export const ResolveProjectIdentitySchema=ProjectIdentityScopeSchema.extend({kind:PrincipalIdentityScopeSchema.shape.kind,key:ordinaryId});
export const RegisterTenantIdentitySchema=z.strictObject({tenantId:ordinaryId,irTenantId:stableId});
export const RegisterProjectIdentitySchema=ProjectIdentityScopeSchema.extend({irProjectId:stableId});
export const RegisterPrincipalIdentitySchema=PrincipalIdentityScopeSchema.extend({irActorId:stableId});
export type ProjectIdentityScope=z.infer<typeof ProjectIdentityScopeSchema>;
export type PrincipalIdentityScope=z.infer<typeof PrincipalIdentityScopeSchema>;
export type ResolveProjectIdentity=z.infer<typeof ResolveProjectIdentitySchema>;
export interface TenantIdentityBinding {readonly tenantId:string;readonly irTenantId:string}
export interface ProjectIdentityBinding extends ProjectIdentityScope {readonly versionKey:Readonly<VersionProjectKey>}
export interface PrincipalIdentityBinding extends PrincipalIdentityScope {readonly principal:Readonly<Principal>}
export interface ResolvedProjectIdentity {readonly scope:Readonly<ProjectIdentityScope>;readonly versionKey:Readonly<VersionProjectKey>;readonly principal:Readonly<Principal>}
export class ProjectIdentityError extends Error {
  override readonly name='ProjectIdentityError';
  constructor(readonly code:'INVALID_INPUT'|'PROJECT_BINDING_MISSING'|'PRINCIPAL_BINDING_MISSING'|'BINDING_CONFLICT'|'STORAGE_FAILED',readonly operation:string){super(`Project identity ${operation} failed (${code})`);}
}
/** Capture before the first await; accessors and unexpected keys never become authority. */
export function captureIdentity<S extends z.ZodType>(schema:S,input:unknown,operation:string):Readonly<z.infer<S>>{
  try{const result=schema.safeParse(snapshotJson(input,8192));if(result.success)return freeze(result.data);}catch{/* Do not expose arbitrary accessor or validation exceptions. */}
  throw new ProjectIdentityError('INVALID_INPUT',operation);
}
export function storedIdentityId(input:unknown):string{
  const result=stableId.safeParse(input);if(!result.success)throw new ProjectIdentityError('STORAGE_FAILED','stored binding');return result.data;
}
