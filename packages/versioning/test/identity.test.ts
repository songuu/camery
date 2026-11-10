import { expect, it } from 'vitest';
import { adoptChangeSet, createVersionState, submitChangeSet } from '../src/index';
import type { AdoptOptions } from '../src/types';
import { changeSet, fixtureId as id, makePackage, row } from '../../ir/test/fixtures';

const approval = (): AdoptOptions => ({ actor: { kind: 'user', id: id('user_1') }, scope: { kind: 'project', id: id('prj_demo') }, at: '2026-11-10T00:00:00.000Z', authorize: () => true });

it('does not reassign a retired nested location-spot identity', () => {
  let state = createVersionState(makePackage());
  const shop = row(state.head.locations, 'loc_shop');
  const remove = changeSet([{ op: 'update', op_id: id('op-remove-spot'), collection: 'locations', target: shop.id, set: { spots: shop.spots.filter(s => s.id !== id('spot_door')) } }], { id: id('remove-spot'), base_revisions: [{ id: shop.id, version: 1 }] });
  state = submitChangeSet(state, remove).state;
  const adopted = adoptChangeSet(state, id('remove-spot'), approval());
  expect(adopted.status).toBe('adopted');
  state = adopted.state;
  const reuse = changeSet([{ op: 'add', op_id: id('op-add-location'), collection: 'locations', value: { id: id('new-location'), version: 1, name: '新地点', description: '不同地点', spots: [{ id: id('spot_door'), label: '另一个位置' }] } }], { id: id('reuse-spot'), base_revision: state.head.revision.number });
  const denied = submitChangeSet(state, reuse);
  expect(denied.status).toBe('rejected');
  expect(denied.issues.map(i => i.code)).toContain('ID_REUSE');
});

it('does not reparent a still-active spot to another location in one atomic edit', () => {
  const pkg = makePackage();
  const shop = row(pkg.locations, 'loc_shop');
  const request = changeSet([
    { op: 'update', op_id: id('op-remove-spot'), collection: 'locations', target: shop.id, set: { spots: shop.spots.filter(s => s.id !== id('spot_door')) } },
    { op: 'add', op_id: id('op-add-location'), collection: 'locations', value: { id: id('new-location'), version: 1, name: '新地点', description: '不同地点', spots: [{ id: id('spot_door'), label: '移到另一个位置' }] } },
  ], { base_revisions: [{ id: shop.id, version: 1 }] });
  expect(submitChangeSet(createVersionState(pkg), request).status).toBe('rejected');
});
