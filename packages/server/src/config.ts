import { z } from 'zod';
import { accessId } from '@camery/access';

const configSchema = z.object({
  CAMERY_TENANT_ID: accessId,
  // oxlint-disable-next-line eslint/no-control-regex -- Reject control characters at this input boundary.
  CAMERY_DATABASE_URL: z.string().max(8192).regex(/^[^\s\u0000-\u001f\u007f]+$(?![\s\S])/).pipe(z.url()).refine(value => URL.canParse(value) && ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
  CAMERY_API_PORT: z.string().regex(/^[0-9]{1,5}$(?![\s\S])/).default('3000').transform(Number).pipe(z.number().int().min(1).max(65535)),
  CAMERY_API_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
});
export function loadServerConfig(env: Record<string, string | undefined>) {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) throw new Error('Invalid server configuration');
  return Object.freeze({ tenantId: parsed.data.CAMERY_TENANT_ID, databaseUrl: parsed.data.CAMERY_DATABASE_URL, host: parsed.data.CAMERY_API_HOST, port: parsed.data.CAMERY_API_PORT });
}
