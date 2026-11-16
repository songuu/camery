import { expect, it, vi } from 'vitest';
import { AgentRegistry, ToolRegistry } from '../src/registry.js';
const object = { type: 'object' as const, properties: { text: { type: 'string' as const } }, required: ['text'], additionalProperties: false };
const tool = () => ({ name: 'source.read', version: '1.0.0', description: 'Read scoped source', inputSchema: object, outputSchema: object, effect: 'read' as const, objectType: 'source', reservation: { tokens: 0, costMicros: 0 }, currency: 'CNY' });
const agent = () => ({ id: 'research', version: '1.0.0', instructions: 'Propose only scoped candidates.', tools: [], methods: [], modelTier: 'deterministic' as const, writeKinds: ['story'], budget: { maxSteps: 8, maxTokens: 100, maxCostMicros: 0, currency: 'CNY' }, outputSchema: object });
it('pins strict MCP-compatible tools and detaches contracts without executing scripts', () => {
  const tools = new ToolRegistry(); const execute = vi.fn(); const definition = tool(); const pin = tools.register({ definition, resources: () => ['source-a'], execute });
  definition.description = 'mutated'; expect(tools.resolve(pin).definition.description).toBe('Read scoped source');
  expect(tools.toMcp(pin)).toEqual({ name: 'source.read', description: 'Read scoped source', inputSchema: object, outputSchema: object }); expect(execute).not.toHaveBeenCalled();
  expect(() => tools.resolve({ ...pin, digest: 'b'.repeat(64) })).toThrow('PIN_MISMATCH');
  expect(() => tools.register({ definition: tool(), resources: () => [], execute })).toThrow('TOOL_EXISTS');
  expect(() => tools.register({ definition: { ...tool(), inputSchema: { type: 'string' } } as never, resources: () => [], execute })).toThrow();
});
it('locks agent method/tool pins, contracts and budgets to a definition version', () => {
  const registry = new AgentRegistry(); const definition = { id: 'research', version: '1.0.0', instructions: 'Propose only scoped candidates.', tools: [], methods: [], modelTier: 'deterministic' as const, writeKinds: ['story'], budget: { maxSteps: 8, maxTokens: 100, maxCostMicros: 0, currency: 'CNY' }, outputSchema: object };
  const pin = registry.register(definition); definition.instructions = 'changed'; expect(registry.resolve(pin).instructions).toBe('Propose only scoped candidates.');
  expect(registry.validateOutput(pin, { text: 'ok' })).toBe(true); expect(registry.validateOutput(pin, { text: 1 })).toBe(false);
  expect(() => registry.register(definition)).toThrow('VERSION_CONFLICT'); expect(() => registry.resolve({ ...pin, version: '1.0.1' })).toThrow();
});
it('refuses duplicate grants, extra executable fields, invalid pins and unsafe budget numbers', () => {
  const registry = new AgentRegistry(); const pin = registry.register(agent()); expect(registry.register(agent())).toEqual(pin);
  for (const invalid of [{ ...agent(), tools: [pin, pin] }, { ...agent(), methods: [pin, pin] }, { ...agent(), writeKinds: ['story', 'story'] }, { ...agent(), script: 'execute arbitrary file' }, { ...agent(), budget: { ...agent().budget, maxTokens: Number.MAX_SAFE_INTEGER + 1 } }]) expect(() => registry.register(invalid)).toThrow();
  expect(() => registry.resolve({ ...pin, digest: 'invalid' })).toThrow('INVALID_PIN'); expect(() => registry.resolve({ ...pin, digest: 'b'.repeat(64) })).toThrow('PIN_MISMATCH');
});
it('rejects invalid host handlers and unsupported tool contracts at registration', () => {
  const tools = new ToolRegistry(); const host = { definition: tool(), resources: () => [], execute: vi.fn() };
  for (const invalid of [{ ...host, resources: false }, { ...host, execute: false }, { ...host, outputResources: false }, { ...host, definition: { ...tool(), effect: 'candidate' } }, { ...host, definition: { ...tool(), outputSchema: { type: 'string' } } }, { ...host, definition: { ...tool(), script: 'unsafe' } }]) expect(() => tools.register(invalid as never)).toThrow();
  const pin = tools.register(host); expect(tools.resolve(pin).validateInput({ text: 'valid' })).toBe(true); expect(tools.resolve(pin).validateInput({ text: false })).toBe(false); expect(tools.resolve(pin).validateOutput({ text: 'valid' })).toBe(true);
  expect(() => tools.resolve({ ...pin, digest: 'invalid' })).toThrow('INVALID_PIN'); expect(() => tools.resolve({ ...pin, version: '2.0.0' })).toThrow('PIN_MISMATCH');
});
