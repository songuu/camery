import assert from 'node:assert/strict';
import test from 'node:test';
import { findPolicyViolations } from './source-policy.mjs';

test('valid code and JSON pass independently of type checking', () => {
  assert.deepEqual(findPolicyViolations('index.ts', 'export const answer: number = 42;\n'), []);
  assert.deepEqual(findPolicyViolations('package.json', '{"private":true}\n'), []);
});

test('reports the line of unresolved merge conflicts', () => {
  assert.deepEqual(findPolicyViolations('index.ts', 'first\n<<<<<<< HEAD\n'), [
    { line: 2, rule: 'merge-conflict', message: 'Unresolved merge conflict marker.' },
  ]);
});

test('rejects blanket type-check suppression but allows checked negative tests', () => {
  const ignored = '/' + '/ @ts-ignore\n' + '/' + '/ @ts-nocheck\n' + '/' + '* @ts-ignore */\n';
  assert.equal(findPolicyViolations('bad.ts', ignored).length, 3);
  assert.deepEqual(findPolicyViolations('negative.test.ts', '/' + '/ @ts-expect-error intentional negative case\n'), []);
});

test('invalid JSON is an actionable error, and non-source files are out of scope', () => {
  assert.equal(findPolicyViolations('manifest.json', '{ invalid }')[0]?.rule, 'invalid-json');
  assert.deepEqual(findPolicyViolations('notes.md', '<<<<<<< HEAD\n'), []);
});
