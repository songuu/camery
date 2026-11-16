import { open } from 'node:fs/promises';
import { loadServerConfig } from './config.js';

/** Capture only declared deployment data before any asynchronous configuration work. */
export function snapshotEnvironment(env: Record<string, string | undefined>, keys: readonly string[]): Readonly<Record<string, string | undefined>> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    if (descriptor) {
      if (!('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'string')) throw new Error('Expected config data');
      snapshot[key] = descriptor.value;
    }
  }
  return Object.freeze(snapshot);
}

/** Read a deployment secret at runtime; it must never become a build argument or image layer. */
export async function readRuntimeConfig(env: Record<string, string | undefined>): Promise<ReturnType<typeof loadServerConfig>> {
  try {
    const snapshot = snapshotEnvironment(env, ['CAMERY_TENANT_ID', 'CAMERY_DATABASE_URL', 'CAMERY_DATABASE_URL_FILE', 'CAMERY_API_HOST', 'CAMERY_API_PORT']);
    const path = snapshot['CAMERY_DATABASE_URL_FILE'];
    if (path === undefined) return loadServerConfig(snapshot);
    if (!path || snapshot['CAMERY_DATABASE_URL'] !== undefined) throw new Error('Ambiguous credential source');
    const handle = await open(path, 'r');
    let text: string;
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Expected regular secret file');
      // Bound the actual read, including files that grow after open/stat.
      const chunks: Buffer[] = [];
      for await (const chunk of handle.createReadStream({ start: 0, end: 8192, autoClose: false })) chunks.push(chunk as Buffer);
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 8192) throw new Error('Secret too long');
      text = buffer.toString('utf8').replace(/\r?\n$/, '');
    } finally { await handle.close(); }
    return loadServerConfig({ ...snapshot, CAMERY_DATABASE_URL: text });
  } catch { throw new Error('Invalid server configuration'); }
}
