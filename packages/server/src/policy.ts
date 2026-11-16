import { SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Permission, SessionIdentity } from '@camery/access';
export const POLICY = Symbol('camery.access.policy');
export type AccessPolicy = Permission | 'authenticated';
export const RequireAccess = (permission: AccessPolicy): MethodDecorator => SetMetadata(POLICY, permission);
export interface AuthRequest extends FastifyRequest { principal: SessionIdentity }
