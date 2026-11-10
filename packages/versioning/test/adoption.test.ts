import { describe, expect, it } from 'vitest';
import type { ChangeOp, StoryboardPackage } from '@camery/ir';
import { validatePackage } from '@camery/ir';
import { adoptChangeSet, createVersionState, rejectChangeSet, submitChangeSet } from '../src/index';
import type { AdoptOptions } from '../src/types';
import { changeSet, deepFreeze, fixtureId as id, makePackage, makeProductionPackage, mutate, row } from '../../ir/test/fixtures';

const approval = (scope: AdoptOptions['scope'] = { kind: 'project', id: id('prj_demo') }): AdoptOptions => ({ actor: { kind: 'user', id: id('user_1') }, scope, at: '2026-11-10T01:00:00.000Z', authorize: () => true });
function bases(pkg: StoryboardPackage) {
  return Object.values(pkg).filter(Array.isArray).flatMap(rows => rows.filter((r): r is { id: string; version: number } => r && typeof r === 'object' && 'id' in r && 'version' in r).map(r => ({ id: r.id, version: r.version })));
}
const request = (alias: string, target: string, version: number, action: string) => changeSet([
  { op: 'update', op_id: id('op-' + alias), collection: 'shots', target: id(target), set: { action } },
], { id: id(alias), base_revisions: [{ id: id(target), version }] });
const issueCodes = (result: ReturnType<typeof submitChangeSet>) => result.issues.map(i => i.code);

describe('concurrent candidate adoption', () => {
  it('rebases disjoint object edits while preserving the intervening adopted content', () => {
    let state = createVersionState(makePackage());
    state = submitChangeSet(state, request('a', 'sh_1', 1, 'A')).state;
    state = submitChangeSet(state, request('b', 'sh_2', 5, 'B')).state;
    state = adoptChangeSet(state, id('a'), approval()).state;
    const next = adoptChangeSet(deepFreeze(state), id('b'), approval());
    expect(next.status).toBe('adopted');
    expect(row(next.state.head.shots, 'sh_1')).toMatchObject({ action: 'A', version: 2 });
    expect(row(next.state.head.shots, 'sh_2')).toMatchObject({ action: 'B', version: 6 });
    expect(next.state.head.revision.number).toBe(7);
    expect(next.state.adoptions.map(a => [a.from_revision, a.to_revision])).toEqual([[5, 6], [6, 7]]);
  });

  it('marks a stale write conflicted without overwriting the winner', () => {
    let state = createVersionState(makePackage());
    state = submitChangeSet(state, request('a', 'sh_1', 1, 'A')).state;
    state = submitChangeSet(state, request('b', 'sh_1', 1, 'B')).state;
    state = adoptChangeSet(state, id('a'), approval()).state;
    const next = adoptChangeSet(state, id('b'), approval());
    expect(next.status).toBe('conflicted');
    expect(issueCodes(next)).toContain('REVISION_CONFLICT');
    expect(row(next.state.head.shots, 'sh_1').action).toBe('A');
    expect(next.state.adoptions).toHaveLength(1);
  });

  it('checks read dependencies even when the written object stayed unchanged', () => {
    let state = createVersionState(makePackage());
    const b = request('b', 'sh_2', 5, 'B');
    b.base_revisions.push({ id: id('sh_1'), version: 1 });
    state = submitChangeSet(state, b).state;
    state = submitChangeSet(state, request('a', 'sh_1', 1, 'A')).state;
    state = adoptChangeSet(state, id('a'), approval()).state;
    expect(adoptChangeSet(state, id('b'), approval()).status).toBe('conflicted');
  });

  it('records deleted-object tombstones and prevents historical ID reuse', () => {
    let state = createVersionState(makePackage());
    const panel = structuredClone(row(state.head.panels, 'p_end'));
    const remove = changeSet([{ op: 'remove', op_id: id('op-removed'), collection: 'panels', target: panel.id }], { id: id('remove'), base_revisions: [{ id: panel.id, version: 1 }] });
    state = submitChangeSet(state, remove).state;
    state = adoptChangeSet(state, id('remove'), approval()).state;
    expect(state.revisions.find(r => r.object_id === panel.id && r.version === 2)).toMatchObject({ parent_version: 1, value: null });
    const add = changeSet([{ op: 'add', op_id: id('op-reuse'), collection: 'panels', value: panel }], { id: id('add') });
    expect(issueCodes(submitChangeSet(state, add))).toContain('ID_REUSE');
  });

  it('can reject a scene-local candidate after a disjoint scene was adopted', () => {
    let state = createVersionState(makePackage());
    state = submitChangeSet(state, request('a', 'sh_1', 1, 'A')).state;
    state = submitChangeSet(state, request('b', 'sh_3', 1, 'B')).state;
    state = adoptChangeSet(state, id('b'), approval({ kind: 'scene', id: id('sc_2') })).state;
    const rejected = rejectChangeSet(state, id('a'), approval({ kind: 'scene', id: id('sc_1') }), '场景一暂缓');
    expect(rejected.status).toBe('rejected');
    expect(rejected.issues).toEqual([]);
    expect(rejected.state.changes.find(c => c.request.id === id('a'))?.status).toBe('rejected');
    expect(rejected.state.head).toEqual(state.head);
    expect(row(rejected.state.head.shots, 'sh_3').action).toBe('B');
  });

  it('checks original affected scope even when a concurrent candidate already produced the same values', () => {
    let state = createVersionState(makePackage());
    state = submitChangeSet(state, request('a', 'sh_1', 1, '相同结果')).state;
    state = submitChangeSet(state, request('b', 'sh_1', 1, '相同结果')).state;
    state = adoptChangeSet(state, id('b'), approval()).state;
    const denied = rejectChangeSet(state, id('a'), approval({ kind: 'scene', id: id('sc_2') }), '无关用户拒绝');
    expect(denied.issues.map(i => i.code)).toContain('ADOPTION_SCOPE');
    expect(denied.state.changes.find(c => c.request.id === id('a'))?.status).toBe('candidate');
    expect(rejectChangeSet(state, id('a'), approval({ kind: 'scene', id: id('sc_1') }), '本场景拒绝').issues).toEqual([]);
  });

  it('uses recorded submission-time ownership when the affected object has since been deleted', () => {
    let state = createVersionState(makePackage());
    const remove = (alias: string) => changeSet([{ op: 'remove', op_id: id('op-' + alias), collection: 'panels', target: id('p_end') }], { id: id(alias), base_revisions: [{ id: id('p_end'), version: 1 }] });
    state = submitChangeSet(state, remove('a')).state;
    state = submitChangeSet(state, remove('b')).state;
    state = adoptChangeSet(state, id('b'), approval()).state;
    const denied = rejectChangeSet(state, id('a'), approval({ kind: 'scene', id: id('sc_2') }), '不属于此场');
    expect(denied.issues.map(i => i.code)).toContain('ADOPTION_SCOPE');
    const result = rejectChangeSet(state, id('a'), approval({ kind: 'scene', id: id('sc_1') }), '已被另一候选完成');
    expect(result.issues).toEqual([]);
    expect(result.state.changes.find(c => c.request.id === id('a'))?.status).toBe('rejected');
    expect(result.state.head).toEqual(state.head);
  });
});

describe('atomic split references and scope', () => {
  function split(pkg: StoryboardPackage): ChangeOp {
    const { version: _version, ...shot } = row(pkg.shots, 'sh_2');
    return { op: 'split', op_id: id('op-split'), target: shot.id, into: [
      { ...structuredClone(shot), id: id('first'), duration: { planned: 2, measured: null } },
      { ...structuredClone(shot), id: id('second'), duration: { planned: 4, measured: null } },
    ] };
  }
  const allocator = () => { let counter = 0; return () => id('generated-' + counter++); };

  it('adopts shot, panel, cue and generated-material rewrites as one revision', () => {
    const pkg = makeProductionPackage();
    const change = changeSet([split(pkg)], { base_revisions: bases(pkg) });
    const candidate = submitChangeSet(createVersionState(pkg), change, { newId: allocator() });
    expect(candidate.issues).toEqual([]);
    expect(candidate.status).toBe('candidate');
    const firstIds = candidate.state.changes[0]!.generated_ids;
    expect(firstIds).toHaveLength(2);
    const adopted = adoptChangeSet(candidate.state, id('cs_test'), approval({ kind: 'scene', id: id('sc_1') }));
    expect(adopted.issues).toEqual([]);
    expect(adopted.status).toBe('adopted');
    expect(validatePackage(adopted.state.head).valid).toBe(true);
    expect(adopted.state.head.shots.some(s => s.id === id('sh_2'))).toBe(false);
    expect(row(adopted.state.head.panels, 'p_key').version).toBe(2);
    expect(row(adopted.state.head.audio_cues, 'cue_say').version).toBe(2);
    expect(adopted.state.head.shot_takes.filter(t => firstIds.includes(t.id))).toHaveLength(2);
    expect(adopted.state.revisions.find(r => r.object_id === id('sh_2') && r.version === 6)?.value).toBeNull();
  });

  it('requires base versions and honors locks for implicit dependent edits', () => {
    const pkg = makePackage();
    const minimal = changeSet([split(pkg)], { base_revisions: [{ id: id('sh_2'), version: 5 }] });
    expect(issueCodes(submitChangeSet(createVersionState(pkg), minimal))).toContain('BASE_REQUIRED');
    const locked = mutate(pkg, p => { p.locks.push({ id: id('lock'), version: 1, target: id('cue_say'), fields: ['anchor'], owner_id: id('owner'), reason: '配音定位已锁' }); });
    expect(issueCodes(submitChangeSet(createVersionState(locked), changeSet([split(locked)], { base_revisions: bases(locked) })))).toContain('LOCKED');
  });

  it('allows episode scope and rejects a scope excluding an implicit dependent', () => {
    const pkg = makePackage();
    const proposed = submitChangeSet(createVersionState(pkg), changeSet([split(pkg)], { base_revisions: bases(pkg) }));
    expect(adoptChangeSet(proposed.state, id('cs_test'), approval({ kind: 'episode', id: id('ep_1') })).status).toBe('adopted');
    expect(issueCodes(adoptChangeSet(proposed.state, id('cs_test'), approval({ kind: 'scene', id: id('sc_2') })))).toContain('ADOPTION_SCOPE');
  });

  it('keeps numeric-rounding diagnostics with the candidate and adopted revision', () => {
    const pkg = makePackage();
    const op = split(pkg);
    if (op.op !== 'split') throw new Error('fixture');
    op.into[0]!.duration.planned = 0.5;
    op.into[1]!.duration.planned = 5.5;
    const proposed = submitChangeSet(createVersionState(pkg), changeSet([op], { base_revisions: bases(pkg) }));
    expect(proposed.status).toBe('candidate');
    expect(proposed.warnings.map(w => w.code)).toContain('TIME_ROUNDED');
    const adopted = adoptChangeSet(proposed.state, id('cs_test'), approval());
    expect(adopted.status).toBe('adopted');
    expect(adopted.warnings).toEqual(proposed.warnings);
  });

  it('requires rebase when a newly adopted dependent take would change generated identities', () => {
    const pkg = makeProductionPackage();
    let state = submitChangeSet(createVersionState(pkg), changeSet([split(pkg)], { base_revisions: bases(pkg) }), { newId: allocator() }).state;
    const take = pkg.shot_takes.find(t => t.shot_id === id('sh_2'))!;
    const extra = changeSet([{ op: 'add', op_id: id('op-extra'), collection: 'shot_takes', value: { ...structuredClone(take), id: id('extra-take'), status: 'candidate' } }], { id: id('extra') });
    state = submitChangeSet(state, extra).state;
    state = adoptChangeSet(state, id('extra'), approval()).state;
    const result = adoptChangeSet(state, id('cs_test'), approval());
    expect(result.status).not.toBe('adopted');
    expect(issueCodes(result)).toContain('REBASE_REQUIRED');
    expect(result.state.head).toEqual(state.head);
  });
});
