import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config.js';

describe('server deployment configuration', () => {
  const valid = { CAMERY_TENANT_ID: 'tenant-a', CAMERY_DATABASE_URL: 'postgresql://app:secret@127.0.0.1:5432/camery' };
  it('requires an explicit tenant/database and binds to loopback by default', () => {
    expect(loadServerConfig(valid)).toEqual({ tenantId: 'tenant-a', databaseUrl: valid.CAMERY_DATABASE_URL, host: '127.0.0.1', port: 3000 });
    expect(loadServerConfig({ ...valid, CAMERY_API_PORT: '4567' }).port).toBe(4567);
    expect(loadServerConfig({ ...valid, CAMERY_API_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });
  it.each([{}, { ...valid, CAMERY_TENANT_ID: 'tenant\n' }, { ...valid, CAMERY_DATABASE_URL: 'https://secret.example' }, { ...valid, CAMERY_DATABASE_URL: '' }, { ...valid, CAMERY_DATABASE_URL: valid.CAMERY_DATABASE_URL + '\n' }, { ...valid, CAMERY_API_PORT: '0' }, { ...valid, CAMERY_API_PORT: '65536' }, { ...valid, CAMERY_API_PORT: '' }, { ...valid, CAMERY_API_HOST: 'example.com' }])('fails safely on invalid setup', value => {
    expect(() => loadServerConfig(value)).toThrow('Invalid server configuration');
    try { loadServerConfig(value); } catch (error) { expect(String(error)).not.toContain('secret'); }
  });
});
