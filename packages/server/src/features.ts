import path from 'node:path';
import { snapshotEnvironment } from './secret-config.js';
/** Feature configuration is deployment data, captured before the secret-file await. */
export function loadApplicationFeatures(env: Record<string, string | undefined>) {
  const snapshot = snapshotEnvironment(env, ['CAMERY_SOURCE_IMPORTS', 'CAMERY_FRONTEND_DIRECTORY']);
  const enabled = snapshot['CAMERY_SOURCE_IMPORTS'] ?? '0'; const directory = snapshot['CAMERY_FRONTEND_DIRECTORY'];
  if (!['0','1'].includes(enabled) || directory !== undefined && (!directory || directory.length > 4096 || directory.includes('\0') || !path.isAbsolute(directory)))
    throw new Error('Invalid application features');
  return Object.freeze({ sourceImports: enabled === '1', ...(directory === undefined ? {} : { frontendDirectory: directory }) });
}
