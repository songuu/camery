import { expect, it } from 'vitest';
import { Asset, StableId, StoryboardPackage } from '../src/schema';
import { makePackage } from './fixtures';

it('rejects line terminators after canonical ULIDs throughout the contract', () => {
  const pkg = makePackage();
  for (const suffix of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    expect(StableId.safeParse(pkg.package_id + suffix).success).toBe(false);
    expect(StoryboardPackage.safeParse({ ...pkg, package_id: pkg.package_id + suffix }).success).toBe(false);
  }
});
it('requires a whole hexadecimal SHA-256 token and a whole alphanumeric order key', () => {
  const pkg = makePackage(); const ready = { ...pkg.assets[0]!, status: 'ready', file: { path: 'a.png', sha256: 'a'.repeat(64), mime_type: 'image/png' } };
  expect(Asset.safeParse(ready).success).toBe(true);
  for (const suffix of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    expect(Asset.safeParse({ ...ready, file: { ...ready.file, sha256: ready.file.sha256 + suffix } }).success).toBe(false);
    expect(StoryboardPackage.safeParse({ ...pkg, episodes: pkg.episodes.map((episode, index) => index === 0 ? { ...episode, order_key: episode.order_key + suffix } : episode) }).success).toBe(false);
  }
});
