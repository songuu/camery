import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadChapterWorkerContent } from '../src/worker-content.js';
it('loads the existing pinned producer and chapter pack from a trusted content directory', async () => {
  const content = await loadChapterWorkerContent(fileURLToPath(new URL('../../../', import.meta.url)));
  expect(content.agents.resolve(content.producer).id).toBe('producer');
  expect(content.methods.resolve(content.method).manifest.id).toBe('chapter-segmentation');
  expect(content.agents.resolve(content.producer).methods).toEqual([content.method]);
});
it('maps malformed or missing content to a fixed error without filesystem diagnostics', async () => {
  await expect(loadChapterWorkerContent('/missing-private-worker-content')).rejects.toMatchObject({ code: 'WORKER_CONTENT' });
});
