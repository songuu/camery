import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  Controller, Get, Post, HttpCode, Inject, Req, Param, SetMetadata, Module, Catch, HttpException,
  type CanActivate, type ExecutionContext, type DynamicModule, type ExceptionFilter, type ArgumentsHost,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AccessError, AccessService, authorize, permissionsFor, type SessionStore } from '@camery/access';
import fastifyStatic from '@fastify/static';
import { ImportError } from '@camery/ingest';
import { BibleError } from '@camery/bible';
import { DevelopmentError } from '@camery/script';
import { OutlineError } from '@camery/script/outline/contracts';
import { OUTLINE_HTTP_CONFIRM_BYTES } from '@camery/script/outline/http';
import { OutlineModule } from './outline.js';
import type { OutlineApiOptions } from './outline-options.js';
import { DevelopmentModule } from './development.js';
import type { DevelopmentApiOptions } from './development-options.js';
import { BibleModule } from './bible.js';
import type { BibleApiOptions } from './bible-options.js';
import { IngestModule } from './ingest.js';
import type { SourceStores } from './ingest.js';
import { POLICY, RequireAccess } from './policy.js';
import type { AccessPolicy, AuthRequest } from './policy.js';
import {ProjectModule} from './projects/http.js';
import {OutlineAdoptionModule} from './projects/outline-adoption-http.js';
import type {OutlineAdoptionOptions} from './projects/outline-adoption-options.js';
import {OutlineFormalReadModule} from './projects/outline-formal-http.js';
import type {OutlineFormalReadOptions} from './projects/outline-formal-options.js';
import type {ProjectApplicationOptions} from './projects/options.js';
import {ProjectIdentityError} from './projects/contracts.js';
import {ProjectApplicationError} from './projects/intent-contracts.js';
import {VersionPersistenceError} from '@camery/versioning/node';
export { RequireAccess } from './policy.js';

const SERVICE = Symbol('camery.access.service');
// Public access stays private to this module so new business routes must declare a policy.
const Public = (): MethodDecorator => SetMetadata(POLICY, 'public');
export interface AccessOptions { readonly tenantId: string; readonly store: SessionStore; readonly sources?: SourceStores; readonly bibles?:BibleApiOptions; readonly development?:DevelopmentApiOptions; readonly outlines?:OutlineApiOptions; readonly projects?:ProjectApplicationOptions; readonly outlineAdoption?:OutlineAdoptionOptions; readonly outlineFormal?:OutlineFormalReadOptions; readonly frontendDirectory?: string }

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
    } else if (error instanceof ImportError) {
      code = error.code;
      status = ({ INVALID_INPUT: 400, INPUT_LIMIT: 413, UNSUPPORTED_FORMAT: 415, MALFORMED_DOCUMENT: 422, CONFLICT: 409, NOT_FOUND: 404, STORAGE_FAILED: 503 } as const)[error.code];
    } else if (error instanceof BibleError) {
      code=error.code;
      status=({INVALID_INPUT:400,INPUT_LIMIT:413,INVALID_EVIDENCE:422,CONFLICT:409,FORBIDDEN:403,INCOMPLETE:409,MODEL_FAILED:503,NOT_FOUND:404,STORAGE_FAILED:503} as const)[error.code];
    } else if (error instanceof DevelopmentError || error instanceof OutlineError) {
      code=error.code;
      status=({INVALID_INPUT:400,INPUT_LIMIT:413,INVALID_REFERENCE:422,CONFLICT:409,FORBIDDEN:403,INVALID_EVIDENCE:422,INCOMPLETE:409,NOT_FOUND:404,STORAGE_FAILED:503} as const)[error.code];
    } else if(error instanceof ProjectIdentityError){
      code=error.code;status=({INVALID_INPUT:400,PROJECT_BINDING_MISSING:409,PRINCIPAL_BINDING_MISSING:403,BINDING_CONFLICT:409,STORAGE_FAILED:503} as const)[error.code];
    } else if(error instanceof ProjectApplicationError){
      code=error.code;status=({INVALID_INPUT:400,INPUT_LIMIT:413,CONFLICT:409,NOT_FOUND:404,STORAGE_FAILED:503,SNAPSHOT_STALE:409,WRITE_VERSION_CONFLICT:409,SCHEMA_UPGRADE_REQUIRED:409,SOURCE_POLICY_MISSING:409,ASSET_NOT_READY:409} as const)[error.code];
    } else if(error instanceof VersionPersistenceError){
      const versions:Record<string,{code:string;status:number}>={SNAPSHOT_STALE:{code:'SNAPSHOT_STALE',status:409},WRITE_VERSION_CONFLICT:{code:'WRITE_VERSION_CONFLICT',status:409},PROJECT_NOT_FOUND:{code:'NOT_FOUND',status:404},ADOPTION_SOURCE_CHANGED:{code:'CONFLICT',status:409},ADOPTION_SOURCE_UNREVIEWED:{code:'CONFLICT',status:409},ADOPTION_SOURCE_MISSING:{code:'CONFLICT',status:409}};
      const failure=Object.hasOwn(versions,error.code)?versions[error.code]:undefined;code=failure?.code??'STORAGE_FAILED';status=failure?.status??503;
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
  if(options.projects&&options.projects.tenantId!==options.tenantId)throw new Error('Project tenant mismatch');
  if(options.outlineAdoption&&options.outlineAdoption.tenantId!==options.tenantId)throw new Error('Outline adoption tenant mismatch');
  if(options.outlineFormal&&options.outlineFormal.tenantId!==options.tenantId)throw new Error('Formal outline tenant mismatch');
  @Module({ imports: [AccessModule.register(options), ...(options.sources ? [IngestModule.register(options.sources)] : []),...(options.bibles?[BibleModule.register(options.bibles)]:[]),...(options.development?[DevelopmentModule.register(options.development)]:[]),...(options.outlines?[OutlineModule.register(options.outlines)]:[]),...(options.projects?[ProjectModule.register(options.projects)]:[]),...(options.outlineAdoption?[OutlineAdoptionModule.register(options.outlineAdoption)]:[]),...(options.outlineFormal?[OutlineFormalReadModule.register(options.outlineFormal)]:[])] }) class ApplicationModule {}
  const app = await NestFactory.create<NestFastifyApplication>(ApplicationModule,
    new FastifyAdapter({ logger: false, trustProxy: false, bodyLimit: 16384, routerOptions: { maxParamLength: 512 }, genReqId: () => randomUUID() }),
    { logger: false, abortOnError: false });
  app.useSecurityHeaders();
  const fastify = app.getHttpAdapter().getInstance();
  if (options.sources) {
    fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 8_000_000 }, (_request, body, done) => done(null,body));
  }
  fastify.addHook('onRoute', route => {
      route.bodyLimit = 16384;
      if (route.url === '/api/v1/projects/:projectId/novels/:documentId/batches' && route.method === 'POST') route.bodyLimit = 6_100_000;
      if (route.url === '/api/v1/projects/:projectId/scripts/:documentId/:format' && route.method === 'PUT') route.bodyLimit = 8_000_000;
      if (route.url === '/api/v1/projects/:projectId/bibles/:runId/confirm' && route.method === 'POST') route.bodyLimit = 2_097_152;
      if (route.url === '/api/v1/projects/:projectId/development/:runId/:stage/confirm' && route.method === 'POST') route.bodyLimit = 524288;
      if (route.url === '/api/v1/projects/:projectId/outlines/:runId/confirm' && route.method === 'POST') route.bodyLimit = OUTLINE_HTTP_CONFIRM_BYTES;
      if (route.method === 'POST' && ['/api/v1/projects/:projectId/workbench/candidates','/api/v1/projects/:projectId/workbench/changes/preview'].includes(route.url)) route.bodyLimit = 532480;
  });
  if (options.frontendDirectory) await app.register(fastifyStatic, { root: options.frontendDirectory, wildcard: false, index: ['index.html'], cacheControl: false });
  await app.init(); await app.getHttpAdapter().getInstance().ready();
  return app;
}
