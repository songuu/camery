import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readDevelopmentConfig } from '../src/development-config.js';

const profile = { label: '测试文本模型', baseUrl: 'https://models.example/v1', connectionId: 'development-text', modelIdentity: 'text-model', structuredOutput: 'json_schema', timeoutMs: 1000,
  currency: 'CNY', reservation: { tokens: 10000, costMicros: 10 }, pricing: { inputMicrosPerMillionTokens: 100, outputMicrosPerMillionTokens: 100 }, limits: { steps: 10, tokens: 100000, costMicros: 100 } };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'camery-development-config-'));
  const files = ['development', 'tasks', 'text', 'token'].map(name => join(directory, name));
  await Promise.all(files.map((path, index) => writeFile(path, index === 2 ? JSON.stringify(profile) : index === 3 ? 'fixture-token\n' : `postgresql://role_${index}:fixture@localhost/camery`, { mode: 0o600 })));
  const env: Record<string, string | undefined> = { CAMERY_DEVELOPMENT_ENABLED: '1', CAMERY_TENANT_ID: 'tenant-a', CAMERY_DEVELOPMENT_PROJECT_ID: 'project-a',
    CAMERY_DEVELOPMENT_DATABASE_URL_FILE: files[0], CAMERY_DEVELOPMENT_TASK_DATABASE_URL_FILE: files[1], CAMERY_DEVELOPMENT_TEXT_CONFIG_FILE: files[2], CAMERY_DEVELOPMENT_TEXT_TOKEN_FILE: files[3] };
  return { files, directory, env, cleanup: async () => { await Promise.all(files.map(path => rm(path, { force: true }))); await rmdir(directory); } };
}
it('disables cleanly and rejects partial deployment data even while disabled', async () => {
  expect(await readDevelopmentConfig({})).toBeNull(); expect(await readDevelopmentConfig({ CAMERY_DEVELOPMENT_ENABLED: '0', CAMERY_TENANT_ID: 'tenant-a' })).toBeNull();
  for (const env of [{ CAMERY_DEVELOPMENT_ENABLED: 'yes' }, { CAMERY_DEVELOPMENT_PROJECT_ID: 'project' }, { CAMERY_DEVELOPMENT_ENABLED: '1' }]) await expect(readDevelopmentConfig(env)).rejects.toThrow('Invalid Development configuration');
});
it('captures environment before its first await and freezes live-only budget configuration', async () => {
  const f = await fixture();
  try {
    const pending = readDevelopmentConfig(f.env); f.env['CAMERY_TENANT_ID'] = 'changed'; f.env['CAMERY_DEVELOPMENT_PROJECT_ID'] = 'changed'; f.env['CAMERY_DEVELOPMENT_TEXT_CONFIG_FILE'] = 'changed';
    const config = await pending;
    expect(config).toMatchObject({ tenantId: 'tenant-a', projectId: 'project-a', workerId: 'development-worker', pollMs: 1000, runsPerRound: 20,
      text: { modelIdentity: profile.modelIdentity, token: 'fixture-token', allowPrivateNetworks: false, allowInsecureHttp: false, modeDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(Object.isFrozen(config)).toBe(true); expect(Object.isFrozen(config?.text?.reservation)).toBe(true);
  } finally { await f.cleanup(); }
});
it('permits scoped brief storage without text credentials, but not half a profile', async () => {
  const f = await fixture();
  try {
    const noText = { ...f.env, CAMERY_DEVELOPMENT_TEXT_CONFIG_FILE: undefined, CAMERY_DEVELOPMENT_TEXT_TOKEN_FILE: undefined };
    expect((await readDevelopmentConfig(noText))?.text).toBeNull();
    await expect(readDevelopmentConfig({ ...noText, CAMERY_DEVELOPMENT_TEXT_TOKEN_FILE: f.files[3] })).rejects.toThrow('Invalid Development configuration');
    await expect(readDevelopmentConfig({ ...noText, CAMERY_DEVELOPMENT_TEXT_CONFIG_FILE: f.files[2] })).rejects.toThrow('Invalid Development configuration');
  } finally { await f.cleanup(); }
});
it('requires two balanced reservations and preserves explicit bounded host overrides',async()=>{
  const f=await fixture();
  try{
    const twoShares={...profile,limits:{steps:2,tokens:profile.reservation.tokens*2,costMicros:profile.reservation.costMicros*2}};
    await writeFile(f.files[2]!,JSON.stringify(twoShares));
    expect(await readDevelopmentConfig({...f.env,CAMERY_DEVELOPMENT_WORKER_ID:'explicit-worker',CAMERY_DEVELOPMENT_POLL_MS:'50',CAMERY_DEVELOPMENT_RUNS_PER_ROUND:'1'})).toMatchObject({workerId:'explicit-worker',pollMs:50,runsPerRound:1});
    for(const limits of [{...twoShares.limits,tokens:twoShares.limits.tokens-1},{...twoShares.limits,costMicros:twoShares.limits.costMicros-1}]){
      await writeFile(f.files[2]!,JSON.stringify({...profile,limits}));await expect(readDevelopmentConfig(f.env)).rejects.toThrow('Invalid Development configuration');
    }
  }finally{await f.cleanup();}
});
it('allows unknown provider prices only with a positive cost reservation', async () => {
  const f = await fixture();
  try {
    const { pricing: _pricing, ...unpriced } = profile; await writeFile(f.files[2]!, JSON.stringify(unpriced));
    expect((await readDevelopmentConfig(f.env))?.text?.pricing).toBeUndefined();
  } finally { await f.cleanup(); }
});
it('rejects getters without invoking them and keeps all file errors redacted', async () => {
  let invoked = false; const f = await fixture();
  try {
    await expect(readDevelopmentConfig(Object.defineProperty({ ...f.env }, 'CAMERY_DEVELOPMENT_PROJECT_ID', { get() { invoked = true; throw new Error('secret'); } }))).rejects.toThrow('Invalid Development configuration');
    expect(invoked).toBe(false);
    for (const path of ['', f.directory, join(f.directory, 'missing')]) await expect(readDevelopmentConfig({ ...f.env, CAMERY_DEVELOPMENT_DATABASE_URL_FILE: path })).rejects.toThrow('Invalid Development configuration');
    await writeFile(f.files[0]!, 'x'.repeat(8193)); await expect(readDevelopmentConfig(f.env)).rejects.toThrow('Invalid Development configuration');
    await writeFile(f.files[0]!, 'https://fixture-secret.example'); await expect(readDevelopmentConfig(f.env)).rejects.toThrow('Invalid Development configuration');
  } finally { await f.cleanup(); }
});
it('rejects malformed JSON, credential controls, synthetic evidence and unusable budget shares', async () => {
  const f = await fixture();
  try {
    for (const content of ['{', JSON.stringify({ ...profile, evidence: 'synthetic_replay' }), JSON.stringify({ ...profile, reservation: { tokens: 1, costMicros: 0 } }), JSON.stringify({ ...profile, limits: { steps: 1, tokens: 1, costMicros: 1 } }), 'x'.repeat(8193)]) {
      await writeFile(f.files[2]!, content); await expect(readDevelopmentConfig(f.env)).rejects.toThrow('Invalid Development configuration');
    }
    await writeFile(f.files[2]!, JSON.stringify(profile));
    for (const token of ['', 'a\nb', 'x'.repeat(8193)]) { await writeFile(f.files[3]!, token); await expect(readDevelopmentConfig(f.env)).rejects.toThrow('Invalid Development configuration'); }
    await writeFile(f.files[3]!, Buffer.from([0xff])); await expect(readDevelopmentConfig(f.env)).rejects.toThrow('Invalid Development configuration');
  } finally { await f.cleanup(); }
});
