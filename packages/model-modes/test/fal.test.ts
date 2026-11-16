import { expect, it, vi } from 'vitest';
import { FalQueueConnector } from '../src/connectors/fal.js';
import type { HttpTransport, JsonObject } from '../src/types.js';
import { context, reply } from './support.js';
function fixture(endpoint = 'owner/app/variant') {
  const exchange = vi.fn<HttpTransport['exchange']>().mockResolvedValue(reply({ request_id: 'job-1', status: 'IN_QUEUE', status_url: 'https://malicious.invalid/metadata' }));
  return { exchange, connector: new FalQueueConnector({ exchange }, { endpoint }) };
}
it('submits once to the configured endpoint and keeps remote identity', async () => {
  const { connector, exchange } = fixture(); const ctx = context();
  expect(await connector.submit({ prompt: 'original content' }, ctx)).toEqual({ id: 'job-1', state: 'queued' });
  expect(exchange).toHaveBeenCalledWith({ method: 'POST', path: '/owner/app/variant', effect: 'submit', responseType: 'json', body: { prompt: 'original content' } }, ctx);
  expect(exchange).toHaveBeenCalledTimes(1);
});
it.each([['IN_QUEUE', 'queued'], ['IN_PROGRESS', 'running'], ['COMPLETED', 'unknown'], ['UNRECOGNIZED', 'unknown']])('maps polling %s conservatively to %s', async (status, state) => {
  const { connector, exchange } = fixture(); exchange.mockResolvedValue(reply({ request_id: 'job-1', status, response_url: 'http://169.254.169.254/' }));
  expect(await connector.poll('job-1', context())).toEqual({ id: 'job-1', state });
  expect(exchange.mock.calls[0]![0]).toEqual({ method: 'GET', path: '/owner/app/requests/job-1/status', effect: 'read', responseType: 'json' });
});
it.each([{ error: 'execution failed' }, { error_type: 'cancelled' }])('never treats COMPLETED with failure information as success: %s', async failure => {
  const { connector, exchange } = fixture(); exchange.mockResolvedValue(reply({ request_id: 'job-1', status: 'COMPLETED', ...failure }));
  expect((await connector.poll('job-1', context())).state).toBe('failed');
});
it('marks only a successfully retrieved result as remote success, never local artifact readiness', async () => {
  const { connector, exchange } = fixture(); const value = { images: [{ url: 'https://untrusted.example/candidate.png' }] };
  exchange.mockResolvedValue(reply(value)); expect(await connector.result('job-1', context())).toEqual({ id: 'job-1', state: 'remote_succeeded', result: value });
  expect(exchange.mock.calls[0]![0].path).toBe('/owner/app/requests/job-1');
  exchange.mockResolvedValue(reply({ detail: 'still in progress' }, 202)); expect((await connector.result('job-1', context())).state).toBe('unknown');
  exchange.mockResolvedValue(reply({ error: 'failed despite 200' })); expect((await connector.result('job-1', context())).state).toBe('failed');
  exchange.mockResolvedValue(reply({ error: { unexpected: 'shape' } })); expect((await connector.result('job-1', context())).state).toBe('unknown');
  exchange.mockResolvedValue(reply(['custom-model-result'])); expect((await connector.result('job-1', context())).state).toBe('remote_succeeded');
});
it.each([{}, { request_id: '' }, { request_id: '../metadata' }, { request_id: 'http://other.example' }, null, []])('requires a safe task ID after submission, with unknown outcome for %s', async value => {
  const { connector, exchange } = fixture(); exchange.mockResolvedValue(reply(value));
  await expect(connector.submit({}, context())).rejects.toMatchObject({ outcome: 'unknown' }); expect(exchange).toHaveBeenCalledTimes(1);
});
it('requires polling response identity to match the exact requested task', async () => {
  const { connector, exchange } = fixture(); exchange.mockResolvedValue(reply({ request_id: 'another-job', status: 'COMPLETED' }));
  await expect(connector.poll('job-1', context())).rejects.toMatchObject({ code: 'REQUEST_ID_MISMATCH', outcome: 'not_applicable' });
  exchange.mockResolvedValue(reply({ status: 'IN_QUEUE' })); await expect(connector.poll('job-1', context())).rejects.toMatchObject({ outcome: 'not_applicable' });
});
it.each([400, 401, 403, 404, 422, 429, 500, 504])('never retries POST failure HTTP %s', async status => {
  const { connector, exchange } = fixture(); exchange.mockResolvedValue(reply({ detail: 'private diagnostic' }, status));
  await expect(connector.submit({}, context())).rejects.toMatchObject({ httpStatus: status, outcome: status < 500 ? 'rejected' : 'unknown' }); expect(exchange).toHaveBeenCalledTimes(1);
});
it('propagates a transport uncertainty without resubmission', async () => {
  const { connector, exchange } = fixture(); const error = new Error('transport failure'); exchange.mockRejectedValue(error);
  await expect(connector.submit({}, context())).rejects.toBe(error); expect(exchange).toHaveBeenCalledTimes(1);
});
it('captures input before awaiting the transport', async () => {
  const { connector, exchange } = fixture(); const input = { prompt: 'original' }; let release: (value: ReturnType<typeof reply>) => void = () => {};
  exchange.mockImplementation(async () => new Promise(resolve => { release = resolve; }));
  const pending = connector.submit(input, context()); input.prompt = 'changed'; release(reply({ request_id: 'job-1', status: 'IN_PROGRESS' }));
  expect((await pending).state).toBe('running'); expect(exchange.mock.calls[0]![0].body).toEqual({ prompt: 'original' });
});
it('validates endpoint, task IDs, JSON objects and cancellation before network execution', async () => {
  for (const endpoint of ['', 'one', '/owner/app', 'owner/../app', 'owner/%2e%2e/app', 'https://other.example/owner/app', 'owner/app?token=x', 'owner/app\\x']) expect(() => fixture(endpoint)).toThrow();
  const { connector, exchange } = fixture('owner/app');
  for (const id of ['', '../escape', 'job/other', 'job?token=x', 'a'.repeat(201)]) await expect(connector.poll(id, context())).rejects.toMatchObject({ outcome: 'not_sent' });
  await expect(connector.result('../escape', context())).rejects.toMatchObject({ outcome: 'not_sent' });
  await expect(connector.submit([] as unknown as JsonObject, context())).rejects.toMatchObject({ outcome: 'not_sent' });
  const abort = new AbortController(); abort.abort(); await expect(connector.submit({}, context({ signal: abort.signal }))).rejects.toMatchObject({ code: 'ABORTED', outcome: 'not_sent' });
  await expect(connector.poll('job-1', context({ signal: abort.signal }))).rejects.toMatchObject({ code: 'ABORTED', outcome: 'not_applicable' }); expect(exchange).not.toHaveBeenCalled();
});
