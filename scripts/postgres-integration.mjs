import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This local-only helper reads the ignored phase-0 credential file; the URL goes only to the test child's environment.
const root = fileURLToPath(new URL('../', import.meta.url));
const [target, ...args] = process.argv.slice(2);
if (!['durable', 'versioning', 'agents', 'access', 'server', 'ingest', 'bible', 'script', 'private-api', 'private-worker','private-development'].includes(target)) throw new Error('Select durable, versioning, agents, access, server, ingest, bible, script, private-api, private-worker or private-development tests');
const composeTest = target === 'private-api' || target === 'private-worker'||target==='private-development';
const packageName = composeTest ? 'server' : target;
const packageRoot = fileURLToPath(new URL(`../packages/${packageName}/`, import.meta.url));
if (args.some(arg => arg !== '--coverage')) throw new Error('Only --coverage is supported');
if (composeTest && args.length) throw new Error('Compose tests inspect the running image; use package coverage commands separately');
let databaseUrl = process.env['CAMERY_TEST_DATABASE_URL'];
if (!databaseUrl) {
  const values = new Map(readFileSync(new URL('../deploy/.env.phase0', import.meta.url), 'utf8').split(/\r?\n/)
    .filter(line => line && !line.startsWith('#')).map(line => {
      const split = line.indexOf('=');
      if (split < 1) throw new Error('Malformed deploy/.env.phase0');
      return [line.slice(0, split), line.slice(split + 1)];
    }));
  const port = spawnSync('docker', ['compose', '--project-name', 'camery-phase0', '--env-file', 'deploy/.env.phase0', '-f', 'deploy/compose.private.yml', 'port', 'postgres', '5432'], { cwd: root, encoding: 'utf8' });
  if (port.status !== 0) throw new Error('Cannot inspect phase-0 PostgreSQL port; check Docker access');
  const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(port.stdout);
  if (!match) throw new Error('Phase-0 PostgreSQL must bind to loopback');
  const password = values.get('CAMERY_POSTGRES_PASSWORD');
  if (!password) throw new Error('Missing phase-0 database password');
  const url = new URL(`postgresql://127.0.0.1:${match[1]}`);
  url.username = values.get('CAMERY_POSTGRES_USER') ?? 'camery_admin'; url.password = password;
  url.pathname = `/${encodeURIComponent(values.get('CAMERY_POSTGRES_DB') ?? 'camery')}`;
  databaseUrl = url.toString();
}
const require = createRequire(new URL(`../packages/${packageName}/package.json`, import.meta.url));
const vitestPackage = require.resolve('vitest/package.json');
const vitest = path.join(path.dirname(vitestPackage), JSON.parse(readFileSync(vitestPackage, 'utf8')).bin.vitest);
const config = target === 'private-api' ? 'vitest.compose.config.ts' : target === 'private-worker' ? 'vitest.worker-compose.config.ts' :target==='private-development'?'vitest.development-compose.config.ts': 'vitest.integration.config.ts';
const result = spawnSync(process.execPath, [vitest, 'run', '--config', config, ...args], {
  cwd: packageRoot, env: { ...process.env, CAMERY_TEST_DATABASE_URL: databaseUrl }, stdio: 'inherit',
});
if (result.error) throw new Error('Unable to start durable integration test process', { cause: result.error });
process.exitCode = result.status ?? 1;
