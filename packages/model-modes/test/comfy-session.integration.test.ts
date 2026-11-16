import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { ComfyProgressSession, ComfyUiConnector, NodeHttpTransport, NodeWebSocketTransport } from '../src/index.js';
import { context } from './support.js';

it('reconnects an actual loopback socket while polling the existing prompt and never submits a second job', async () => {
  let connections = 0; let histories = 0; const requests: string[] = []; const clients: string[] = [];
  const http = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`); response.setHeader('content-type', 'application/json');
    if (request.url === '/history/prompt-1') {
      histories++;
      response.end(JSON.stringify(connections >= 2 && histories >= 3 ? {
        'prompt-1': { status: { completed: true, status_str: 'success' }, outputs: { '1': { images: [{ filename: 'synthetic.png', subfolder: '', type: 'output' }] } } },
      } : {}));
    } else if (request.url === '/queue') response.end(JSON.stringify({ queue_running: [[0, 'prompt-1']], queue_pending: [] }));
    else { response.statusCode = 404; response.end('{}'); }
  });
  const ws = new WebSocketServer({ server: http });
  ws.on('connection', (socket, request) => {
    connections++; clients.push(request.url!);
    socket.send(JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 1, max: 2 } }));
    if (connections === 1) socket.close(1012, 'synthetic restart');
    else socket.send(JSON.stringify({ type: 'execution_success', data: { prompt_id: 'prompt-1' } }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening'); const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  try {
    const config = { tenantId: 'tenant-test', connectionId: 'connection-test', baseUrl: `http://127.0.0.1:${address.port}`, allowPrivateNetworks: true, allowInsecureHttp: true, timeoutMs: 500, maxInFlight: 1 };
    const connector = new ComfyUiConnector(new NodeHttpTransport(config), { workflow: { '1': { class_type: 'SyntheticNode', inputs: {} } }, mappings: [] });
    const session = new ComfyProgressSession(connector, new NodeWebSocketTransport(config), { maxReconnects: 1, reconnectDelayMs: 1, pollIntervalMs: 5, maxMonitorMs: 1000 });
    const actual = await session.watch('prompt-1', 'original-submission-key', context({ idempotencyKey: 'monitor-key' }));
    expect(actual).toMatchObject({ id: 'prompt-1', state: 'remote_succeeded', result: { files: [{ filename: 'synthetic.png', subfolder: '', type: 'output' }] } });
    expect(connections).toBe(2); expect(histories).toBeGreaterThanOrEqual(3);
    expect(clients).toEqual(['/ws?clientId=original-submission-key', '/ws?clientId=original-submission-key']);
    expect(requests.every(value => value === 'GET /history/prompt-1' || value === 'GET /queue')).toBe(true);
  } finally {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve())); http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  }
});
