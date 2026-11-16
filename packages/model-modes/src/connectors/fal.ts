import { jsonValue, object, responseJson } from '../json.js';
import { ModelError } from '../types.js';
import type { CallContext, HttpTransport, Json, JsonObject, Outcome, RemoteJob } from '../types.js';

function jobId(value: unknown, operation: string, outcome: Outcome): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new ModelError('INVALID_REQUEST_ID', operation, outcome);
  return value;
}
function failureState(value: Json): 'failed' | 'unknown' | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of ['error', 'error_type']) {
    const detail = value[key];
    if (detail !== undefined && detail !== null && detail !== '') return typeof detail === 'string' ? 'failed' : 'unknown';
  }
  return null;
}
function state(value: JsonObject): RemoteJob['state'] {
  const failure = failureState(value); if (failure) return failure;
  if (value['status'] === 'IN_QUEUE') return 'queued';
  if (value['status'] === 'IN_PROGRESS') return 'running';
  // COMPLETED includes failed/cancelled requests. Only a separate successful result retrieval establishes remote success.
  return 'unknown';
}

export class FalQueueConnector {
  private readonly endpoint: string;
  private readonly app: string;
  constructor(private readonly transport: HttpTransport, options: { endpoint: string }) {
    const endpoint = options.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length > 200 || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(endpoint) || endpoint.split('/').some(part => part === '.' || part === '..')) throw new ModelError('INVALID_INPUT', 'fal.endpoint', 'not_sent');
    this.endpoint = '/' + endpoint; this.app = '/' + endpoint.split('/').slice(0, 2).join('/');
  }
  async submit(input: JsonObject, context: CallContext): Promise<RemoteJob> {
    const body = object(jsonValue(input), 'fal.submit input', 'not_sent');
    if (context.signal.aborted) throw new ModelError('ABORTED', 'fal.submit', 'not_sent');
    const reply = await this.transport.exchange({ method: 'POST', path: this.endpoint, body, effect: 'submit', responseType: 'json' }, context);
    const value = object(responseJson(reply, 'fal.submit', 'submit'), 'fal.submit', 'unknown');
    return { id: jobId(value['request_id'], 'fal.submit', 'unknown'), state: state(value) };
  }
  async poll(id: string, context: CallContext): Promise<RemoteJob> {
    const stableId = jobId(id, 'fal.poll', 'not_sent');
    if (context.signal.aborted) throw new ModelError('ABORTED', 'fal.poll', 'not_applicable');
    const reply = await this.transport.exchange({ method: 'GET', path: `${this.app}/requests/${stableId}/status`, effect: 'read', responseType: 'json' }, context);
    const value = object(responseJson(reply, 'fal.poll', 'read'), 'fal.poll', 'not_applicable');
    if (jobId(value['request_id'], 'fal.poll', 'not_applicable') !== stableId) throw new ModelError('REQUEST_ID_MISMATCH', 'fal.poll', 'not_applicable');
    return { id: stableId, state: state(value) };
  }
  async result(id: string, context: CallContext): Promise<RemoteJob> {
    const stableId = jobId(id, 'fal.result', 'not_sent');
    if (context.signal.aborted) throw new ModelError('ABORTED', 'fal.result', 'not_applicable');
    const reply = await this.transport.exchange({ method: 'GET', path: `${this.app}/requests/${stableId}`, effect: 'read', responseType: 'json' }, context);
    const value = responseJson(reply, 'fal.result', 'read');
    if (reply.status !== 200) return { id: stableId, state: 'unknown' };
    return { id: stableId, state: failureState(value) ?? 'remote_succeeded', result: value };
  }
}
