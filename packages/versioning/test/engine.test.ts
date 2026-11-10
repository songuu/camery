import { describe, expect, it } from 'vitest';
import { adoptChangeSet, createVersionState, rejectChangeSet, submitChangeSet } from '../src/index';
import type { AdoptOptions } from '../src/types';
import { changeSet, deepFreeze, fixtureId as id, makePackage, row } from '../../ir/test/fixtures';

const approval = (): AdoptOptions => ({ actor: { kind: 'user', id: id('user_1') }, scope: { kind: 'project', id: id('prj_demo') }, at: '2026-11-10T00:00:00.000Z', authorize: () => true });
const update = (set: Record<string, unknown> = { action: '新动作' }) => changeSet([
  { op: 'update', op_id: id('op_1'), collection: 'shots', target: id('sh_1'), set },
], { base_revisions: [{ id: id('sh_1'), version: 1 }] });
const codes = (result: ReturnType<typeof submitChangeSet>) => result.issues.map(i => i.code);

describe('transactional candidate and adoption core', () => {
  it('creates an imported baseline without fabricating past revision history', () => {
    const state = createVersionState(makePackage());
    expect(state.head).toEqual(makePackage());
    expect(state.changes).toEqual([]);
    expect(state.revisions.find(r => r.object_id === id('sh_2'))).toMatchObject({ version: 5, parent_version: null, change_set_id: null });
  });

  it('submits a candidate without modifying adopted state, then records human adoption', () => {
    const original = deepFreeze(createVersionState(makePackage()));
    const proposed = submitChangeSet(original, update());
    expect(proposed.status).toBe('candidate');
    expect(proposed.state.head).toEqual(original.head);
    expect(row(proposed.state.changes[0]!.preview!.shots, 'sh_1')).toMatchObject({ action: '新动作', version: 2 });
    const adopted = adoptChangeSet(proposed.state, id('cs_test'), approval());
    expect(adopted.status).toBe('adopted');
    expect(row(adopted.state.head.shots, 'sh_1').action).toBe('新动作');
    expect(adopted.state.head.revision).toMatchObject({ number: 6, status: 'adopted' });
    expect(adopted.state.revisions.filter(r => r.object_id === id('sh_1'))).toHaveLength(2);
    expect(adopted.state.adoptions[0]).toMatchObject({ change_set_id: id('cs_test'), from_revision: 5, to_revision: 6, actor_id: id('user_1') });
    expect(original.head).toEqual(makePackage());
  });

  it('is atomic when a later op is invalid', () => {
    const state = createVersionState(makePackage());
    const request = update();
    request.ops.push({ op: 'remove', op_id: id('op_2'), collection: 'shots', target: id('missing') });
    const result = submitChangeSet(state, request);
    expect(result.status).toBe('rejected');
    expect(result.state.head).toEqual(state.head);
    expect(result.state.changes[0]!.preview).toBeNull();
    expect(codes(result)).toContain('MISSING_OBJECT');
  });

  it('requires an object base revision and rejects stale reads', () => {
    expect(codes(submitChangeSet(createVersionState(makePackage()), { ...update(), base_revisions: [] }))).toContain('BASE_REQUIRED');
    const stale = { ...update(), base_revisions: [{ id: id('sh_1'), version: 9 }] };
    expect(submitChangeSet(createVersionState(makePackage()), stale).status).toBe('conflicted');
  });

  it('does not authorize adoption through an Agent identity or an absent host grant', () => {
    const state = submitChangeSet(createVersionState(makePackage()), update()).state;
    expect(codes(adoptChangeSet(state, id('cs_test'), { ...approval(), actor: { kind: 'agent_run', id: id('agent') } }))).toContain('ADOPTION_AUTHORITY');
    expect(codes(adoptChangeSet(state, id('cs_test'), { ...approval(), authorize: () => false }))).toContain('ADOPTION_AUTHORITY');
    expect(codes(adoptChangeSet(state, id('cs_test'), { ...approval(), scope: { kind: 'scene', id: id('sc_2') } }))).toContain('ADOPTION_SCOPE');
    expect(adoptChangeSet(state, id('cs_test'), { ...approval(), scope: { kind: 'scene', id: id('sc_1') } }).status).toBe('adopted');
  });

  it('supports idempotent submission/adoption and explicit rejection', () => {
    const proposed = submitChangeSet(createVersionState(makePackage()), update());
    expect(submitChangeSet(proposed.state, update()).state.changes).toHaveLength(1);
    expect(codes(submitChangeSet(proposed.state, update({ action: '另一请求' })))).toContain('CHANGE_ID_CONFLICT');
    const adopted = adoptChangeSet(proposed.state, id('cs_test'), approval());
    expect(adoptChangeSet(adopted.state, id('cs_test'), approval()).state.adoptions).toHaveLength(1);
    const rejected = rejectChangeSet(proposed.state, id('cs_test'), approval(), '制片暂不采用');
    expect(rejected.status).toBe('rejected');
    expect(codes(adoptChangeSet(rejected.state, id('cs_test'), approval()))).toContain('CHANGE_STATE');
  });
});
