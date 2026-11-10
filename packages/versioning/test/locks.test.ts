import { describe, expect, it } from 'vitest';
import { adoptChangeSet, createVersionState, submitChangeSet } from '../src/index';
import type { AdoptOptions } from '../src/types';
import { changeSet, fixtureId as id, makePackage, mutate, row } from '../../ir/test/fixtures';

const approval = (user = 'owner'): AdoptOptions => ({ actor: { kind: 'user', id: id(user) }, scope: { kind: 'project', id: id('prj_demo') }, at: '2026-11-10T00:00:00.000Z', authorize: () => true });
const codes = (r: ReturnType<typeof submitChangeSet>) => r.issues.map(i => i.code);
function lockedPackage() {
  return mutate(makePackage(), p => {
    p.locks.push({ id: id('lock'), version: 1, target: id('l_say'), fields: ['text'], owner_id: id('owner'), reason: '已定稿' });
    row(p.lines, 'l_say').locked = true;
  });
}

describe('explicit lock authority', () => {
  it('requires an explicit lock operation rather than a pre-locked new line', () => {
    const pkg = makePackage();
    const line = row(pkg.lines, 'l_say');
    const request = changeSet([{ op: 'add', op_id: id('op_1'), collection: 'lines', value: { ...structuredClone(line), id: id('new-line'), order_key: 'a1', locked: true } }]);
    const result = submitChangeSet(createVersionState(pkg), request);
    expect(codes(result)).toContain('LOCK_OPERATION_REQUIRED');
    expect(result.state.head.lines).toEqual(pkg.lines);
  });
  it.each(['self', 'cycle', 'missing'])('rejects %s lock references in imported state', kind => {
    const pkg = mutate(makePackage(), p => {
      p.locks.push({ id: id('lock'), version: 1, target: id(kind === 'self' ? 'lock' : kind === 'cycle' ? 'lock2' : 'missing'), fields: [], owner_id: id('owner'), reason: '导入' });
      if (kind === 'cycle') p.locks.push({ id: id('lock2'), version: 1, target: id('lock'), fields: [], owner_id: id('owner'), reason: '导入' });
    });
    expect(() => createVersionState(pkg)).toThrow(/INVALID_HEAD/);
  });
  it('does not let a different adopter impersonate the lock owner through JSON author', () => {
    const request = changeSet([{ op: 'unlock', op_id: id('op_1'), lock_id: id('lock'), reason: '调整' }], {
      author: { kind: 'user', id: id('owner') }, base_revisions: [{ id: id('lock'), version: 1 }, { id: id('l_say'), version: 1 }],
    });
    const proposed = submitChangeSet(createVersionState(lockedPackage()), request);
    expect(proposed.status).toBe('candidate');
    const denied = adoptChangeSet(proposed.state, id('cs_test'), approval('different'));
    expect(denied.status).toBe('rejected');
    expect(codes(denied)).toContain('LOCK_AUTHORITY');
    expect(denied.state.head.locks).toHaveLength(1);
    expect(adoptChangeSet(proposed.state, id('cs_test'), approval()).status).toBe('adopted');
  });

  it('blocks locked line text and requires owner unlock before changing it', () => {
    const blocked = changeSet([{ op: 'update', op_id: id('op_1'), collection: 'lines', target: id('l_say'), set: { text: '修改' } }], { base_revisions: [{ id: id('l_say'), version: 1 }] });
    expect(codes(submitChangeSet(createVersionState(lockedPackage()), blocked))).toContain('LOCKED_LINE');
    const released = changeSet([
      { op: 'unlock', op_id: id('op_1'), lock_id: id('lock'), reason: '允许改字' },
      { op: 'update', op_id: id('op_2'), collection: 'lines', target: id('l_say'), set: { text: '修改' } },
    ], { author: { kind: 'user', id: id('owner') }, base_revisions: [{ id: id('lock'), version: 1 }, { id: id('l_say'), version: 1 }] });
    const result = submitChangeSet(createVersionState(lockedPackage()), released);
    expect(result.status).toBe('candidate');
    expect(row(result.state.changes[0]!.preview!.lines, 'l_say')).toMatchObject({ text: '修改', locked: false, version: 2 });
  });

  it('protects nested fields without blocking an unrelated camera parameter', () => {
    const pkg = mutate(makePackage(), p => { p.locks.push({ id: id('lock'), version: 1, target: id('sh_1'), fields: ['camera.movement'], owner_id: id('owner'), reason: '固定运镜' }); });
    const camera = row(pkg.shots, 'sh_1').camera;
    const request = (movement: string) => changeSet([{ op: 'update', op_id: id('op_1'), collection: 'shots', target: id('sh_1'), set: { camera: { ...camera, movement, lens_mm: 50 } } }], { base_revisions: [{ id: id('sh_1'), version: 1 }] });
    expect(submitChangeSet(createVersionState(pkg), request('static')).status).toBe('candidate');
    expect(codes(submitChangeSet(createVersionState(pkg), request('pan')))).toContain('LOCKED');
  });
});
