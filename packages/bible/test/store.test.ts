import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { appendNovelBatch } from '@camery/ingest';
import { hash, textHash } from '../src/data.js';
import { reviewFixture } from './review-support.js';
import { PostgresBibleStore } from '../src/node/store.js';
import { migrateBible } from '../src/node/migrate.js';
import type { BibleRunKey, StartBibleRun } from '../src/node/contracts.js';
import type { ChunkOutput, ChunkRecord } from '../src/contracts.js';

const key:BibleRunKey={tenantId:'tenant',projectId:'project',runId:'research'};
const fx=reviewFixture();
const command:StartBibleRun={...key,documentId:fx.source.documentId,kind:'novel',expectedRevision:1,expectedSourceDigest:fx.source.document.sourceDigest,
  method:fx.candidate.method,chunkLimits:{maxCharacters:22,maxBytes:88},execution:{connectionId:'fixture',modeDigest:hash('fixture-mode'),modelIdentity:'fixture-model',
    evidence:'synthetic_replay',modelTier:'economy',currency:'CNY',reservation:{tokens:10,costMicros:0},limits:{steps:10,tokens:100,costMicros:0}}};
type Row=Record<string,unknown>;
function database(options:{connectFailure?:boolean;fail?:string[];migrations?:Row[];emptyInsert?:boolean}={}){
  const data:{runs:Row[];chunks:Row[];candidates:Row[];reviews:Row[];snapshot:unknown}={runs:[],chunks:[],candidates:[],reviews:[],
    snapshot:appendNovelBatch(undefined,{tenantId:'tenant',projectId:'project',documentId:'book',batchId:'first',expectedRevision:0,text:fx.source.document.text}).snapshot};
  const release=vi.fn(); const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    if(options.fail?.some(prefix=>sql.startsWith(prefix)))throw new Error('private-driver-secret');
    if(sql.startsWith('SELECT snapshot'))return {rows:data.snapshot===null?[]:[{snapshot:data.snapshot,revision:String((data.snapshot as {revision:number}).revision)}]};
    if(sql.startsWith('SELECT version'))return {rows:options.migrations??[]};
    if(sql.includes('FROM camery_bible.runs'))return {rows:data.runs.filter(row=>row.tenant_id===values[0]&&row.project_id===values[1]&&row.run_id===values[2])};
    if(sql.includes('FROM camery_bible.chunks'))return {rows:data.chunks};
    if(sql.includes('FROM camery_bible.candidates'))return {rows:data.candidates};
    if(sql.includes('FROM camery_bible.reviews'))return {rows:data.reviews};
    if(sql.startsWith('INSERT INTO camery_bible.runs')){
      const row={tenant_id:values[0],project_id:values[1],run_id:values[2],document_id:values[3],source_kind:values[4],source:JSON.parse(values[5] as string),plan:JSON.parse(values[6] as string),method:JSON.parse(values[7] as string),execution:JSON.parse(values[8] as string),digest:values[9],request_digest:values[10],created_at:new Date('2026-11-16T10:00:00.000Z')};data.runs.push(row);return {rows:options.emptyInsert?[]:[row]};
    }
    if(sql.startsWith('INSERT INTO camery_bible.chunks'))data.chunks.push({chunk_id:values[3],digest:values[4],record:JSON.parse(values[5] as string)});
    if(sql.startsWith('INSERT INTO camery_bible.candidates'))data.candidates.push({digest:values[3],candidate:JSON.parse(values[4] as string)});
    if(sql.startsWith('INSERT INTO camery_bible.reviews'))data.reviews.push({status:values[3],request_digest:values[4],digest:values[5],record:JSON.parse(values[6] as string)});
    return {rows:[]};
  });
  const connect=vi.fn(async()=>{if(options.connectFailure)throw new Error('private-url');return {query,release};});
  const pool={connect} as unknown as Pool;return {store:new PostgresBibleStore(pool),pool,query,connect,release,data,options};
}
async function complete(db:ReturnType<typeof database>){await db.store.start(command);for(const record of fx.candidate.records)await db.store.saveChunk(key,record);return db.store.materialize(key);}
it('pins an actual source and immutable execution plan, and idempotently keeps the initial creation time',async()=>{
  const db=database(); const first=await db.store.start(command);expect(first.source.document).toEqual(fx.source.document);expect(first.createdAt).toBe('2026-11-16T10:00:00.000Z');
  db.data.snapshot=appendNovelBatch(db.data.snapshot as never,{tenantId:'tenant',projectId:'project',documentId:'book',batchId:'next',expectedRevision:1,text:'追加内容'}).snapshot;
  expect(await db.store.start(command)).toEqual(first);expect(await db.store.isCurrent(key)).toBe(false);expect(db.data.runs).toHaveLength(1);
  await expect(db.store.start({...command,execution:{...command.execution,reservation:{tokens:11,costMicros:0}}})).rejects.toMatchObject({code:'CONFLICT'});
});
it('persists exact chunks once, materializes a complete candidate, and reconstructs stored values',async()=>{
  const db=database();await db.store.start(command);await expect(db.store.materialize(key)).rejects.toMatchObject({code:'INCOMPLETE'});
  await db.store.saveChunk(key,fx.candidate.records[0]!);expect((await db.store.read(key)).candidate).toBeNull();
  for(const record of fx.candidate.records){expect(await db.store.saveChunk(key,record)).toEqual(record);}
  expect(db.data.chunks).toHaveLength(fx.candidate.records.length);expect(await db.store.materialize(key)).toEqual(fx.candidate);expect(await db.store.materialize(key)).toEqual(fx.candidate);
  expect((await db.store.read(key)).candidate).toEqual(fx.candidate);expect(db.data.candidates).toHaveLength(1);expect(await db.store.isCurrent(key)).toBe(true);
});
it('captures inputs before the first connection await and rejects altered records',async()=>{
  const db=database(); const input=structuredClone(command);const waiting=db.store.start(input);input.execution.connectionId='other';expect((await waiting).execution.connectionId).toBe('fixture');
  const record=structuredClone(fx.candidate.records[0]!);const save=db.store.saveChunk(key,record);record.output.entities[0]!.name='late mutation';expect((await save).output.entities[0]!.name).toBe('小林');
  const changed=structuredClone(fx.candidate.records[0]!);changed.model.providerRequestId='other';const {digest:_digest,...body}=changed;Object.assign(changed,{digest:hash(body)});
  await expect(db.store.saveChunk(key,changed)).rejects.toMatchObject({code:'CONFLICT'});
  const wrong=structuredClone(changed);wrong.model.connectionId='other';const {digest:_old,...rest}=wrong;Object.assign(wrong,{digest:hash(rest)});
  await expect(db.store.saveChunk(key,wrong)).rejects.toMatchObject({code:'INVALID_EVIDENCE'});
});
it('saves first human review and treats same authorized semantic retry as an audit read',async()=>{
  const db=database();await complete(db);const authorize=vi.fn(()=>true);const host={...fx.host,authorize};const first=await db.store.confirm(key,fx.decision,host);
  const reordered=structuredClone(fx.decision);reordered.groups.reverse();for(const group of reordered.groups)group.memberIds.reverse();
  db.data.snapshot=appendNovelBatch(db.data.snapshot as never,{tenantId:'tenant',projectId:'project',documentId:'book',batchId:'later',expectedRevision:1,text:'后文'}).snapshot;
  expect(await db.store.confirm(key,reordered,{...host,at:'2026-11-17T10:00:00.000Z'})).toEqual(first);expect(authorize).toHaveBeenCalledTimes(2);expect(db.data.reviews).toHaveLength(1);
  await expect(db.store.confirm(key,fx.decision,{...fx.host,authorize:()=>false})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(db.store.reject(key,'不同决定',fx.host)).rejects.toMatchObject({code:'CONFLICT'});expect((await db.store.read(key)).review).toEqual(first);
});
it('rejects first stale confirmation while allowing rejection of an outdated candidate',async()=>{
  const db=database();await complete(db);db.data.snapshot=appendNovelBatch(db.data.snapshot as never,{tenantId:'tenant',projectId:'project',documentId:'book',batchId:'later',expectedRevision:1,text:'后文'}).snapshot;
  await expect(db.store.confirm(key,fx.decision,fx.host)).rejects.toMatchObject({code:'CONFLICT'});
  const rejected=await db.store.reject(key,'来源已更新，重新研究。',fx.host);expect(rejected.status).toBe('rejected');
  expect(await db.store.reject(key,'来源已更新，重新研究。',{...fx.host,at:'2026-11-17T10:00:00.000Z'})).toEqual(rejected);expect((await db.store.read(key)).review).toEqual(rejected);
});
it('checks source and run lock order and never locks a source after a run-only operation',async()=>{
  const db=database();await complete(db);await db.store.confirm(key,fx.decision,fx.host);
  const locks=db.query.mock.calls.filter(([sql])=>sql.startsWith('SELECT pg_advisory')).map(([,values])=>JSON.parse(values![0] as string) as string[]);
  expect(locks.slice(0,2).map(v=>v[0])).toEqual(['camery_ingest','camery_bible']);
  for(let i=1;i<locks.length;i++)if(locks[i]![0]==='camery_ingest')expect(locks[i+1]![0]).toBe('camery_bible');
});
it('validates commands, current source identity and missing runs without leaking database data',async()=>{
  const db=database();for(const call of [()=>db.store.start(null),()=>db.store.read({...key,tenantId:'bad\n'}),()=>db.store.saveChunk(key,{} as never)])await expect(call()).rejects.toThrow();
  expect(db.connect).not.toHaveBeenCalled();await expect(db.store.read(key)).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(db.store.start({...command,expectedRevision:2})).rejects.toMatchObject({code:'CONFLICT'});db.data.snapshot=null;
  await expect(db.store.start(command)).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('reports null chunk inputs as a contextual domain error before opening any connection',async()=>{
  const db=database();await expect(db.store.saveChunk(key,null as never)).rejects.toMatchObject({code:'INVALID_INPUT',operation:'chunk digest'});expect(db.connect).not.toHaveBeenCalled();
});
it('applies default chunk limits, refuses malformed pins and checks the exact expected source digest',async()=>{
  const db=database();const {chunkLimits:_limits,...defaults}=command;const run=await db.store.start(defaults);expect(run.plan.maxCharacters).toBe(12000);expect(run.plan.maxBytes).toBe(48000);
  const changed=database();await expect(changed.store.start({...command,expectedSourceDigest:'0'.repeat(64)})).rejects.toMatchObject({code:'CONFLICT'});
  await expect(database().store.start({...command,method:{...command.method,id:'unregistered'}})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(database({emptyInsert:true}).store.start(command)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('fails closed on incomplete review, missing current sources and malformed human hosts',async()=>{
  const db=database();await db.store.start(command);await expect(db.store.confirm(key,fx.decision,fx.host)).rejects.toMatchObject({code:'INCOMPLETE'});await expect(db.store.reject(key,'重做',fx.host)).rejects.toMatchObject({code:'INCOMPLETE'});
  await expect(db.store.confirm(key,fx.decision,{...fx.host,actor:{kind:'agent',id:'research'}} as never)).rejects.toMatchObject({code:'FORBIDDEN'});
  db.data.snapshot=null;expect(await db.store.isCurrent(key)).toBe(false);db.data.snapshot={};await expect(db.store.isCurrent(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('does not replace a previous review with a different same-action decision or reviewer',async()=>{
  const db=database();await complete(db);await db.store.confirm(key,fx.decision,fx.host);const changed=structuredClone(fx.decision);changed.groups[0]!.name='另一个名字';
  await expect(db.store.confirm(key,changed,fx.host)).rejects.toMatchObject({code:'CONFLICT'});await expect(db.store.confirm(key,fx.decision,{...fx.host,actor:{kind:'human',id:'other'}})).rejects.toMatchObject({code:'CONFLICT'});
  const rejected=database();await complete(rejected);await rejected.store.reject(key,'旧原因',fx.host);await expect(rejected.store.reject(key,'不同原因',fx.host)).rejects.toMatchObject({code:'CONFLICT'});await expect(rejected.store.confirm(key,fx.decision,fx.host)).rejects.toMatchObject({code:'CONFLICT'});
});
it.each(['BEGIN','SELECT pg_advisory','SELECT tenant_id','SELECT snapshot','INSERT INTO camery_bible.runs','COMMIT'])('redacts %s failures and releases its transaction',async fail=>{
  const db=database({fail:[fail]});await expect(db.store.start(command)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.release).toHaveBeenCalledOnce();expect(db.query.mock.calls.some(([sql])=>sql==='ROLLBACK')).toBe(true);
});
it('redacts connection and rollback failures',async()=>{
  await expect(database({connectFailure:true}).store.start(command)).rejects.toThrow('STORAGE_FAILED');const db=database({fail:['BEGIN','ROLLBACK']});await expect(db.store.start(command)).rejects.toThrow('rollback');expect(db.release).toHaveBeenCalledOnce();
});
it('does not return corrupt stored scope, source, plan, execution, digests or creation times',async()=>{
  for(const patch of [{source:{}},{plan:{}},{method:{}},{execution:{}},{digest:'0'.repeat(64)},{request_digest:'0'.repeat(64)},{created_at:'bad'},{document_id:'other'},{source_kind:'script'}]){
    const db=database();await db.store.start(command);Object.assign(db.data.runs[0]!,patch);await expect(db.store.read(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  }
});
it('accepts canonical UTC dates from a driver that explicitly returns timestamp strings',async()=>{
  const db=database();const run=await db.store.start(command);db.data.runs[0]!.created_at=run.createdAt;expect((await db.store.read(key)).run.createdAt).toBe(run.createdAt);
});
it('does not trust corrupt chunk, candidate or review projections',async()=>{
  for(const corrupt of ['chunk','candidate','review','request'] as const){
    const db=database();await complete(db);await db.store.confirm(key,fx.decision,fx.host);
    if(corrupt==='chunk')db.data.chunks[0]!.digest='0'.repeat(64);
    if(corrupt==='candidate')db.data.candidates[0]!.candidate={};
    if(corrupt==='review')db.data.reviews[0]!.record={};
    if(corrupt==='request')db.data.reviews[0]!.request_digest='0'.repeat(64);
    await expect(db.store.read(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  }
});
it('rejects duplicate/excess chunk rows, mismatched row identities and orphaned or invalid review metadata',async()=>{
  for(const corrupt of ['excess','duplicate','identity','candidate-digest','orphan','review-status','review-digest'] as const){
    const db=database();await complete(db);await db.store.confirm(key,fx.decision,fx.host);
    if(corrupt==='excess')db.data.chunks.push(db.data.chunks[0]!);
    if(corrupt==='duplicate')db.data.chunks[1]=db.data.chunks[0]!;
    if(corrupt==='identity')db.data.chunks[0]!.chunk_id='other';
    if(corrupt==='candidate-digest')db.data.candidates[0]!.digest='0'.repeat(64);
    if(corrupt==='orphan')db.data.candidates=[];
    if(corrupt==='review-status')db.data.reviews[0]!.status='unknown';
    if(corrupt==='review-digest')db.data.reviews[0]!.digest='0'.repeat(64);
    await expect(db.store.read(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  }
});
it('captures the human identity, timestamp and decision before its first asynchronous database read',async()=>{
  const db=database();await complete(db);const decision=structuredClone(fx.decision);const host={...fx.host,actor:{...fx.host.actor}};
  const pending=db.store.confirm(key,decision,host);host.actor.id='changed';host.at='2026-11-17T10:00:00.000Z';decision.groups[0]!.name='changed';
  const review=await pending;expect(review.actorId).toBe('reviewer');expect(review.at).toBe(fx.host.at);expect(review.entities[0]!.name).not.toBe('changed');
});
async function largeFixture(kind:'entities'|'relations'|'claims',descriptionLength=1){
  const db=database();const initial=appendNovelBatch(undefined,{tenantId:'tenant',projectId:'project',documentId:'book',batchId:'first',expectedRevision:0,text:'甲'.repeat(1310)});db.data.snapshot=initial.snapshot;
  const run=await db.store.start({...command,expectedSourceDigest:initial.document.sourceDigest,chunkLimits:{maxCharacters:10,maxBytes:40},execution:{...command.execution,limits:{steps:200,tokens:2000,costMicros:0}}});
  const records:ChunkRecord[]=run.plan.chunks.map(chunk=>{
    const evidence=[{start:0,end:1,quote:'甲'}];const entities:ChunkOutput['entities']=[{id:'a',kind:'character',name:'a',aliases:[],description:'a',evidence},{id:'b',kind:'character',name:'b',aliases:[],description:'b',evidence}];
    const output:ChunkOutput={entities,relations:[],claims:[]};
    if(kind==='entities')output.entities=Array.from({length:32},(_,i)=>({...entities[0]!,id:'e'+i,description:'x'.repeat(descriptionLength)}));
    if(kind==='relations')output.relations=Array.from({length:64},(_,i)=>({id:'r'+i,from:'a',to:'b',label:'同行',evidence}));
    if(kind==='claims')output.claims=Array.from({length:64},(_,i)=>({id:'f'+i,kind:'fact',text:'原文事实候选',entityIds:[],evidence}));
    const model={...fx.candidate.records[0]!.model,callId:'call-'+chunk.id,outputDigest:hash(output)};const body={version:1 as const,planDigest:run.plan.digest,chunkId:chunk.id,method:run.method,output,model};return {...body,digest:hash(body)};
  });
  return {db,run,records};
}
it.each(['entities','relations','claims'] as const)('rejects the next chunk before stored aggregate %s exceeds its limit',async kind=>{
  const {db,records}=await largeFixture(kind);db.data.chunks=records.slice(0,128).map(record=>({chunk_id:record.chunkId,digest:record.digest,record}));
  await expect(db.store.saveChunk(key,records[128]!)).rejects.toMatchObject({code:'INPUT_LIMIT'});expect(db.data.chunks).toHaveLength(128);
});
it('rejects oversized stored raw records and stops new writes before the aggregate JSON limit',async()=>{
  const {db,records}=await largeFixture('entities',1000);let size=2;let count=0;
  while(size+Buffer.byteLength(JSON.stringify(records[count]))+1<=2097152){size+=Buffer.byteLength(JSON.stringify(records[count]))+1;count++;}
  db.data.chunks=records.slice(0,count).map(record=>({chunk_id:record.chunkId,digest:record.digest,record}));await expect(db.store.saveChunk(key,records[count]!)).rejects.toMatchObject({code:'INPUT_LIMIT'});
  db.data.chunks.push({chunk_id:records[count]!.chunkId,digest:records[count]!.digest,record:records[count]});await expect(db.store.read(key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('applies a checksum-verified explicit migration once and rejects changed history',async()=>{
  const db=database();await migrateBible(db.pool);const checksum=textHash(readFileSync(new URL('../src/node/migrations/0001-bible.sql',import.meta.url),'utf8'));
  const existing=database({migrations:[{version:1,checksum}]});await migrateBible(existing.pool);expect(existing.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO camery_bible.migrations'))).toBe(false);
  await expect(migrateBible(database({migrations:[{version:1,checksum:'bad'}]}).pool)).rejects.toMatchObject({code:'CONFLICT'});
  await expect(migrateBible(database({migrations:[{version:2,checksum}]}).pool)).rejects.toMatchObject({code:'CONFLICT'});
});
it.each(['BEGIN','SELECT pg_advisory','CREATE SCHEMA','SELECT version','CREATE TABLE camery_bible.runs','COMMIT'])('redacts migration %s failure',async fail=>{
  const db=database({fail:[fail]});await expect(migrateBible(db.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.release).toHaveBeenCalledOnce();
});
it('handles migration connection and rollback failures safely',async()=>{
  await expect(migrateBible(database({connectFailure:true}).pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(migrateBible(database({fail:['BEGIN','ROLLBACK']}).pool)).rejects.toThrow('rollback');
});
