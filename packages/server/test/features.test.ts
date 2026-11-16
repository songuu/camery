import { expect, it } from 'vitest';
import path from 'node:path';
import { loadApplicationFeatures } from '../src/features.js';
it('keeps source privileges opt-in and captures trusted static paths', () => {
  expect(loadApplicationFeatures({})).toEqual({ sourceImports: false });
  const env = { CAMERY_SOURCE_IMPORTS: '1', CAMERY_FRONTEND_DIRECTORY: path.resolve('public') };
  const captured = loadApplicationFeatures(env); env.CAMERY_SOURCE_IMPORTS = '0'; env.CAMERY_FRONTEND_DIRECTORY = 'other';
  expect(captured).toEqual({ sourceImports: true, frontendDirectory: path.resolve('public') }); expect(Object.isFrozen(captured)).toBe(true);
});
it.each([{ CAMERY_SOURCE_IMPORTS: 'true' }, { CAMERY_FRONTEND_DIRECTORY: '' }, { CAMERY_FRONTEND_DIRECTORY: 'relative' }, { CAMERY_FRONTEND_DIRECTORY: 'path\0' }])('rejects malformed deployment features without leaking values', env => {
  expect(() => loadApplicationFeatures(env)).toThrow('Invalid application features');
});
