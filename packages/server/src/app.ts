import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  Controller, Get, Post, HttpCode, Inject, Req, Param, SetMetadata, Module, Catch, HttpException,
  type CanActivate, type ExecutionContext, type DynamicModule, type ExceptionFilter, type ArgumentsHost,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AccessError, AccessService, authorize, permissionsFor, type Permission, type SessionIdentity, type SessionStore } from '@camery/access';

const POLICY = Symbol('camery.access.policy');
const SERVICE = Symbol('camery.access.service');
type AccessPolicy = Permission | 'authenticated';
export const RequireAccess = (permission: AccessPolicy): MethodDecorator => SetMetadata(POLICY, permission);
// Public access stays private to this module so new business routes must declare a policy.
const Public = (): MethodDecorator => SetMetadata(POLICY, 'public');
interface AuthRequest extends FastifyRequest { principal: SessionIdentity }
export interface AccessOptions { readonly tenantId: string; readonly store: SessionStore }

class AccessGuard implements CanActivate {
  private readonly reflector = new Reflector();
  constructor(private readonly service: AccessService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthRequest>();
    http.getResponse<FastifyReply>().header('Cache-Control', 'no-store');
    const policy = this.reflector.get<AccessPolicy | 'public'>(POLICY, context.getHandler());
    if (policy === 'public') return true;
    if (!policy) throw new AccessError('FORBIDDEN');
    // Node may expose only the first duplicate Authorization; inspect the wire headers too.
    const authorizationCount = request.raw.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'authorization').length;
    if (authorizationCount !== 1) throw new AccessError('UNAUTHENTICATED');
    request.principal = await this.service.authenticate(request.headers.authorization);
    if (policy !== 'authenticated') {
      const projectId = (request.params as Record<string, unknown>)['projectId'];
      if (typeof projectId !== 'string') throw new AccessError('FORBIDDEN');
      authorize(request.principal, this.service.tenantId, projectId, policy);
    }
    return true;
  }
}

@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp(); const response = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    let status = 500; let code = 'INTERNAL_ERROR';
    if (error instanceof AccessError) {
      code = error.code;
      status = error.code === 'UNAUTHENTICATED' ? 401 : error.code === 'FORBIDDEN' ? 403 : error.code === 'INVALID_INPUT' ? 400 : 503;
    } else if (error instanceof HttpException) {
      status = error.getStatus(); code = status === 404 ? 'NOT_FOUND' : 'REQUEST_REJECTED';
    }
    if (status === 401) response.header('WWW-Authenticate', 'Bearer');
    void response.status(status).header('Cache-Control', 'no-store').send({ code, requestId: request.id });
  }
}

@Controller()
class AccessController {
  constructor(@Inject(SERVICE) private readonly service: AccessService) {}
  @Get('health') @Public()
  health() { return { status: 'ok' }; }
  @Get('api/v1/me') @RequireAccess('authenticated')
  me(@Req() request: AuthRequest) {
    const { tenantId, userId, grants } = request.principal;
    return { tenantId, userId, grants };
  }
  @Get('api/v1/projects/:projectId/access') @RequireAccess('project:read')
  projectAccess(@Req() request: AuthRequest, @Param('projectId') projectId: string) {
    return { projectId, permissions: permissionsFor(request.principal, this.service.tenantId, projectId) };
  }
  @Post('api/v1/auth/sign-out') @HttpCode(204) @RequireAccess('authenticated')
  async signOut(@Req() request: AuthRequest): Promise<void> { await this.service.signOut(request.principal); }
}

@Module({})
export class AccessModule {
  static register(options: AccessOptions): DynamicModule {
    const service = new AccessService(options);
    return { module: AccessModule, controllers: [AccessController], providers: [
      { provide: SERVICE, useValue: service },
      { provide: APP_GUARD, useValue: new AccessGuard(service) },
      { provide: APP_FILTER, useClass: SafeErrors },
    ] };
  }
}

/** No trusting proxy identity, credential cookies, global user state or request/header logging. */
export async function createApplication(options: AccessOptions): Promise<NestFastifyApplication> {
  @Module({ imports: [AccessModule.register(options)] }) class ApplicationModule {}
  const app = await NestFactory.create<NestFastifyApplication>(ApplicationModule,
    new FastifyAdapter({ logger: false, trustProxy: false, bodyLimit: 16384, genReqId: () => randomUUID() }),
    { logger: false, abortOnError: false });
  app.useSecurityHeaders();
  await app.init(); await app.getHttpAdapter().getInstance().ready();
  return app;
}
