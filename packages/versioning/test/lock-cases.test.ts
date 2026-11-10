import { describe, expect, it } from 'vitest';
import type { ChangeOp, ChangeSet, StoryboardPackage } from '@camery/ir';
import { adoptChangeSet, createVersionState, submitChangeSet } from '../src/index';
import type { AdoptOptions } from '../src/types';
import { changeSet, deepFreeze, fixtureId as id, makePackage, mutate, row } from '../../ir/test/fixtures';

const approval = (alias = 'owner'): AdoptOptions => ({ actor: { kind: 'user', id: id(alias) }, scope: { kind: 'project', id: id('prj_demo') }, at: '2026-11-10T00:00:00.000Z', authorize: () => true });
const codes = (result: ReturnType<typeof submitChangeSet>) => result.issues.map(issue => issue.code);
const request = (ops: ChangeOp[], base: Array<{ id: string; version: number }> = [{ id: id('sh_1'), version: 1 }], overrides: Partial<ChangeSet> = {}): ChangeSet => changeSet(ops, {
  author: { kind: 'user', id: id('owner') }, base_revisions: base, ...overrides,
});
const lockOp = (fields: string[] = []): ChangeOp => ({ op: 'lock', op_id: id('op_1'), lock_id: id('lock-new'), target: id('sh_1'), fields, reason: '人工锁定' });
const locked = (fields: string[] = []): StoryboardPackage => mutate(makePackage(), p => {
  p.locks.push({ id: id('lock'), version: 1, target: id('sh_1'), fields, owner_id: id('owner'), reason: '固定' });
});

describe('lock creation and protected edits', () => {
  it('creates a version-one human-owned lock and records it only after adoption', () => {
    const state = deepFreeze(createVersionState(makePackage()));
    const proposed = submitChangeSet(state, request([lockOp(['camera.movement'])]));
    expect(proposed.status).toBe('candidate');
    expect(proposed.state.head.locks).toEqual([]);
    expect(proposed.state.changes[0]!.preview!.locks[0]).toMatchObject({ id: id('lock-new'), version: 1, target: id('sh_1'), owner_id: id('owner') });
    const adopted = adoptChangeSet(proposed.state, id('cs_test'), approval());
    expect(adopted.status).toBe('adopted');
    expect(adopted.state.head.locks).toHaveLength(1);
    expect(state.head.locks).toEqual([]);
  });

  it.each(['agent_run', 'system'] as const)('rejects %s lock-management requests', kind => {
    const proposed = submitChangeSet(createVersionState(makePackage()), request([lockOp()], undefined, { author: { kind, id: id('agent') } }));
    expect(codes(proposed)).toContain('LOCK_AUTHORITY');
  });

  it.each(['unknown', 'camera.unknown', 'camera.lens_mm.value', 'camera.', 'camera..movement', 'id', 'version', '__proto__', 'camera.constructor', 'beat_refs.0'])('rejects non-content lock path %s', path => {
    expect(codes(submitChangeSet(createVersionState(makePackage()), request([lockOp([path])])))).toContain('LOCK_FIELD');
  });

  it('does not accept a missing target, existing identity or lock metadata as a lock target', () => {
    const missing: ChangeOp = { op: 'lock', op_id: id('op_1'), lock_id: id('new-lock'), target: id('missing'), fields: [], reason: '锁定' };
    expect(codes(submitChangeSet(createVersionState(makePackage()), request([missing])))).toContain('MISSING_OBJECT');
    const reused: ChangeOp = { ...missing, target: id('sh_1'), lock_id: id('sh_2') };
    expect(codes(submitChangeSet(createVersionState(makePackage()), request([reused])))).toContain('ID_REUSE');
    const targetLock: ChangeOp = { ...missing, target: id('lock') };
    expect(codes(submitChangeSet(createVersionState(locked()), request([targetLock])))).toContain('LOCK_TARGET');
  });

  it.each([{ fields: [] }, { fields: ['camera'] }, { fields: ['camera.movement'] }])('blocks relevant content mutations with fields $fields', ({ fields }) => {
    const pkg = locked(fields);
    const camera = { ...row(pkg.shots, 'sh_1').camera, movement: 'pan' };
    const edit: ChangeOp = { op: 'update', op_id: id('op_1'), collection: 'shots', target: id('sh_1'), set: { camera } };
    const result = submitChangeSet(createVersionState(pkg), request([edit]));
    expect(codes(result)).toContain('LOCKED');
    expect(result.state.head).toEqual(pkg);
    expect(result.state.changes[0]!.preview).toBeNull();
  });

  it('allows an unrelated field while retaining a nested lock', () => {
    const pkg = locked(['camera.movement']);
    const edit: ChangeOp = { op: 'update', op_id: id('op_1'), collection: 'shots', target: id('sh_1'), set: { action: '改动作' } };
    const result = submitChangeSet(createVersionState(pkg), request([edit]));
    expect(result.status).toBe('candidate');
    expect(result.state.changes[0]!.preview!.locks).toEqual(pkg.locks);
  });

  it('cannot bypass locks by removing a protected parent field in a replacement', () => {
    const pkg = locked(['camera.movement']);
    const value: Record<string, unknown> = { ...row(pkg.shots, 'sh_1') };
    delete value.camera;
    const edit: ChangeOp = { op: 'replace', op_id: id('op_1'), collection: 'shots', target: id('sh_1'), value };
    expect(codes(submitChangeSet(createVersionState(pkg), request([edit])))).toContain('LOCKED');
  });

  it('blocks deletion of a locked object', () => {
    const pkg = mutate(makePackage(), p => { p.locks.push({ id: id('lock'), version: 1, target: id('p_key'), fields: [], owner_id: id('owner'), reason: '保留' }); });
    const edit: ChangeOp = { op: 'remove', op_id: id('op_1'), collection: 'panels', target: id('p_key') };
    expect(codes(submitChangeSet(createVersionState(pkg), request([edit], [{ id: id('p_key'), version: 1 }])))).toContain('LOCKED');
  });
});

describe('explicit unlock semantics', () => {
  const unlock: ChangeOp = { op: 'unlock', op_id: id('op_1'), lock_id: id('lock'), reason: '解除' };
  const bases = [{ id: id('lock'), version: 1 }, { id: id('sh_1'), version: 1 }];

  it('requires the lock owner, all touched bases and the trusted matching adopter', () => {
    const state = createVersionState(locked());
    expect(codes(submitChangeSet(state, request([unlock], bases, { author: { kind: 'user', id: id('other') } })))).toContain('LOCK_OWNER');
    expect(codes(submitChangeSet(state, request([unlock], [{ id: id('lock'), version: 1 }])))).toContain('BASE_REQUIRED');
    const proposed = submitChangeSet(state, request([unlock], bases));
    expect(proposed.status).toBe('candidate');
    expect(codes(adoptChangeSet(proposed.state, id('cs_test'), approval('other')))).toContain('LOCK_AUTHORITY');
    expect(adoptChangeSet(proposed.state, id('cs_test'), approval()).state.head.locks).toEqual([]);
  });

  it('reports absent locks and refuses machine unlocks', () => {
    expect(codes(submitChangeSet(createVersionState(makePackage()), request([unlock])))).toContain('MISSING_OBJECT');
    expect(codes(submitChangeSet(createVersionState(locked()), request([unlock], bases, { author: { kind: 'agent_run', id: id('owner') } })))).toContain('LOCK_AUTHORITY');
  });

  it('does not permit line.locked to change through update or replacement', () => {
    for (const operation of ['update', 'replace'] as const) {
      const op: ChangeOp = operation === 'update'
        ? { op: 'update', op_id: id('op_1'), collection: 'lines', target: id('l_say'), set: { locked: true } }
        : { op: 'replace', op_id: id('op_1'), collection: 'lines', target: id('l_say'), value: { ...row(makePackage().lines, 'l_say'), locked: true } };
      expect(codes(submitChangeSet(createVersionState(makePackage()), request([op], [{ id: id('l_say'), version: 1 }])))).toContain('LOCK_OPERATION_REQUIRED');
    }
  });

  it('locks text explicitly and allows changing a nontext delivery annotation', () => {
    const lineLock: ChangeOp = { op: 'lock', op_id: id('op_1'), lock_id: id('line-lock'), target: id('l_say'), fields: ['text'], reason: '定稿' };
    const edit: ChangeOp = { op: 'update', op_id: id('op_2'), collection: 'lines', target: id('l_say'), set: { delivery: '压低声音' } };
    const result = submitChangeSet(createVersionState(makePackage()), request([lineLock, edit], [{ id: id('l_say'), version: 1 }]));
    expect(result.status).toBe('candidate');
    expect(row(result.state.changes[0]!.preview!.lines, 'l_say')).toMatchObject({ locked: true, delivery: '压低声音', version: 2 });
  });

  it('keeps the line locked until all explicit text locks are released', () => {
    const pkg = mutate(makePackage(), p => {
      row(p.lines, 'l_say').locked = true;
      for (const alias of ['lock', 'lock2']) p.locks.push({ id: id(alias), version: 1, target: id('l_say'), fields: ['text'], owner_id: id('owner'), reason: '定稿' });
    });
    const lineBases = [{ id: id('lock'), version: 1 }, { id: id('l_say'), version: 1 }];
    const proposed = submitChangeSet(createVersionState(pkg), request([unlock], lineBases));
    expect(proposed.status).toBe('candidate');
    expect(row(proposed.state.changes[0]!.preview!.lines, 'l_say').locked).toBe(true);
    const changed: ChangeOp = { op: 'update', op_id: id('op_2'), collection: 'lines', target: id('l_say'), set: { text: '仍被另一个锁禁止' } };
    const rejected = submitChangeSet(createVersionState(pkg), request([unlock, changed], lineBases));
    expect(codes(rejected)).toContain('LOCKED_LINE');
    expect(rejected.state.head.locks).toHaveLength(2);
  });

  it('unlocks a standalone imported line lock explicitly before editing its text', () => {
    const pkg = mutate(makePackage(), p => { row(p.lines, 'l_say').locked = true; });
    const ops: ChangeOp[] = [
      { op: 'unlock_line', op_id: id('op_1'), target: id('l_say'), reason: '允许改字' },
      { op: 'update', op_id: id('op_2'), collection: 'lines', target: id('l_say'), set: { text: '明确解锁后的改字' } },
    ];
    const result = submitChangeSet(createVersionState(pkg), request(ops, [{ id: id('l_say'), version: 1 }]));
    expect(result.status).toBe('candidate');
    expect(row(result.state.changes[0]!.preview!.lines, 'l_say')).toMatchObject({ locked: false, text: '明确解锁后的改字' });
  });

  it('refuses unlock_line while an explicit text lock remains', () => {
    const pkg = mutate(makePackage(), p => {
      row(p.lines, 'l_say').locked = true;
      p.locks.push({ id: id('lock'), version: 1, target: id('l_say'), fields: [], owner_id: id('owner'), reason: '对象锁' });
    });
    const op: ChangeOp = { op: 'unlock_line', op_id: id('op_1'), target: id('l_say'), reason: '不能绕过对象锁' };
    expect(codes(submitChangeSet(createVersionState(pkg), request([op], [{ id: id('l_say'), version: 1 }])))).toContain('LOCK_OPERATION_REQUIRED');
  });

  it('checks unlock_line target type and human authority', () => {
    const missing: ChangeOp = { op: 'unlock_line', op_id: id('op_1'), target: id('sh_1'), reason: '错误类型' };
    expect(codes(submitChangeSet(createVersionState(makePackage()), request([missing])))).toContain('MISSING_OBJECT');
    const line: ChangeOp = { ...missing, target: id('l_say') };
    expect(codes(submitChangeSet(createVersionState(makePackage()), request([line], [{ id: id('l_say'), version: 1 }], { author: { kind: 'system', id: id('owner') } })))).toContain('LOCK_AUTHORITY');
  });
});
