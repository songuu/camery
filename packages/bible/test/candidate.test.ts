import { expect, it } from 'vitest';
import { importNovel } from '@camery/ingest';
import type { MethodPin, ModelReceipt } from '@camery/methods';
import { assembleBibleCandidate, validateBibleCandidate } from '../src/candidate.js';
import { createChunkPlan } from '../src/chunks.js';
import { captureSource, hash } from '../src/data.js';
import type { ChunkOutput, ChunkPlan, ChunkRecord, SourceInput } from '../src/contracts.js';

const method: MethodPin = { id: 'story-bible-extract', version: '1.0.0', digest: hash('story extraction fixture') };
function source(text = '小林和老周前往雾港。小林发现一封信。') : SourceInput {
  return { tenantId: 'tenant-a', projectId: 'project-a', documentId: 'novel-a', kind: 'novel', revision: 1, document: importNovel(text) };
}
function outputFor(input: SourceInput, plan: ChunkPlan, ordinal: number): ChunkOutput {
  const chunk = plan.chunks[ordinal]!; const text = input.document.text.slice(chunk.start, chunk.end);
  const quote = text.trim(); const start = text.indexOf(quote);
  const evidence = [{ start, end: start + quote.length, quote }];
  return { entities: [{ id: 'lin', kind: 'character', name: '小林', aliases: ['林先生'], description: '叙事中出现的人物。', evidence },
    { id: 'zhou', kind: 'character', name: '老周', aliases: [], description: '小林的同行者。', evidence }],
  relations: [{ id: 'accompany', from: 'lin', to: 'zhou', label: '同行', evidence }],
  claims: [{ id: 'letter', kind: 'foreshadowing', text: '出现一封待核对的信。', entityIds: ['lin'], evidence }] };
}
function record(plan: ChunkPlan, ordinal: number, output: ChunkOutput): ChunkRecord {
  const chunkId = plan.chunks[ordinal]!.id;
  const model: ModelReceipt = { tenantId: plan.source.tenantId, connectionId: 'test-model', modeDigest: hash('mode'), modelIdentity: 'fixture-model',
    evidence: 'synthetic_replay', callId: 'call-' + chunkId, providerRequestId: 'reply-' + chunkId, inputDigest: hash({ chunkId }),
    outputDigest: hash(output), usage: { inputTokens: 1, outputTokens: 1 } };
  const body = { version: 1 as const, planDigest: plan.digest, chunkId, method, output, model };
  return { ...body, digest: hash(body) };
}
function fixture(text?: string, maxCharacters = 12) {
  const input = source(text); const plan = createChunkPlan(input, { maxCharacters, maxBytes: maxCharacters * 4 });
  const records = plan.chunks.map((_, ordinal) => record(plan, ordinal, outputFor(input, plan, ordinal)));
  return { input, plan, records };
}

it('assembles a complete source-bound candidate with global references and absolute original ranges', () => {
  const { input, plan, records } = fixture(); const result = assembleBibleCandidate(input, plan, records, method);
  expect(result.status).toBe('candidate'); expect(result.records).toEqual(records);
  expect(result.entities).toHaveLength(plan.chunks.length * 2);
  for (const [ordinal, chunk] of plan.chunks.entries()) {
    const entity = result.entities[ordinal * 2]!; const relation = result.relations[ordinal]!; const claim = result.claims[ordinal]!;
    expect(entity.id).toBe(`${chunk.id}:e:lin`); expect(entity.chunkId).toBe(chunk.id);
    expect(relation.id).toBe(`${chunk.id}:r:accompany`); expect(relation.from).toBe(entity.id); expect(relation.to).toBe(`${chunk.id}:e:zhou`);
    expect(claim.id).toBe(`${chunk.id}:f:letter`); expect(claim.entityIds).toEqual([entity.id]);
    for (const evidence of [...entity.evidence, ...relation.evidence, ...claim.evidence]) {
      expect(evidence.start).toBeGreaterThanOrEqual(chunk.start); expect(evidence.end).toBeLessThanOrEqual(chunk.end);
      expect(input.document.text.slice(evidence.start, evidence.end)).toBe(evidence.quote);
    }
  }
  expect(validateBibleCandidate(captureSource(input), result)).toEqual(result);
});
it('preserves all ten chapters, repeated mentions and conflicting descriptions without adopting or silently merging', () => {
  const text = Array.from({ length: 10 }, (_, i) => `第${i + 1}章 雾港来信\n小林与老周核对信件。\n`).join('');
  const { input, plan, records } = fixture(text, 28);
  const contradictory = records.map((entry, i) => {
    const output = structuredClone(entry.output); output.entities[0]!.description = i % 2 ? '他没有见过信。' : '他曾经见过信。'; return record(plan, i, output);
  });
  const result = assembleBibleCandidate(input, plan, contradictory, method);
  expect(plan.chunks.length).toBeGreaterThanOrEqual(10); expect(result.entities).toHaveLength(plan.chunks.length * 2);
  expect(new Set(result.entities.filter(e => e.name === '小林').map(e => e.description)).size).toBe(2);
  expect(result.mergeSuggestions).toHaveLength(2); expect(result.mergeSuggestions[0]!.entityIds).toHaveLength(plan.chunks.length);
  expect(result.status).toBe('candidate'); expect('head' in result).toBe(false);
});
it('orders chunk results by the plan so arrival order cannot change candidate identity', () => {
  const { input, plan, records } = fixture();
  expect(assembleBibleCandidate(input, plan, [...records].reverse(), { ...method })).toEqual(assembleBibleCandidate(input, plan, records, method));
});
it('suggests transitive name/alias overlaps within a kind using NFC and whitespace normalization only', () => {
  const { input, plan } = fixture('甲乙丙丁戊己庚辛壬癸', 10); const base = outputFor(input, plan, 0); const evidence = base.entities[0]!.evidence;
  const output: ChunkOutput = { entities: [
    { id: 'one', kind: 'character', name: '  小林  ', aliases: ['林\t先生'], description: '甲', evidence },
    { id: 'two', kind: 'character', name: '林  先生', aliases: ['Cafe\u0301'], description: '乙', evidence },
    { id: 'three', kind: 'character', name: 'Café', aliases: [], description: '丙', evidence },
    { id: 'place', kind: 'place', name: '小林', aliases: [], description: '同名地点', evidence },
    { id: 'lower', kind: 'character', name: 'café', aliases: [], description: '大小写身份不猜测', evidence },
  ], relations: [], claims: [] };
  const candidate = assembleBibleCandidate(input, plan, [record(plan, 0, output)], method);
  expect(candidate.entities).toHaveLength(5); expect(candidate.mergeSuggestions).toEqual([{ entityIds: ['one','two','three'].map(id => `${plan.chunks[0]!.id}:e:${id}`), reason: 'name_or_alias_overlap' }]);
  expect(candidate.entities[0]!.name).toBe('  小林  ');
});
it('never suggests a singleton or alters independent same-kind identities', () => {
  const { input, plan } = fixture('甲乙丙丁戊己庚辛壬癸', 10); const output = outputFor(input, plan, 0);
  const candidate = assembleBibleCandidate(input, plan, [record(plan, 0, output)], method);
  expect(candidate.mergeSuggestions).toEqual([]);
});
it('captures and deep-freezes all returned records, projections and suggestions without freezing caller values', () => {
  const { input, plan, records } = fixture(); const mutable = structuredClone(records); const before = structuredClone(mutable);
  const candidate = assembleBibleCandidate(input, plan, mutable, method);
  expect(mutable).toEqual(before); expect(Object.isFrozen(mutable)).toBe(false);
  mutable[0]!.output.entities[0]!.name = 'changed'; expect(candidate.records[0]!.output.entities[0]!.name).toBe('小林');
  expect(Object.isFrozen(candidate.entities[0]!.evidence[0])).toBe(true); expect(Object.isFrozen(candidate.mergeSuggestions[0]!.entityIds)).toBe(true);
});
it.each(['missing','duplicate','unknown'] as const)('rejects %s chunks instead of returning a partial candidate', kind => {
  const { input, plan, records } = fixture(); const values = [...records];
  if (kind === 'missing') values.pop();
  else if (kind === 'duplicate') values[1] = values[0]!;
  else values[0] = { ...values[0]!, chunkId: 'not-in-plan' };
  expect(() => assembleBibleCandidate(input, plan, values, method)).toThrow();
});
it.each(['method','tenant','source','plan','evidence','record-digest'] as const)('rejects mismatched %s bindings', kind => {
  const { input, plan, records } = fixture(); const values = structuredClone(records); let selectedMethod = method; let selectedSource = input; let selectedPlan = plan;
  if (kind === 'method') selectedMethod = { ...method, digest: hash('different method') };
  if (kind === 'tenant') values[0]!.model.tenantId = 'other';
  if (kind === 'source') selectedSource = { ...input, revision: 2 };
  if (kind === 'plan') selectedPlan = { ...plan, digest: hash('different plan') };
  if (kind === 'evidence') values[0]!.output.entities[0]!.evidence[0]!.quote = '伪造原文';
  if (kind === 'record-digest') values[0] = { ...values[0]!, digest: hash('different result') };
  expect(() => assembleBibleCandidate(selectedSource, selectedPlan, values, selectedMethod)).toThrow();
});
it.each(['digest','projection','suggestion','status','extra','plan-extra','records-extra','scope-header'] as const)('rebuilds rather than trusting self-reported candidate %s', kind => {
  const { input, plan, records } = fixture(); const candidate = structuredClone(assembleBibleCandidate(input, plan, records, method));
  const data = candidate as unknown as Record<string, unknown>; const snapshot = structuredClone(captureSource(input));
  if (kind === 'digest') data['digest'] = hash('different');
  if (kind === 'projection') candidate.entities[0]!.evidence[0]!.start++;
  if (kind === 'suggestion') data['mergeSuggestions'] = [];
  if (kind === 'status') data['status'] = 'confirmed';
  if (kind === 'extra') data['approved'] = true;
  if (kind === 'plan-extra') (data['plan'] as Record<string, unknown>)['approved'] = true;
  if (kind === 'records-extra') (candidate.records[0] as unknown as Record<string, unknown>)['approved'] = true;
  if (kind === 'scope-header') snapshot.source.sourceDigest = hash('forged header');
  expect(() => validateBibleCandidate(snapshot, candidate)).toThrow();
});
it('rejects forged derived entities even after an attacker recomputes the candidate digest', () => {
  const { input, plan, records } = fixture(); const candidate = structuredClone(assembleBibleCandidate(input, plan, records, method));
  candidate.entities[0]!.name = '模型从未输出的人物';
  const { digest: _oldDigest, ...body } = candidate;
  expect(() => validateBibleCandidate(captureSource(input), { ...body, digest: hash(body) })).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
});
it.each(['entities','relations','claims'] as const)('bounds aggregate %s before constructing oversized projections', kind => {
  const input = source('甲'.repeat(1290)); const plan = createChunkPlan(input, { maxCharacters: 10, maxBytes: 40 });
  const records = plan.chunks.map((_, i) => {
    const base = outputFor(input, plan, i); const evidence = base.entities[0]!.evidence;
    if (kind === 'entities') base.entities = Array.from({ length: 32 }, (_, j) => ({ ...base.entities[0]!, id: 'entity-' + j, name: '人物' + j }));
    else if (kind === 'relations') base.relations = Array.from({ length: 64 }, (_, j) => ({ ...base.relations[0]!, id: 'relation-' + j }));
    else base.claims = Array.from({ length: 64 }, (_, j) => ({ ...base.claims[0]!, id: 'claim-' + j }));
    if (kind === 'entities') { base.relations = []; base.claims = []; }
    expect(evidence[0]!.quote).toBe('甲'.repeat(10)); return record(plan, i, base);
  });
  expect(() => assembleBibleCandidate(input, plan, records, method)).toThrowError(expect.objectContaining({ code: 'INPUT_LIMIT' }));
});
it('bounds the complete canonical candidate including both raw and projected descriptions', () => {
  const input = source('甲'.repeat(400)); const plan = createChunkPlan(input, { maxCharacters: 10, maxBytes: 40 });
  const records = plan.chunks.map((_, i) => {
    const base = outputFor(input, plan, i); base.entities = Array.from({ length: 32 }, (_, j) => ({ ...base.entities[0]!, id: 'entity-' + j, description: 'x'.repeat(1000) }));
    base.relations = []; base.claims = []; return record(plan, i, base);
  });
  expect(() => assembleBibleCandidate(input, plan, records, method)).toThrowError(expect.objectContaining({ code: 'INPUT_LIMIT' }));
});
it('stops inspecting later records as soon as cumulative raw input exceeds two MiB', () => {
  const input = source('甲'.repeat(800)); const plan = createChunkPlan(input, { maxCharacters: 10, maxBytes: 40 });
  const records = plan.chunks.map((_, i) => {
    const base = outputFor(input, plan, i); base.entities = Array.from({ length: 32 }, (_, j) => ({ ...base.entities[0]!, id: 'entity-' + j, description: 'x'.repeat(1000) }));
    base.relations = []; base.claims = []; return record(plan, i, base);
  });
  let inspectedTail = false;
  records[records.length - 1] = new Proxy(records.at(-1)!, { ownKeys(target) { inspectedTail = true; return Reflect.ownKeys(target); } });
  expect(() => assembleBibleCandidate(input, plan, records, method)).toThrowError(expect.objectContaining({ code: 'INPUT_LIMIT' }));
  expect(inspectedTail).toBe(false);
});
it('rejects non-JSON record graphs with a fixed error rather than recursing or leaking host exceptions', () => {
  const { input, plan, records } = fixture(); const values: unknown[] = [...records];
  const cyclic: { loop?: unknown } = {}; cyclic.loop = cyclic; values[0] = cyclic;
  expect(() => assembleBibleCandidate(input, plan, values as ChunkRecord[], method)).toThrowError(expect.objectContaining({ code: 'INPUT_LIMIT', operation: 'candidate input bytes' }));
});
it('rejects an excessive top-level record array before Zod reads any entry',()=>{
  const {input,plan,records}=fixture();let reads=0;const excessive=Array(4097).fill(records[0]);
  Object.defineProperty(excessive,'0',{enumerable:true,configurable:true,get(){reads++;return records[0];}});
  expect(()=>assembleBibleCandidate(input,plan,excessive,method)).toThrow();expect(reads).toBe(0);
});
it.each(['entities','relations','claims'] as const)('stops inspecting later records once the aggregate %s limit is exceeded', kind => {
  const input = source('甲'.repeat(1310)); const plan = createChunkPlan(input, { maxCharacters: 10, maxBytes: 40 });
  const records = plan.chunks.map((_, i) => {
    const evidence = [{ start: 0, end: 1, quote: '甲' }];
    const entities: ChunkOutput['entities'] = [
      { id: 'a', kind: 'character', name: 'a', aliases: [], description: 'a', evidence },
      { id: 'b', kind: 'character', name: 'b', aliases: [], description: 'b', evidence },
    ];
    const output: ChunkOutput = { entities, relations: [], claims: [] };
    if (kind === 'entities') output.entities = Array.from({ length: 32 }, (_, j) => ({ ...entities[0]!, id: 'e' + j }));
    if (kind === 'relations') output.relations = Array.from({ length: 64 }, (_, j) => ({ id: 'r' + j, from: 'a', to: 'b', label: 'a', evidence }));
    if (kind === 'claims') output.claims = Array.from({ length: 64 }, (_, j) => ({ id: 'f' + j, kind: 'fact', text: 'a', entityIds: [], evidence }));
    return record(plan, i, output);
  });
  let inspectedTail = false;
  records[records.length - 1] = new Proxy(records.at(-1)!, { ownKeys(target) { inspectedTail = true; return Reflect.ownKeys(target); } });
  expect(() => assembleBibleCandidate(input, plan, records, method)).toThrowError(expect.objectContaining({ code: 'INPUT_LIMIT' }));
  expect(inspectedTail).toBe(false);
});
