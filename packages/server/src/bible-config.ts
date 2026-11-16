import { open } from 'node:fs/promises';
import { z } from 'zod';
import { accessId } from '@camery/access';
import { ExecutionSchema, executionForChunks } from '@camery/bible/node';
import { digest } from '@camery/methods';
import { snapshotEnvironment } from './secret-config.js';
import { loadServerConfig } from './config.js';

const keys = ['CAMERY_BIBLE_ENABLED', 'CAMERY_TENANT_ID', 'CAMERY_BIBLE_PROJECT_ID', 'CAMERY_BIBLE_DATABASE_URL_FILE', 'CAMERY_BIBLE_TASK_DATABASE_URL_FILE', 'CAMERY_BIBLE_TEXT_CONFIG_FILE', 'CAMERY_BIBLE_TEXT_TOKEN_FILE', 'CAMERY_BIBLE_WORKER_ID', 'CAMERY_BIBLE_POLL_MS', 'CAMERY_BIBLE_RUNS_PER_ROUND'] as const;
// oxlint-disable-next-line eslint/no-control-regex -- File paths cannot contain controls at this deployment boundary.
const Path = z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$(?![\s\S])/);
const Deployment = z.strictObject({ tenantId: accessId, projectId: accessId, bibleFile: Path, taskFile: Path,
  textFile: Path.optional(), tokenFile: Path.optional(), workerId: accessId,
  pollMs: z.coerce.number().int().min(50).max(60000), runsPerRound: z.coerce.number().int().min(1).max(50) });
const Text = z.strictObject({ label: z.string().trim().min(1).max(200), baseUrl: z.url().max(2048),
  connectionId: ExecutionSchema.shape.connectionId, modelIdentity: ExecutionSchema.shape.modelIdentity,
  structuredOutput: z.enum(['json_schema', 'json_object']), timeoutMs: z.int().min(100).max(280000),
  allowPrivateNetworks: z.boolean().default(false), allowInsecureHttp: z.boolean().default(false),
  currency: ExecutionSchema.shape.currency, reservation: ExecutionSchema.shape.reservation,
  pricing: ExecutionSchema.shape.pricing, limits: ExecutionSchema.shape.limits });
export type BibleTextConfig = Readonly<z.infer<typeof Text> & { modeDigest: string; token: string }>;
export interface BibleDeploymentConfig {
  readonly tenantId: string; readonly projectId: string; readonly bibleDatabaseUrl: string; readonly taskDatabaseUrl: string;
  readonly text: BibleTextConfig | null; readonly workerId: string; readonly pollMs: number; readonly runsPerRound: number;
}
/** Read the open regular file with an actual byte cap, including growth after stat. */
async function readFile(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error();
    const chunks: Buffer[] = [];
    for await (const chunk of handle.createReadStream({ start: 0, end: 8192, autoClose: false })) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    if (bytes.length > 8192) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/, '');
  } finally { await handle.close(); }
}
/** Call before any startup await: the synchronous prefix captures all declared environment data. */
export async function readBibleConfig(env: Record<string, string | undefined>): Promise<BibleDeploymentConfig | null> {
  try {
    const values = snapshotEnvironment(env, keys);
    const enabled = values['CAMERY_BIBLE_ENABLED'];
    if (enabled === undefined || enabled === '0') {
      if (keys.some(key => key !== 'CAMERY_BIBLE_ENABLED' && key !== 'CAMERY_TENANT_ID' && values[key] !== undefined)) throw new Error();
      return null;
    }
    if (enabled !== '1') throw new Error();
    const data = Deployment.parse({ tenantId: values['CAMERY_TENANT_ID'], projectId: values['CAMERY_BIBLE_PROJECT_ID'],
      bibleFile: values['CAMERY_BIBLE_DATABASE_URL_FILE'], taskFile: values['CAMERY_BIBLE_TASK_DATABASE_URL_FILE'],
      ...(values['CAMERY_BIBLE_TEXT_CONFIG_FILE'] !== undefined ? { textFile: values['CAMERY_BIBLE_TEXT_CONFIG_FILE'] } : {}),
      ...(values['CAMERY_BIBLE_TEXT_TOKEN_FILE'] !== undefined ? { tokenFile: values['CAMERY_BIBLE_TEXT_TOKEN_FILE'] } : {}),
      workerId: values['CAMERY_BIBLE_WORKER_ID'] ?? 'bible-worker', pollMs: values['CAMERY_BIBLE_POLL_MS'] ?? '1000', runsPerRound: values['CAMERY_BIBLE_RUNS_PER_ROUND'] ?? '20' });
    if (Boolean(data.textFile) !== Boolean(data.tokenFile)) throw new Error();
    const bibleDatabaseUrl = loadServerConfig({ CAMERY_TENANT_ID: data.tenantId, CAMERY_DATABASE_URL: await readFile(data.bibleFile) }).databaseUrl;
    const taskDatabaseUrl = loadServerConfig({ CAMERY_TENANT_ID: data.tenantId, CAMERY_DATABASE_URL: await readFile(data.taskFile) }).databaseUrl;
    let text: BibleTextConfig | null = null;
    if (data.textFile && data.tokenFile) {
      const parsed = Text.parse(JSON.parse(await readFile(data.textFile)));
      const token = await readFile(data.tokenFile);
      // oxlint-disable-next-line eslint/no-control-regex -- Header credentials must never contain controls.
      if (!token || /[\u0000-\u001f\u007f]/.test(token)) throw new Error();
      const modeDigest = digest({ version: 1, baseUrl: parsed.baseUrl, connectionId: parsed.connectionId, modelIdentity: parsed.modelIdentity,
        structuredOutput: parsed.structuredOutput, timeoutMs: parsed.timeoutMs, allowPrivateNetworks: parsed.allowPrivateNetworks, allowInsecureHttp: parsed.allowInsecureHttp });
      executionForChunks({ connectionId: parsed.connectionId, modelIdentity: parsed.modelIdentity, modeDigest, evidence: 'live_model', modelTier: 'economy',
        currency: parsed.currency, reservation: parsed.reservation, ...(parsed.pricing ? { pricing: parsed.pricing } : {}), limits: parsed.limits }, 1);
      text = Object.freeze({ ...parsed, reservation: Object.freeze(parsed.reservation), limits: Object.freeze(parsed.limits), ...(parsed.pricing ? { pricing: Object.freeze(parsed.pricing) } : {}), modeDigest, token });
    }
    return Object.freeze({ tenantId: data.tenantId, projectId: data.projectId, bibleDatabaseUrl, taskDatabaseUrl, text, workerId: data.workerId, pollMs: data.pollMs, runsPerRound: data.runsPerRound });
  } catch { throw new Error('Invalid Bible configuration'); }
}
