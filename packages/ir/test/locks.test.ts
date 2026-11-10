import { expect, it } from 'vitest';
import { validatePackage } from '../src/index';
import { fixtureId as id, makePackage, mutate } from './fixtures';

it.each(['missing', 'lock'])('rejects lock metadata or missing target %s', target => {
  const pkg = mutate(makePackage(), p => { p.locks.push({ id: id('lock'), version: 1, target: id(target), fields: [], owner_id: id('owner'), reason: '锁定' }); });
  expect(validatePackage(pkg).valid).toBe(false);
});

it.each(['', 'unknown', 'camera.unknown', 'camera.movement.value', 'camera..movement', 'id', 'version', '__proto__', 'camera.constructor'])('rejects malformed or nonexistent lock path %s', path => {
  const pkg = mutate(makePackage(), p => { p.locks.push({ id: id('lock'), version: 1, target: id('sh_1'), fields: [path], owner_id: id('owner'), reason: '锁定' }); });
  expect(validatePackage(pkg).valid).toBe(false);
});

it.each([{ fields: [] }, { fields: ['camera'] }, { fields: ['camera.movement'] }])('accepts content lock fields $fields', ({ fields }) => {
  const pkg = mutate(makePackage(), p => { p.locks.push({ id: id('lock'), version: 1, target: id('sh_1'), fields, owner_id: id('owner'), reason: '锁定' }); });
  expect(validatePackage(pkg).valid).toBe(true);
});
