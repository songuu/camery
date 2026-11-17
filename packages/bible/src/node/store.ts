import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { Pin } from '@camery/methods';
import { ImportError } from '@camery/ingest';
import { readSourceDocument } from '@camery/ingest/node';
import { BibleError, Hash, Id } from '../contracts.js';
import type { BibleCandidate, ChunkRecord, ConfirmedBible, RejectedBible, ReviewHost, SourceSnapshot } from '../contracts.js';
import { asSourceInput, canonical, captureSource, copy, ensureSource, freeze, hash, parse, snapshotJson } from '../data.js';
import { createChunkPlan, validateChunkPlan } from '../chunks.js';
import { validateChunkRecord } from '../extraction.js';
import { assembleBibleCandidate } from '../candidate.js';
import { confirmBible, rejectBibleCandidate } from '../confirmation.js';
import { bibleRunDigest, executionForChunks, RunKeySchema, StartRunSchema,BibleReviewedSourceSchema } from './contracts.js';
import type { BibleProgress, BibleRun, BibleRunKey, BibleStore, StartBibleRun } from './contracts.js';

const Method=Pin.refine(value=>value.id==='story-bible-extract'&&value.version.trim()===value.version&&Hash.safeParse(value.digest).success);
const Host=z.strictObject({actor:z.strictObject({kind:z.literal('human'),id:Id}),tenantId:Id,projectId:Id,at:z.string().max(24),authorize:z.custom<ReviewHost['authorize']>(value=>typeof value==='function')});
type StoredRun={tenant_id:string;project_id:string;run_id:string;document_id:string;source_kind:string;source:unknown;plan:unknown;method:unknown;execution:unknown;digest:string;request_digest:string;created_at:Date|string};
type StoredChunk={chunk_id:string;digest:string;record:unknown};
type StoredReview={status:string;request_digest:string;digest:string;record:unknown};
const fields='tenant_id,project_id,run_id,document_id,source_kind,source,plan,method,execution,digest,request_digest,created_at';
const keys=(key:BibleRunKey)=>[key.tenantId,key.projectId,key.runId];
const scope=(key:BibleRunKey)=>freeze(parse(RunKeySchema,copy(key),'run identity'));
function captureHost(input:ReviewHost):ReviewHost {
  try{return freeze(parse(Host,input,'review host'));}catch{throw new BibleError('FORBIDDEN','review host');}
}
function startDigest(command:Pick<StartBibleRun,'documentId'|'kind'|'expectedRevision'|'expectedSourceDigest'|'method'|'execution'|'chunkLimits'>):string {
  return hash({documentId:command.documentId,kind:command.kind,expectedRevision:command.expectedRevision,expectedSourceDigest:command.expectedSourceDigest,
    method:command.method,execution:command.execution,chunkLimits:{maxCharacters:command.chunkLimits?.maxCharacters??12000,maxBytes:command.chunkLimits?.maxBytes??48000}});
}
function reviewDigest(record:ConfirmedBible|RejectedBible):string {
  return record.status==='confirmed'?hash({action:'confirm',actorId:record.actorId,decision:record.decision}):hash({action:'reject',actorId:record.actorId,candidateDigest:record.candidateDigest,reason:record.reason});
}
function decodeRun(row:StoredRun,key:BibleRunKey):BibleRun {
  try {
    const source=ensureSource(row.source as SourceSnapshot);const plan=validateChunkPlan(source,row.plan);const method=parse(Method,copy(row.method),'stored method');
    const execution=executionForChunks(row.execution,plan.chunks.length);const createdAt=row.created_at instanceof Date?row.created_at.toISOString():row.created_at;
    if(new Date(createdAt).toISOString()!==createdAt||row.tenant_id!==key.tenantId||row.project_id!==key.projectId||row.run_id!==key.runId||source.source.tenantId!==key.tenantId||source.source.projectId!==key.projectId
      ||source.source.documentId!==row.document_id||source.source.kind!==row.source_kind||row.digest!==bibleRunDigest(plan,method,execution)
      ||row.request_digest!==startDigest({documentId:source.source.documentId,kind:source.source.kind,expectedRevision:source.source.revision,expectedSourceDigest:source.source.sourceDigest,method,execution,chunkLimits:{maxCharacters:plan.maxCharacters,maxBytes:plan.maxBytes}}))throw new Error();
    return freeze({...key,source,plan,method,execution,digest:row.digest,createdAt});
  } catch {throw new BibleError('STORAGE_FAILED','stored run');}
}
function recordFor(run:BibleRun,input:unknown):ChunkRecord {
  const record=validateChunkRecord(run.source,run.plan,input,run.method);const model=record.model;const profile=run.execution;
  if(model.connectionId!==profile.connectionId||model.modeDigest!==profile.modeDigest||model.modelIdentity!==profile.modelIdentity||model.evidence!==profile.evidence)throw new BibleError('INVALID_EVIDENCE','run model binding');
  return record;
}

/** Append-only knowledge repository. Public applications must supply authenticated scope and a separate restricted LOGIN. */
export class PostgresBibleStore implements BibleStore {
  constructor(private readonly pool:Pool){}
  private async transaction<T>(key:BibleRunKey,action:(client:PoolClient)=>Promise<T>,source?:{documentId:string}):Promise<T> {
    const client=await this.pool.connect().catch(()=>{throw new BibleError('STORAGE_FAILED','connection');});
    try {
      await client.query('BEGIN');
      // Sources are always locked before runs. A run-only transaction never asks for a source lock later.
      if(source)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_ingest',key.tenantId,key.projectId,source.documentId])]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_bible',...keys(key)])]);
      const result=await action(client);await client.query('COMMIT');return result;
    } catch(error) {
      try{await client.query('ROLLBACK');}catch{throw new BibleError('STORAGE_FAILED','rollback');}
      if(error instanceof BibleError)throw error;
      if(error instanceof ImportError&&error.code==='NOT_FOUND')throw new BibleError('NOT_FOUND','source');
      throw new BibleError('STORAGE_FAILED','transaction');
    } finally {client.release();}
  }
  private async run(client:PoolClient,key:BibleRunKey):Promise<BibleRun|undefined> {
    const result=await client.query<StoredRun>(`SELECT ${fields} FROM camery_bible.runs WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3`,keys(key));
    return result.rows[0]?decodeRun(result.rows[0],key):undefined;
  }
  private async requiredRun(client:PoolClient,key:BibleRunKey):Promise<BibleRun> {
    const run=await this.run(client,key);if(!run)throw new BibleError('NOT_FOUND','run');return run;
  }
  private async records(client:PoolClient,run:BibleRun):Promise<ChunkRecord[]> {
    try {
      const rows=await client.query<StoredChunk>('SELECT chunk_id,digest,record FROM camery_bible.chunks WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3 ORDER BY chunk_id COLLATE "C"',keys(run));
      if(rows.rows.length>run.plan.chunks.length)throw new Error();const byId=new Map<string,ChunkRecord>();let bytes=2;
      for(const row of rows.rows){bytes+=Buffer.byteLength(canonical(row.record))+(byId.size?1:0);if(bytes>2097152)throw new Error();const record=recordFor(run,row.record);if(record.chunkId!==row.chunk_id||record.digest!==row.digest||byId.has(record.chunkId))throw new Error();byId.set(record.chunkId,record);}
      return run.plan.chunks.flatMap(chunk=>{const record=byId.get(chunk.id);return record?[record]:[];});
    } catch {throw new BibleError('STORAGE_FAILED','stored chunks');}
  }
  private async candidate(client:PoolClient,run:BibleRun,records:readonly ChunkRecord[]):Promise<BibleCandidate|null> {
    const rows=await client.query<{digest:string;candidate:unknown}>('SELECT digest,candidate FROM camery_bible.candidates WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',keys(run));
    if(!rows.rows[0])return null;
    try {
      const candidate=assembleBibleCandidate(asSourceInput(run.source),run.plan,records,run.method);const saved=rows.rows[0];
      if(saved.digest!==candidate.digest||canonical(saved.candidate)!==canonical(candidate))throw new Error();return candidate;
    } catch {throw new BibleError('STORAGE_FAILED','stored candidate');}
  }
  private async review(client:PoolClient,run:BibleRun,candidate:BibleCandidate|null):Promise<ConfirmedBible|RejectedBible|null> {
    const rows=await client.query<StoredReview>('SELECT status,request_digest,digest,record FROM camery_bible.reviews WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',keys(run));
    if(!rows.rows[0])return null;
    try {
      if(!candidate)throw new Error();const row=rows.rows[0];const raw=copy(row.record) as Record<string,unknown>;
      const host={actor:{kind:'human' as const,id:raw['actorId'] as string},tenantId:run.tenantId,projectId:run.projectId,at:raw['at'] as string,authorize:()=>true};
      // This rebuild checks an immutable audit record; it grants no present-day permission to a caller.
      const record=row.status==='confirmed'?confirmBible(asSourceInput(run.source),candidate,raw['decision'],host):row.status==='rejected'?rejectBibleCandidate(asSourceInput(run.source),candidate,raw['reason'],host):null;
      if(!record||canonical(raw)!==canonical(record)||record.digest!==row.digest||reviewDigest(record)!==row.request_digest)throw new Error();return record;
    } catch {throw new BibleError('STORAGE_FAILED','stored review');}
  }
  async start(input:unknown):Promise<BibleRun> {
    const command=freeze(parse(StartRunSchema,copy(input),'start run'));parse(Method,command.method,'method');const key=scope({tenantId:command.tenantId,projectId:command.projectId,runId:command.runId});const requestDigest=startDigest(command);
    return this.transaction(key,async client=>{
      const existing=await this.run(client,key);
      if(existing){if(startDigest({documentId:existing.source.source.documentId,kind:existing.source.source.kind,expectedRevision:existing.source.source.revision,expectedSourceDigest:existing.source.source.sourceDigest,method:existing.method,execution:existing.execution,chunkLimits:{maxCharacters:existing.plan.maxCharacters,maxBytes:existing.plan.maxBytes}})!==requestDigest)throw new BibleError('CONFLICT','run identity');return existing;}
      const loaded=await readSourceDocument(client,{tenantId:key.tenantId,projectId:key.projectId,documentId:command.documentId,kind:command.kind});
      if(loaded.revision!==command.expectedRevision||loaded.document.sourceDigest!==command.expectedSourceDigest)throw new BibleError('CONFLICT','source revision');
      const source=captureSource({tenantId:key.tenantId,projectId:key.projectId,documentId:command.documentId,kind:command.kind,...loaded});
      const plan=createChunkPlan(asSourceInput(source),{maxCharacters:command.chunkLimits?.maxCharacters??12000,maxBytes:command.chunkLimits?.maxBytes??48000});const execution=executionForChunks(command.execution,plan.chunks.length);const digest=bibleRunDigest(plan,command.method,execution);
      const inserted=await client.query<StoredRun>('INSERT INTO camery_bible.runs(tenant_id,project_id,run_id,document_id,source_kind,source,plan,method,execution,digest,request_digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11) RETURNING '+fields,
        [...keys(key),command.documentId,command.kind,JSON.stringify(snapshotJson(source,134217728,100001)),canonical(plan),canonical(command.method),canonical(execution),digest,requestDigest]);
      if(!inserted.rows[0])throw new BibleError('STORAGE_FAILED','inserted run');return decodeRun(inserted.rows[0],key);
    },command);
  }
  async read(input:BibleRunKey):Promise<BibleProgress> {
    const key=scope(input);return this.transaction(key,async client=>{const run=await this.requiredRun(client,key);const records=await this.records(client,run);const candidate=await this.candidate(client,run,records);const review=await this.review(client,run,candidate);return freeze({run,records,candidate,review});});
  }
  /** Caller owns the open READ COMMITTED transaction. Hold original source/run locks through its final write. */
  async readForOutline(client:PoolClient,input:unknown):Promise<BibleProgress>{
    const command=freeze(parse(BibleReviewedSourceSchema,copy(input),'reviewed source'));const key=scope({tenantId:command.tenantId,projectId:command.projectId,runId:command.runId});
    try{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_ingest',key.tenantId,key.projectId,command.documentId])]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_bible',...keys(key)])]);
      const run=await this.requiredRun(client,key);const identity=run.source.source;
      if(run.digest!==command.runDigest||identity.documentId!==command.documentId||identity.revision!==command.revision||identity.sourceDigest!==command.sourceDigest)throw new BibleError('CONFLICT','reviewed source binding');
      const records=await this.records(client,run),candidate=await this.candidate(client,run,records),review=await this.review(client,run,candidate);
      if(review?.status!=='confirmed')throw new BibleError('INCOMPLETE','source confirmation');
      if(review.digest!==command.reviewDigest)throw new BibleError('CONFLICT','source confirmation binding');
      const loaded=await readSourceDocument(client,{tenantId:key.tenantId,projectId:key.projectId,documentId:identity.documentId,kind:identity.kind});
      const current=captureSource({...asSourceInput(run.source),...loaded});
      if(canonical(current.source)!==canonical(identity))throw new BibleError('CONFLICT','current reviewed source');
      return freeze({run,records,candidate,review});
    }catch(error){if(error instanceof BibleError)throw error;if(error instanceof ImportError&&error.code==='NOT_FOUND')throw new BibleError('NOT_FOUND','reviewed source');throw new BibleError('STORAGE_FAILED','reviewed source read');}
  }
  async saveChunk(input:BibleRunKey,supplied:ChunkRecord):Promise<ChunkRecord> {
    const key=scope(input);const captured=copy(supplied);parse(z.object({digest:Hash}),captured,'chunk digest');
    return this.transaction(key,async client=>{const run=await this.requiredRun(client,key);const record=recordFor(run,captured);const records=await this.records(client,run);const existing=records.find(value=>value.chunkId===record.chunkId);
      if(existing){if(canonical(existing)!==canonical(record))throw new BibleError('CONFLICT','chunk identity');return existing;}
      const all=[...records,record];const counts=all.reduce((sum,value)=>({entities:sum.entities+value.output.entities.length,relations:sum.relations+value.output.relations.length,claims:sum.claims+value.output.claims.length}),{entities:0,relations:0,claims:0});
      canonical(all);if(counts.entities>4096||counts.relations>8192||counts.claims>8192)throw new BibleError('INPUT_LIMIT','stored chunk total');
      await client.query('INSERT INTO camery_bible.chunks(tenant_id,project_id,run_id,chunk_id,digest,record) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[...keys(key),record.chunkId,record.digest,canonical(record)]);return record;
    });
  }
  async materialize(input:BibleRunKey):Promise<BibleCandidate> {
    const key=scope(input);return this.transaction(key,async client=>{const run=await this.requiredRun(client,key);const records=await this.records(client,run);const existing=await this.candidate(client,run,records);if(existing)return existing;
      const candidate=assembleBibleCandidate(asSourceInput(run.source),run.plan,records,run.method);await client.query('INSERT INTO camery_bible.candidates(tenant_id,project_id,run_id,digest,candidate) VALUES($1,$2,$3,$4,$5::jsonb)',[...keys(key),candidate.digest,canonical(candidate)]);return candidate;});
  }
  async isCurrent(input:BibleRunKey):Promise<boolean> {
    const key=scope(input);const pinned=(await this.read(key)).run;
    return this.transaction(key,async client=>{const run=await this.requiredRun(client,key);try{const loaded=await readSourceDocument(client,{tenantId:key.tenantId,projectId:key.projectId,documentId:run.source.source.documentId,kind:run.source.source.kind});const current=captureSource({...asSourceInput(run.source),...loaded});return canonical(current.source)===canonical(run.source.source);}catch(error){if(error instanceof ImportError&&error.code==='NOT_FOUND')return false;throw error;}},pinned.source.source);
  }
  async confirm(input:BibleRunKey,decision:unknown,suppliedHost:ReviewHost):Promise<ConfirmedBible> {
    const key=scope(input);const captured=copy(decision);const host=captureHost(suppliedHost);const pinned=(await this.read(key)).run;
    return this.transaction(key,async client=>{const run=await this.requiredRun(client,key);const records=await this.records(client,run);const candidate=await this.candidate(client,run,records);if(!candidate)throw new BibleError('INCOMPLETE','review candidate');
      const proposed=confirmBible(asSourceInput(run.source),candidate,captured,host);const existing=await this.review(client,run,candidate);
      // An already accepted semantic retry only reads the old audit; source freshness is required for a new decision.
      if(existing){if(existing.status!=='confirmed'||reviewDigest(existing)!==reviewDigest(proposed))throw new BibleError('CONFLICT','review identity');return existing;}
      const loaded=await readSourceDocument(client,{tenantId:key.tenantId,projectId:key.projectId,documentId:run.source.source.documentId,kind:run.source.source.kind});const current=captureSource({...asSourceInput(run.source),...loaded});
      if(canonical(current.source)!==canonical(run.source.source))throw new BibleError('CONFLICT','current source');await this.insertReview(client,key,proposed);return proposed;
    },pinned.source.source);
  }
  async reject(input:BibleRunKey,reason:unknown,suppliedHost:ReviewHost):Promise<RejectedBible> {
    const key=scope(input);const captured=copy(reason);const host=captureHost(suppliedHost);
    return this.transaction(key,async client=>{const run=await this.requiredRun(client,key);const records=await this.records(client,run);const candidate=await this.candidate(client,run,records);if(!candidate)throw new BibleError('INCOMPLETE','review candidate');
      const proposed=rejectBibleCandidate(asSourceInput(run.source),candidate,captured,host);const existing=await this.review(client,run,candidate);
      if(existing){if(existing.status!=='rejected'||reviewDigest(existing)!==reviewDigest(proposed))throw new BibleError('CONFLICT','review identity');return existing;}
      await this.insertReview(client,key,proposed);return proposed;});
  }
  private async insertReview(client:PoolClient,key:BibleRunKey,record:ConfirmedBible|RejectedBible):Promise<void> {
    await client.query('INSERT INTO camery_bible.reviews(tenant_id,project_id,run_id,status,request_digest,digest,record) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[...keys(key),record.status,reviewDigest(record),record.digest,canonical(record)]);
  }
}
