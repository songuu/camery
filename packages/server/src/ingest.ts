import { Body, Controller, Get, Post, Put, Param, Query, Req, Inject, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { z } from 'zod';
import { ImportError, createSourcePage } from '@camery/ingest';
import type { PostgresDocumentStore, PostgresScriptStore } from '@camery/ingest/node';
import { RequireAccess } from './policy.js';
import type { AuthRequest } from './policy.js';

const STORES = Symbol('camery.sources');
export interface SourceStores { readonly novels: Pick<PostgresDocumentStore, 'append' | 'read' | 'checkpoint'>; readonly scripts: Pick<PostgresScriptStore, 'import' | 'read' | 'list'> }
const Batch = z.strictObject({ batchId: z.string(), text: z.string(), expectedRevision: z.number(), title: z.string().optional() });
const Progress = z.strictObject({ sourceDigest: z.string(), offset: z.number(), expectedVersion: z.number() });
const TitleQuery = z.strictObject({ title: z.string() });
const CatalogQuery = z.strictObject({ cursor: z.string().optional() });
function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input); if (!parsed.success) throw new ImportError('INVALID_INPUT', 'request'); return parsed.data;
}
function scope(request: AuthRequest, projectId: string, documentId: string) { return { tenantId: request.principal.tenantId, projectId, documentId }; }

@Controller('api/v1/projects/:projectId')
class SourceController {
  constructor(@Inject(STORES) private readonly stores: SourceStores) {}
  @Get('sources') @RequireAccess('project:read')
  list(@Req() request: AuthRequest, @Param('projectId') projectId: string, @Query() query: unknown) {
    return this.stores.scripts.list({ tenantId: request.principal.tenantId, projectId, ...parse(CatalogQuery,query) });
  }
  @Post('novels/:documentId/batches') @RequireAccess('candidate:write')
  async append(@Req() request: AuthRequest, @Param('projectId') projectId: string, @Param('documentId') documentId: string, @Body() body: unknown) {
    const command = parse(Batch,body);
    const result = await this.stores.novels.append({ ...scope(request,projectId,documentId), ...command });
    const batchRevision = result.snapshot.batches.findIndex(batch => batch.id === command.batchId) + 1;
    return { documentId, title: result.snapshot.title ?? documentId, kind: 'novel', format: 'novel', revision: result.snapshot.revision,
      batchRevision, duplicate: result.duplicate, sourceDigest: result.document.sourceDigest };
  }
  @Get('novels/:documentId') @RequireAccess('project:read')
  async novel(@Req() request: AuthRequest, @Param('projectId') projectId: string, @Param('documentId') documentId: string, @Query() query: unknown) {
    const result = await this.stores.novels.read({ ...scope(request,projectId,documentId), readerId: request.principal.userId });
    return createSourcePage({ documentId, title: result.snapshot.title ?? documentId, kind: 'novel', revision: result.snapshot.revision, document: result.document,
      checkpoint: result.checkpoint ? { offset: result.checkpoint.offset, version: result.checkpoint.version } : null }, query);
  }
  @Post('novels/:documentId/checkpoint') @RequireAccess('project:read')
  async checkpoint(@Req() request: AuthRequest, @Param('projectId') projectId: string, @Param('documentId') documentId: string, @Body() body: unknown) {
    const result = await this.stores.novels.checkpoint({ ...scope(request,projectId,documentId), readerId: request.principal.userId, ...parse(Progress,body) });
    return { offset: result.offset, version: result.version };
  }
  @Put('scripts/:documentId/:format') @RequireAccess('candidate:write')
  async uploadScript(@Req() request: AuthRequest, @Param('projectId') projectId: string, @Param('documentId') documentId: string, @Param('format') format: string, @Query() query: unknown, @Body() body: unknown) {
    if (!Buffer.isBuffer(body)) throw new ImportError('INVALID_INPUT', 'script bytes');
    const result = await this.stores.scripts.import({ ...scope(request,projectId,documentId), format, ...parse(TitleQuery,query), bytes: body });
    return { ...result.summary, duplicate: result.duplicate, sourceDigest: result.document.sourceDigest };
  }
  @Get('scripts/:documentId') @RequireAccess('project:read')
  async script(@Req() request: AuthRequest, @Param('projectId') projectId: string, @Param('documentId') documentId: string, @Query() query: unknown) {
    const result = await this.stores.scripts.read(scope(request,projectId,documentId));
    return createSourcePage({ documentId: result.summary.documentId, title: result.summary.title, kind: result.summary.kind,
      revision: result.summary.revision, document: result.document }, query);
  }
}
@Module({})
export class IngestModule {
  static register(stores: SourceStores): DynamicModule { return { module: IngestModule, controllers: [SourceController], providers: [{ provide: STORES, useValue: stores }] }; }
}
