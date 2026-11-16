import { expect, it } from 'vitest';
import { adoptChangeSet, createVersionState, submitChangeSet } from '../src/index';
import type { AdoptOptions } from '../src/types';
import { changeSet, fixtureId as id, makePackage } from '../../ir/test/fixtures';

it('fails closed with context when the trusted authority is unavailable', () => {
  const request = changeSet([{ op: 'update', op_id: id('op'), collection: 'shots', target: id('sh_1'), set: { action: '动作' } }], { base_revisions: [{ id: id('sh_1'), version: 1 }] });
  const state = submitChangeSet(createVersionState(makePackage()), request).state;
  const options: AdoptOptions = {
    actor: { kind: 'user', id: id('user_1') }, scope: { kind: 'project', id: id('prj_demo') }, at: '2026-11-10T00:00:00.000Z',
    authorize: () => { throw new Error('authority unavailable'); },
  };
  const result = adoptChangeSet(state, request.id, options);
  expect(result.status).toBe('rejected');
  expect(result.issues.map(i => i.code)).toContain('ADOPTION_AUTHORITY');
  expect(result.state).toBe(state);
});
it.each(['fulfilled', 'rejected'] as const)('denies async %s grants without an unhandled rejection', async mode => {
  const request = changeSet([{ op: 'update', op_id: id('op-async'), collection: 'shots', target: id('sh_1'), set: { action: 'must stay candidate' } }], { base_revisions: [{ id: id('sh_1'), version: 1 }] });
  const state = submitChangeSet(createVersionState(makePackage()), request).state;
  const authorize = (async () => { if (mode === 'rejected') throw new Error('authority unavailable'); return true; }) as unknown as AdoptOptions['authorize'];
  const result = adoptChangeSet(state, request.id, { actor: { kind: 'user', id: id('user_1') }, scope: { kind: 'project', id: id('prj_demo') }, at: '2026-11-10T00:00:00.000Z', authorize });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(result.issues.map(i => i.code)).toContain('ADOPTION_AUTHORITY'); expect(result.state).toBe(state);
});
