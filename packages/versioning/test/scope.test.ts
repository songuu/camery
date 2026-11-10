import { describe, expect, it } from 'vitest';
import type { ChangeOp, StoryboardPackage } from '@camery/ir';
import { adoptChangeSet, createVersionState, rejectChangeSet, submitChangeSet } from '../src/index';
import type { AdoptOptions } from '../src/types';
import { changeSet, fixtureId as id, makePackage, makeProductionPackage, mutate, row } from '../../ir/test/fixtures';

const approval = (scope: AdoptOptions['scope'] = { kind: 'project', id: id('prj_demo') }): AdoptOptions => ({ actor: { kind: 'user', id: id('user_1') }, scope, at: '2026-11-10T00:00:00.000Z', authorize: () => true });
const allBases = (pkg: StoryboardPackage) => Object.values(pkg).filter(Array.isArray).flatMap(rows => rows.filter((r): r is { id: string; version: number } => r && typeof r === 'object' && 'id' in r && 'version' in r).map(r => ({ id: r.id, version: r.version })));
function pending(pkg: StoryboardPackage, ops: ChangeOp[]) { return submitChangeSet(createVersionState(pkg), changeSet(ops, { base_revisions: allBases(pkg) })).state; }
const update = (collection: Extract<ChangeOp, { op: 'update' }>['collection'], target: string, set: Record<string, unknown>): ChangeOp => ({ op: 'update', op_id: id('op'), collection, target: id(target), set });

describe('trusted authority and adopted object scopes', () => {
  it.each([
    ['episodes', 'ep_1', { title: '新集名' }, 'episode', 'ep_1'],
    ['scenes', 'sc_1', { script_text: '新正文' }, 'scene', 'sc_1'],
    ['beats', 'b_open', { summary: '新节拍描述' }, 'scene', 'sc_1'],
    ['lines', 'l_say', { delivery: '低声' }, 'scene', 'sc_1'],
    ['panels', 'p_start', { description: '新画格描述' }, 'scene', 'sc_1'],
    ['audio_cues', 'cue_say', { mix: { gain_db: 1, fade_in_seconds: 0, fade_out_seconds: 0 } }, 'scene', 'sc_1'],
    ['audio_cues', 'cue_music_1', { sound_intent: '新底乐' }, 'episode', 'ep_1'],
  ] as const)('adopts %s edits within their declared %s ownership', (collection, target, set, kind, owner) => {
    const state = pending(makePackage(), [update(collection, target, set)]);
    expect(state.changes[0]!.status).toBe('candidate');
    expect(adoptChangeSet(state, id('cs_test'), approval({ kind, id: id(owner) })).status).toBe('adopted');
  });

  it('does not treat global assets or episode-global music as scene-local', () => {
    for (const op of [update('assets', 'as_img', { description: '新素材描述' }), update('audio_cues', 'cue_music_1', { sound_intent: '新底乐' })]) {
      const state = pending(makePackage(), [op]);
      expect(adoptChangeSet(state, id('cs_test'), approval({ kind: 'scene', id: id('sc_1') })).issues.map(i => i.code)).toContain('ADOPTION_SCOPE');
      expect(adoptChangeSet(state, id('cs_test'), approval()).status).toBe('adopted');
    }
  });

  it('resolves a lock through its content owner and refuses a shared segment under narrow approval', () => {
    const op: ChangeOp = { op: 'lock', op_id: id('op'), lock_id: id('new-lock'), target: id('seg_1'), fields: ['purpose'], reason: '人工排产锁' };
    const shared = makeProductionPackage();
    const state = pending(shared, [op]);
    expect(adoptChangeSet(state, id('cs_test'), approval({ kind: 'episode', id: id('ep_1') })).issues.map(i => i.code)).toContain('ADOPTION_SCOPE');
    const local = mutate(shared, p => { p.shot_takes = p.shot_takes.filter(t => [id('sh_1'), id('sh_2')].includes(t.shot_id)); });
    expect(adoptChangeSet(pending(local, [op]), id('cs_test'), approval({ kind: 'scene', id: id('sc_1') })).status).toBe('adopted');
    const unused = mutate(shared, p => { p.shot_takes = []; });
    expect(adoptChangeSet(pending(unused, [op]), id('cs_test'), approval({ kind: 'episode', id: id('ep_1') })).status).toBe('rejected');
  });

  it('adopts an episode snapshot within its episode but not as arbitrary scene content', () => {
    const pkg = mutate(makePackage(), p => { p.episode_state_snapshots.push({ id: id('snapshot'), version: 1, episode_id: id('ep_1'), based_on: [{ id: id('ep_1'), version: 1 }], status: 'adopted', facts: [], knowledge: [], characters: [], plot_threads: [] }); });
    const state = pending(pkg, [update('episode_state_snapshots', 'snapshot', { facts: ['已收到便签'] })]);
    expect(adoptChangeSet(state, id('cs_test'), approval({ kind: 'episode', id: id('ep_1') })).status).toBe('adopted');
    expect(adoptChangeSet(state, id('cs_test'), approval({ kind: 'scene', id: id('sc_1') })).status).toBe('rejected');
  });

  it.each(['project', 'episode', 'scene'] as const)('rejects an unknown %s scope', kind => {
    const state = pending(makePackage(), [update('shots', 'sh_1', { action: '动作' })]);
    expect(adoptChangeSet(state, id('cs_test'), approval({ kind, id: id('missing') })).issues.map(i => i.code)).toContain('ADOPTION_SCOPE');
  });

  it.each([
    { actor: { kind: 'user', id: 'bad-id' } },
    { authorize: undefined },
    { scope: { kind: 'unknown', id: id('prj_demo') } },
    { scope: { kind: 'project', id: 'bad-id' } },
    { at: 'invalid' },
    { at: '2026-11-10T00:00:00Z' },
  ])('rejects malformed trusted-host options %j', patch => {
    const state = pending(makePackage(), [update('shots', 'sh_1', { action: '动作' })]);
    const result = adoptChangeSet(state, id('cs_test'), { ...approval(), ...patch } as AdoptOptions);
    expect(result.status).toBe('rejected');
    expect(result.state).toBe(state);
  });

  it('rejects unknown decisions, invalid rejection authority and blank reasons without altering state', () => {
    const state = pending(makePackage(), [update('shots', 'sh_1', { action: '已修改动作' })]);
    expect(adoptChangeSet(state, id('missing'), approval()).issues.map(i => i.code)).toContain('MISSING_CHANGE');
    expect(rejectChangeSet(state, id('missing'), approval(), '不采用').issues.map(i => i.code)).toContain('MISSING_CHANGE');
    expect(rejectChangeSet(state, id('cs_test'), { ...approval(), authorize: () => false }, '不采用').issues.map(i => i.code)).toContain('ADOPTION_AUTHORITY');
    expect(rejectChangeSet(state, id('cs_test'), approval(), ' ').issues.map(i => i.code)).toContain('REJECTION_REASON');
    expect(rejectChangeSet(state, id('cs_test'), approval({ kind: 'scene', id: id('sc_2') }), '不采用').issues.map(i => i.code)).toContain('ADOPTION_SCOPE');
    const adopted = adoptChangeSet(state, id('cs_test'), approval());
    expect(rejectChangeSet(adopted.state, id('cs_test'), approval(), '不采用').issues.map(i => i.code)).toContain('CHANGE_STATE');
    expect(row(state.head.shots, 'sh_1').action).toBe(row(makePackage().shots, 'sh_1').action);
  });
});
