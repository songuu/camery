import { jsonValue, name, object, parseJson, responseJson } from '../json.js';
import { ModelError } from '../types.js';
import type { CallContext, HttpTransport, Json, JsonObject, Outcome, RemoteJob } from '../types.js';

export interface ComfyParameterMapping { parameter: string; nodeId: string; inputPath: string[] }
export interface ComfyConnectorOptions { workflow: JsonObject; mappings: ComfyParameterMapping[] }
export interface ComfyOutputFile { filename: string; subfolder: string; type: 'output' | 'temp' }
export interface ComfyDownload { bytes: Uint8Array; contentType: string | null }
export type ComfyProgress =
  | { kind: 'progress'; value: number; max: number; node: string | null }
  | { kind: 'executing'; node: string }
  | { kind: 'history_required' }
  | { kind: 'failed'; reason: 'execution_error' | 'execution_interrupted' };

function identifier(value: unknown, operation: string, outcome: Outcome = 'not_sent'): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new ModelError('INVALID_INPUT', operation, outcome);
}
function field(value: unknown): asserts value is string {
  name(value, 'comfy mapping field');
  if (['__proto__', 'prototype', 'constructor', '.', '..'].includes(value) || /[/\\]/.test(value)) throw new ModelError('INVALID_WORKFLOW', 'comfy mapping field', 'not_sent');
}
function snapshotContext(input: CallContext, operation: string, outcome: Outcome): CallContext {
  const value = { tenantId: input.tenantId, connectionId: input.connectionId, modeDigest: input.modeDigest, idempotencyKey: input.idempotencyKey, signal: input.signal };
  name(value.tenantId, 'comfy tenant'); name(value.connectionId, 'comfy connection'); name(value.idempotencyKey, 'comfy idempotency key');
  if (!/^[a-f0-9]{64}$/.test(value.modeDigest) || !(value.signal instanceof AbortSignal)) throw new ModelError('INVALID_INPUT', operation, 'not_sent');
  if (value.signal.aborted) throw new ModelError('ABORTED', operation, outcome);
  return Object.freeze(value);
}
function active(context: CallContext, operation: string): void {
  if (context.signal.aborted) throw new ModelError('ABORTED', operation, 'not_applicable');
}
function outputFile(input: unknown, operation: string, outcome: Outcome): ComfyOutputFile {
  const value = object(jsonValue(input), operation, outcome);
  const filename = value['filename']; const subfolder = value['subfolder']; const type = value['type'];
  // oxlint-disable-next-line eslint/no-control-regex -- Reject control characters at this input boundary.
  if (typeof filename !== 'string' || !filename || filename.length > 255 || /[/\\%:\x00-\x1f\x7f]/.test(filename) || filename === '.' || filename === '..' || typeof subfolder !== 'string' || subfolder.length > 1000 || /[\\%:\x00-\x1f\x7f]/.test(subfolder) || subfolder.startsWith('/') || subfolder.split('/').some(part => part === '.' || part === '..') || (type !== 'output' && type !== 'temp')) throw new ModelError('INVALID_OUTPUT', operation, outcome);
  return { filename, subfolder, type };
}
function mediaFiles(outputs: JsonObject): ComfyOutputFile[] {
  const files: ComfyOutputFile[] = [];
  for (const value of Object.values(outputs)) {
    const node = object(value, 'comfy.poll outputs', 'not_applicable');
    for (const kind of ['images', 'gifs', 'audio']) if (node[kind] !== undefined) {
      const items = node[kind];
      if (!Array.isArray(items)) throw new ModelError('INVALID_OUTPUT', 'comfy.poll outputs', 'not_applicable');
      for (const item of items) files.push(outputFile(item, 'comfy.poll outputs', 'not_applicable'));
    }
  }
  return files;
}

/** Workflow templates are trusted configuration. Only declared existing input fields are substituted, never evaluated. */
export class ComfyUiConnector {
  private readonly workflow: JsonObject;
  private readonly mappings: ComfyParameterMapping[];
  constructor(private readonly transport: HttpTransport, options: ComfyConnectorOptions) {
    this.workflow = object(jsonValue(options.workflow), 'comfy workflow', 'not_sent');
    const nodes = Object.entries(this.workflow);
    if (!nodes.length) throw new ModelError('INVALID_WORKFLOW', 'comfy workflow', 'not_sent');
    for (const [id, value] of nodes) {
      identifier(id, 'comfy node ID');
      const node = object(value, 'comfy workflow node', 'not_sent'); name(node['class_type'], 'comfy node class'); object(node['inputs'] ?? null, 'comfy workflow inputs', 'not_sent');
    }
    if (!Array.isArray(options.mappings)) throw new ModelError('INVALID_WORKFLOW', 'comfy mappings', 'not_sent');
    const mappings = jsonValue(options.mappings) as Json[];
    this.mappings = [];
    for (const item of mappings) {
      const mapping = object(item, 'comfy mapping', 'not_sent');
      const parameter = mapping['parameter']; const nodeId = mapping['nodeId']; const inputPath = mapping['inputPath'];
      identifier(parameter, 'comfy parameter'); identifier(nodeId, 'comfy mapping node');
      if (!Array.isArray(inputPath) || !inputPath.length || !inputPath.every(part => typeof part === 'string')) throw new ModelError('INVALID_WORKFLOW', 'comfy mapping path', 'not_sent');
      const path = inputPath as string[]; path.forEach(field);
      const entry = { parameter, nodeId, inputPath: [...path] };
      this.target(this.workflow, entry);
      if (this.mappings.some(previous => previous.nodeId === nodeId && previous.inputPath.slice(0, Math.min(previous.inputPath.length, path.length)).every((part, index) => part === path[index]))) throw new ModelError('INVALID_WORKFLOW', 'comfy overlapping mappings', 'not_sent');
      this.mappings.push(entry);
    }
  }
  private target(workflow: JsonObject, mapping: ComfyParameterMapping): { owner: JsonObject; field: string } {
    const node = object(workflow[mapping.nodeId] ?? null, 'comfy mapping node', 'not_sent');
    let owner = object(node['inputs'] ?? null, 'comfy mapping inputs', 'not_sent');
    for (const part of mapping.inputPath.slice(0, -1)) owner = object(owner[part] ?? null, 'comfy mapping traversal', 'not_sent');
    const last = mapping.inputPath.at(-1)!;
    if (!Object.hasOwn(owner, last)) throw new ModelError('INVALID_WORKFLOW', 'comfy mapping target', 'not_sent');
    return { owner, field: last };
  }
  compile(parameters: JsonObject): JsonObject {
    const values = object(jsonValue(parameters), 'comfy parameters', 'not_sent');
    const expected = new Set(this.mappings.map(mapping => mapping.parameter));
    if (Object.keys(values).length !== expected.size || [...expected].some(parameter => !Object.hasOwn(values, parameter))) throw new ModelError('INVALID_INPUT', 'comfy parameters', 'not_sent');
    const compiled = object(jsonValue(this.workflow), 'comfy workflow', 'not_sent');
    for (const mapping of this.mappings) {
      const target = this.target(compiled, mapping); target.owner[target.field] = jsonValue(values[mapping.parameter]);
    }
    return compiled;
  }
  async submit(parameters: JsonObject, context: CallContext): Promise<RemoteJob> {
    const prompt = this.compile(parameters); const ctx = snapshotContext(context, 'comfy.submit', 'not_sent');
    const raw = await this.transport.exchange({ method: 'POST', path: '/prompt', body: { prompt, client_id: ctx.idempotencyKey }, effect: 'submit', responseType: 'json' }, ctx);
    const value = object(responseJson(raw, 'comfy.submit', 'submit'), 'comfy.submit', 'unknown');
    const id = value['prompt_id'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new ModelError('INVALID_RESPONSE', 'comfy.submit ID', 'unknown');
    const errors = value['node_errors'];
    if (errors !== undefined && (errors === null || typeof errors !== 'object' || Array.isArray(errors))) throw new ModelError('INVALID_RESPONSE', 'comfy.submit node errors', 'unknown');
    // Partial validation can still enqueue good output nodes; retaining the ID avoids a duplicate submission.
    if ((errors && Object.keys(errors).length) || value['error']) return { id, state: 'unknown', result: { diagnostic: 'NODE_ERRORS' } };
    return { id, state: 'queued' };
  }
  async poll(promptId: string, context: CallContext): Promise<RemoteJob> {
    identifier(promptId, 'comfy.poll ID'); const ctx = snapshotContext(context, 'comfy.poll', 'not_applicable');
    const history = object(responseJson(await this.transport.exchange({ method: 'GET', path: `/history/${encodeURIComponent(promptId)}`, effect: 'read', responseType: 'json' }, ctx), 'comfy.poll', 'read'), 'comfy.poll history', 'not_applicable');
    if (Object.hasOwn(history, promptId)) {
      const entry = object(history[promptId]!, 'comfy.poll entry', 'not_applicable');
      const statusValue = entry['status'];
      if (statusValue === null || typeof statusValue !== 'object' || Array.isArray(statusValue)) return { id: promptId, state: 'unknown' };
      const messages = statusValue['messages'];
      if (statusValue['status_str'] === 'error' || (Array.isArray(messages) && messages.some(message => Array.isArray(message) && (message[0] === 'execution_error' || message[0] === 'execution_interrupted')))) return { id: promptId, state: 'failed' };
      if (statusValue['status_str'] !== 'success' || statusValue['completed'] !== true) return { id: promptId, state: 'unknown' };
      const outputs = object(entry['outputs'] ?? null, 'comfy.poll outputs', 'not_applicable'); const files = mediaFiles(outputs);
      if (!files.length) return { id: promptId, state: 'unknown' };
      return { id: promptId, state: 'remote_succeeded', result: jsonValue({ outputs, files }) };
    }
    active(ctx, 'comfy.poll queue');
    const queue = object(responseJson(await this.transport.exchange({ method: 'GET', path: '/queue', effect: 'read', responseType: 'json' }, ctx), 'comfy.poll queue', 'read'), 'comfy.poll queue', 'not_applicable');
    const running = queue['queue_running']; const pending = queue['queue_pending'];
    if (!Array.isArray(running) || !Array.isArray(pending)) throw new ModelError('INVALID_RESPONSE', 'comfy.poll queue', 'not_applicable');
    const contains = (items: Json[]): boolean => items.some(item => Array.isArray(item) && item[1] === promptId);
    return { id: promptId, state: contains(running) ? 'running' : contains(pending) ? 'queued' : 'unknown' };
  }
  async download(file: ComfyOutputFile, context: CallContext): Promise<ComfyDownload> {
    const descriptor = outputFile(file, 'comfy.download', 'not_sent'); const ctx = snapshotContext(context, 'comfy.download', 'not_applicable');
    const query = new URLSearchParams({ ...descriptor });
    const reply = await this.transport.exchange({ method: 'GET', path: `/view?${query.toString()}`, effect: 'read', responseType: 'bytes' }, ctx);
    if (reply.status < 200 || reply.status >= 300) responseJson(reply, 'comfy.download', 'read');
    if (reply.body.kind !== 'bytes') throw new ModelError('INVALID_RESPONSE', 'comfy.download bytes', 'not_applicable');
    const bytes = Buffer.from(reply.body.base64, 'base64');
    if (!bytes.length || bytes.toString('base64') !== reply.body.base64) throw new ModelError('INVALID_RESPONSE', 'comfy.download bytes', 'not_applicable');
    return { bytes: new Uint8Array(bytes), contentType: reply.contentType };
  }
  async health(context: CallContext): Promise<{ reachable: true; devices: number }> {
    const ctx = snapshotContext(context, 'comfy.health', 'not_applicable');
    const value = object(responseJson(await this.transport.exchange({ method: 'GET', path: '/system_stats', effect: 'read', responseType: 'json' }, ctx), 'comfy.health', 'read'), 'comfy.health', 'not_applicable');
    const devices = value['devices'];
    if (!Array.isArray(devices) || devices.some(device => device === null || typeof device !== 'object' || Array.isArray(device) || typeof device['name'] !== 'string' || typeof device['type'] !== 'string')) throw new ModelError('INVALID_RESPONSE', 'comfy.health devices', 'not_applicable');
    return { reachable: true, devices: devices.length };
  }
}

/** WebSocket events are progress hints. Even execution_success requires a later authoritative history read. */
export function decodeComfyProgress(message: unknown, expectedPromptId: string): ComfyProgress | null {
  identifier(expectedPromptId, 'comfy.progress ID');
  if (typeof message !== 'string') return null;
  const frame = object(parseJson(message, 'comfy.progress', 'not_applicable'), 'comfy.progress', 'not_applicable');
  if (typeof frame['type'] !== 'string' || !['progress', 'executing', 'execution_success', 'execution_error', 'execution_interrupted'].includes(frame['type'])) return null;
  const data = object(frame['data'] ?? null, 'comfy.progress data', 'not_applicable');
  if (data['prompt_id'] !== expectedPromptId) return null;
  if (frame['type'] === 'execution_error' || frame['type'] === 'execution_interrupted') return { kind: 'failed', reason: frame['type'] };
  if (frame['type'] === 'execution_success' || (frame['type'] === 'executing' && data['node'] === null)) return { kind: 'history_required' };
  if (frame['type'] === 'executing') { identifier(data['node'], 'comfy.progress node', 'not_applicable'); return { kind: 'executing', node: data['node'] }; }
  const value = data['value']; const max = data['max']; const node = data['node'] ?? null;
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof max !== 'number' || !Number.isFinite(max) || value < 0 || max <= 0 || value > max) throw new ModelError('INVALID_RESPONSE', 'comfy.progress range', 'not_applicable');
  if (node !== null) identifier(node, 'comfy.progress node', 'not_applicable');
  return { kind: 'progress', value, max, node };
}
