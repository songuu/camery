import { describe, expect, it } from 'vitest';
import type { ChangeOp, ChangeSet, StoryboardPackage } from '@camery/ir';
import { adoptChangeSet, createVersionState, submitChangeSet } from '../src/index';
import type { AdoptOptions } from '../src/types';
import { changeSet, deepFreeze, fixtureId as id, makePackage, mutate, row } from '../../ir/test/fixtures';

const approval = (): AdoptOptions => ({ actor: { kind: 'user', id: id('user_1') }, scope: { kind: 'project', id: id('prj_demo') }, at: '2026-11-10T00:00:00.000Z', authorize: () => true });
const update = (set: Record<string, unknown> = { action: '新动作' }): ChangeSet => {
  const request = changeSet([
    { op: 'update', op_id: id('op_1'), collection: 'shots', target: id('sh_1'), set: {} },
  ], { base_revisions: [{ id: id('sh_1'), version: 1 }] });
  // Preserve malformed JavaScript values for the boundary test instead of JSON-normalizing them in the fixture helper.
  const operation = request.ops[0]!;
  if (operation.op === 'update') operation.set = set;
  return request;
};
const codes = (result: ReturnType<typeof submitChangeSet>) => result.issues.map(issue => issue.code);

describe('ChangeSet data boundary and atomic rejection', () => {
  it.each([null, [], 4, 'request', { schema_version: '0.5.0-draft' }])('rejects malformed request %j without creating history', input => {
    const state = deepFreeze(createVersionState(makePackage()));
    const result = submitChangeSet(state, input);
    expect(result.status).toBe('rejected');
    expect(codes(result)).toContain('SCHEMA');
    expect(result.state).toBe(state);
    expect(result.state.changes).toEqual([]);
  });

  it.each([
    ['NaN', NaN], ['Infinity', Infinity], ['negative Infinity', -Infinity], ['undefined', undefined],
    ['function', () => 'side effect'], ['BigInt', 2n], ['symbol', Symbol('x')],
    ['Date', new Date('2026-11-10T00:00:00.000Z')], ['Map', new Map()], ['boxed number', new Number(1)],
  ])('rejects non-JSON %s values before schema/application', (_label, value) => {
    const state = deepFreeze(createVersionState(makePackage()));
    const result = submitChangeSet(state, update({ action: value }));
    expect(codes(result)).toContain('NON_JSON');
    expect(result.state).toBe(state);
    expect(result.state.changes).toEqual([]);
  });

  it('rejects a cyclic graph without throwing or modifying the adopted head', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const state = deepFreeze(createVersionState(makePackage()));
    const result = submitChangeSet(state, update({ cycle }));
    expect(codes(result)).toContain('NON_JSON');
    expect(result.state).toBe(state);
  });

  it.each(['__proto__', 'prototype', 'constructor'])('rejects own prototype-related key %s', key => {
    const unsafe: unknown = JSON.parse(`{"${key}":{"polluted":true}}`);
    const state = deepFreeze(createVersionState(makePackage()));
    const result = submitChangeSet(state, update({ nested: unsafe }));
    expect(codes(result)).toContain('UNSAFE_FIELD');
    expect(result.state).toBe(state);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('supports JSON null-prototype records without treating their missing prototype as an attack', () => {
    const set: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    set.action = '新动作';
    const state = createVersionState(makePackage());
    expect(submitChangeSet(state, update(set)).status).toBe('candidate');
  });

  it('does not create a second candidate for equivalent JSON property ordering', () => {
    const state = createVersionState(makePackage());
    const first = submitChangeSet(state, update({ action: '动作', visual_purpose: '目的' }));
    const repeated = submitChangeSet(first.state, update({ visual_purpose: '目的', action: '动作' }));
    expect(repeated.status).toBe('candidate');
    expect(repeated.state.changes).toHaveLength(1);
    expect(repeated.state.head).toEqual(state.head);
  });

  it('does not let a ChangeSet reuse an active content object identity', () => {
    const state = createVersionState(makePackage());
    const request = update();
    request.id = id('sh_1');
    const result = submitChangeSet(state, request);
    expect(result.status).toBe('rejected');
    expect(codes(result)).toContain('ID_REUSE');
    expect(result.state.head).toEqual(state.head);
  });

  it.each([
    ['FUTURE_BASE', (request: ChangeSet) => { request.base_revision = 6; }],
    ['CHANGE_STATE', (request: ChangeSet) => { request.status = 'adopted'; }],
    ['DUPLICATE_BASE', (request: ChangeSet) => { request.base_revisions.push({ id: id('sh_1'), version: 1 }); }],
    ['DUPLICATE_OP', (request: ChangeSet) => { request.ops.push({ op: 'update', op_id: id('op_1'), collection: 'shots', target: id('sh_1'), set: { action: '第二步' } }); }],
    ['BASE_REQUIRED', (request: ChangeSet) => { request.base_revisions = []; }],
    ['IMMUTABLE_IDENTITY', (request: ChangeSet) => { request.ops[0] = { op: 'update', op_id: id('op_1'), collection: 'shots', target: id('sh_1'), set: { id: id('new-identity') } }; }],
    ['IMMUTABLE_IDENTITY', (request: ChangeSet) => { request.ops[0] = { op: 'update', op_id: id('op_1'), collection: 'shots', target: id('sh_1'), set: { version: 9 } }; }],
  ] as const)('reports %s for a validly shaped but invalid transaction', (code, edit) => {
    const state = deepFreeze(createVersionState(makePackage()));
    const request = update();
    edit(request);
    const result = submitChangeSet(state, request);
    expect(result.status).toBe('rejected');
    expect(codes(result)).toContain(code);
    expect(result.state.head).toEqual(state.head);
    expect(result.state.changes[0]?.preview).toBeNull();
  });

  it('conflicts on an explicit base read of a missing object even if that object is not written', () => {
    const request = update();
    request.base_revisions.push({ id: id('missing'), version: 1 });
    const result = submitChangeSet(createVersionState(makePackage()), request);
    expect(result.status).toBe('conflicted');
    expect(codes(result)).toContain('REVISION_CONFLICT');
  });

  it('bumps each changed object once for multiple writes in the same candidate', () => {
    const request = update({ action: '第一步' });
    request.ops.push({ op: 'update', op_id: id('op_2'), collection: 'shots', target: id('sh_1'), set: { action: '第二步' } });
    const result = submitChangeSet(createVersionState(makePackage()), request);
    expect(result.status).toBe('candidate');
    expect(row(result.state.changes[0]!.preview!.shots, 'sh_1')).toMatchObject({ version: 2, action: '第二步' });
  });

  it('rejects unknown fields after application and rolls back earlier valid writes', () => {
    const request = update();
    request.ops.push({ op: 'update', op_id: id('op_2'), collection: 'shots', target: id('sh_1'), set: { invented: true } });
    const state = createVersionState(makePackage());
    const result = submitChangeSet(state, request);
    expect(codes(result)).toContain('SCHEMA');
    expect(result.state.changes[0]!.preview).toBeNull();
    expect(row(result.state.head.shots, 'sh_1').action).toBe(row(state.head.shots, 'sh_1').action);
  });

  it('rejects revision overflow instead of rounding or wrapping version counters', () => {
    const pkg = mutate(makePackage(), p => { row(p.shots, 'sh_1').version = Number.MAX_SAFE_INTEGER; });
    const request = update();
    request.base_revisions = [{ id: id('sh_1'), version: Number.MAX_SAFE_INTEGER }];
    const result = submitChangeSet(createVersionState(pkg), request);
    expect(codes(result)).toContain('VERSION_OVERFLOW');
    expect(result.state.head).toEqual(pkg);
  });

  it('rejects head revision overflow independently of object counters', () => {
    const pkg = mutate(makePackage(), p => { p.revision.number = Number.MAX_SAFE_INTEGER; });
    expect(codes(submitChangeSet(createVersionState(pkg), update()))).toContain('VERSION_OVERFLOW');
  });
});

describe('object editing operations', () => {
  const panelDraft = (pkg: StoryboardPackage, alias = 'new-panel') => ({ ...structuredClone(row(pkg.panels, 'p_key')), id: id(alias), version: 1 });

  it('adds a new version-one panel without inventing an old object revision', () => {
    const pkg = makePackage();
    const request = changeSet([{ op: 'add', op_id: id('op_1'), collection: 'panels', value: panelDraft(pkg) }]);
    const proposed = submitChangeSet(createVersionState(pkg), request);
    expect(proposed.status).toBe('candidate');
    const adopted = adoptChangeSet(proposed.state, id('cs_test'), approval());
    expect(row(adopted.state.head.panels, 'new-panel').version).toBe(1);
    expect(adopted.state.revisions.find(revision => revision.object_id === id('new-panel'))).toMatchObject({ version: 1, parent_version: null });
  });

  it.each([
    ['IDENTIFIER', { id: 'invalid-id', version: 1 }],
    ['ID_REUSE', { id: id('sh_1'), version: 1 }],
    ['ID_REUSE', { id: id('spot_desk'), version: 1 }],
    ['INITIAL_VERSION', { id: id('new-panel'), version: 2 }],
    ['SCHEMA', { id: id('new-panel'), version: 1, position: 'invalid' }],
  ])('rejects invalid additions: %s', (code, overrides) => {
    const pkg = makePackage();
    const request = changeSet([{ op: 'add', op_id: id('op_1'), collection: 'panels', value: { ...panelDraft(pkg), ...overrides } }]);
    expect(codes(submitChangeSet(createVersionState(pkg), request))).toContain(code);
  });

  it('replaces a complete object while preserving its identity and incrementing its revision', () => {
    const pkg = makePackage();
    const replacement = { ...structuredClone(row(pkg.shots, 'sh_1')), action: '替换动作' };
    const request = changeSet([{ op: 'replace', op_id: id('op_1'), collection: 'shots', target: id('sh_1'), value: replacement }], { base_revisions: [{ id: id('sh_1'), version: 1 }] });
    const result = submitChangeSet(createVersionState(pkg), request);
    expect(result.status).toBe('candidate');
    expect(row(result.state.changes[0]!.preview!.shots, 'sh_1')).toMatchObject({ id: id('sh_1'), version: 2, action: '替换动作' });
  });

  it.each([
    ['IMMUTABLE_IDENTITY', { action: 'missing identity' }],
    ['IMMUTABLE_IDENTITY', { id: id('sh_1'), version: 7 }],
    ['SCHEMA', { id: id('sh_1'), version: 1 }],
  ])('rejects invalid replacement: %s', (code, value) => {
    const request = changeSet([{ op: 'replace', op_id: id('op_1'), collection: 'shots', target: id('sh_1'), value }], { base_revisions: [{ id: id('sh_1'), version: 1 }] });
    expect(codes(submitChangeSet(createVersionState(makePackage()), request))).toContain(code);
  });

  it('removes an unreferenced panel and retains a deletion revision on adoption', () => {
    const request = changeSet([{ op: 'remove', op_id: id('op_1'), collection: 'panels', target: id('p_key') }], { base_revisions: [{ id: id('p_key'), version: 1 }] });
    const proposed = submitChangeSet(createVersionState(makePackage()), request);
    expect(proposed.status).toBe('candidate');
    const adopted = adoptChangeSet(proposed.state, id('cs_test'), approval());
    expect(adopted.state.head.panels.some(panel => panel.id === id('p_key'))).toBe(false);
    expect(adopted.state.revisions.filter(revision => revision.object_id === id('p_key')).at(-1)).toMatchObject({ version: 2, parent_version: 1, value: null });
    const forbiddenReuse = changeSet([{ op: 'add', op_id: id('op_3'), collection: 'panels', value: { ...panelDraft(makePackage()), id: id('p_key') } }], { id: id('second-request') });
    expect(codes(submitChangeSet(adopted.state, forbiddenReuse))).toContain('ID_REUSE');
  });

  it.each(['update', 'remove', 'replace'] as const)('does not let %s address the wrong collection', operation => {
    const op: ChangeOp = operation === 'update'
      ? { op: 'update', op_id: id('op_1'), collection: 'panels', target: id('sh_1'), set: {} }
      : operation === 'remove'
        ? { op: 'remove', op_id: id('op_1'), collection: 'panels', target: id('sh_1') }
        : { op: 'replace', op_id: id('op_1'), collection: 'panels', target: id('sh_1'), value: {} };
    expect(codes(submitChangeSet(createVersionState(makePackage()), changeSet([op])))).toContain('MISSING_OBJECT');
  });

  it('moves a shot within its sequence with a stable ID and fresh order key', () => {
    const pkg = makePackage();
    const request = changeSet([{ op: 'move', op_id: id('op_1'), target: id('sh_2'), before_id: id('sh_1') }], { base_revisions: [{ id: id('sh_2'), version: 5 }] });
    const result = submitChangeSet(createVersionState(pkg), request);
    expect(result.status).toBe('candidate');
    const moved = row(result.state.changes[0]!.preview!.shots, 'sh_2');
    expect(moved.id).toBe(id('sh_2'));
    expect(moved.version).toBe(6);
    expect(moved.order_key < row(result.state.changes[0]!.preview!.shots, 'sh_1').order_key).toBe(true);
    expect(row(pkg.shots, 'sh_2').order_key).toBe('a1');
  });

  it.each([
    ['MISSING_OBJECT', id('missing'), null], ['MISSING_CLIP', id('sh_1'), id('sh_3')],
  ] as const)('rejects invalid move: %s', (code, target, beforeId) => {
    const request = changeSet([{ op: 'move', op_id: id('op_1'), target, before_id: beforeId }], { base_revisions: [{ id: id('sh_1'), version: 1 }] });
    expect(codes(submitChangeSet(createVersionState(makePackage()), request))).toContain(code);
  });
});
