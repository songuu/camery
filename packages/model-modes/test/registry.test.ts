import { expect, it } from 'vitest';
import { ModelModeRegistry } from '../src/registry.js';
const evidence = <T>(value: T) => ({ value, source: 'fixture://synthetic-contract', modeVersion: '1.0.0', verification: 'documented', evaluationIds: [] as string[] });
const mode = () => ({ id: 'test-image', version: '1.0.0', kind: 'image', connector: { kind: 'comfyui', profile: 'workflow-v1' }, capabilities: {
  durationSeconds: evidence({ min: 1, max: 10 }), maxReferenceImages: evidence(2), firstFrame: evidence(true), lastFrame: evidence(false), nativeAudio: evidence(false), lipsync: evidence(null),
  aspectRatios: evidence(['16:9']), resolutions: evidence([{ width: 1280, height: 720 }]), inputSlots: evidence([{ name: 'identity', modality: 'image' }]), promptLimits: evidence({ unit: 'characters', softMax: 100, hardMax: 200 }), maxConcurrency: evidence(null),
}, compiler: { anchor: { sections: ['identity', 'anchorLighting', 'style'], separator: '\n', prefix: '' }, keyframe: { sections: ['action', 'dramaticLighting', 'camera'], separator: '\n', prefix: '' }, video: { sections: ['action', 'camera'], separator: '\n', prefix: '' } },
cost: evidence(null), quality: { passed: null, total: null, evaluationIds: [], commonFailures: [] } });
it('pins immutable versions and preserves old queued modes after a new release is registered', () => {
  const registry = new ModelModeRegistry(); const original = mode(); registry.register(original); const pin = registry.pin('test-image', '1.0.0');
  original.compiler.anchor.prefix = 'changed outside'; registry.register({ ...mode(), version: '2.0.0', capabilities: Object.fromEntries(Object.entries(mode().capabilities).map(([k, v]) => [k, { ...v, modeVersion: '2.0.0' }])), cost: { ...evidence(null), modeVersion: '2.0.0' } });
  expect(pin.digest).toHaveLength(64); expect(registry.resolve(pin).compiler.anchor?.prefix).toBe(''); expect(registry.pin('test-image', '2.0.0').digest).not.toBe(pin.digest);
  expect(() => registry.register({ ...mode(), connector: { kind: 'comfyui', profile: 'different' } })).toThrow();
  registry.register(mode()); expect(() => registry.pin('missing', '1.0.0')).toThrow(); expect(() => registry.resolve({ ...pin, digest: 'a'.repeat(64) })).toThrow();
});
it('keeps neutral anchor lighting out of dramatic keyframes, and orders references by declared importance', () => {
  const registry = new ModelModeRegistry(); registry.register(mode()); const pin = registry.pin('test-image', '1.0.0');
  const result = registry.compile(pin, { layer: 'keyframe', sections: { action: 'turns', dramaticLighting: 'hard side light', anchorLighting: 'neutral flat', camera: 'closeup' }, references: [{ id: 'second', slot: 'identity', rank: 2 }, { id: 'first', slot: 'identity', rank: 1 }] });
  expect(result.text).toBe('action: turns\ndramaticLighting: hard side light\ncamera: closeup'); expect(result.text).not.toContain('neutral'); expect(result.references.map(r => r.id)).toEqual(['first', 'second']); expect(result.modeDigest).toBe(pin.digest);
});
it('checks declared capabilities without turning unknown or unverified values into promises', () => {
  const registry = new ModelModeRegistry(); registry.register(mode()); const pin = registry.pin('test-image', '1.0.0');
  const basic = { layer: 'video' as const, sections: { action: 'walk' }, references: [] };
  expect(() => registry.compile(pin, { ...basic, startFrame: true, durationSeconds: 5, aspectRatio: '16:9', resolution: { width: 1280, height: 720 } })).not.toThrow();
  for (const patch of [{ endFrame: true }, { nativeAudio: true }, { lipsync: true }, { durationSeconds: 11 }, { aspectRatio: '1:1' }, { resolution: { width: 1, height: 1 } }, { references: [{ id: 'x', slot: 'wrong', rank: 1 }] }, { sections: { action: 'x'.repeat(201) } }]) expect(() => registry.compile(pin, { ...basic, ...patch })).toThrow();
  const uncertain = mode(); uncertain.capabilities.firstFrame.verification = 'unverified'; const other = new ModelModeRegistry(); other.register(uncertain);
  expect(() => other.compile(other.pin('test-image', '1.0.0'), { ...basic, startFrame: true })).toThrow();
});
it('rejects invalid provenance, falsely verified quality, duplicate recipes and mismatched capability versions', () => {
  for (const patch of [{ capabilities: { ...mode().capabilities, firstFrame: { ...evidence(true), modeVersion: '0.0.1' } } }, { capabilities: { ...mode().capabilities, firstFrame: { ...evidence(true), verification: 'locally_verified' } } }, { quality: { passed: 2, total: 1, evaluationIds: ['eval'], commonFailures: [] } }, { compiler: { anchor: { sections: ['identity', 'identity'], separator: '\n', prefix: '' } } }, { compiler: {} }, { connector: { kind: 'openai', profile: 'x' } }]) expect(() => new ModelModeRegistry().register({ ...mode(), ...patch })).toThrow();
});
it('reports soft prompt limits and measures UTF-8 byte limits without guessing token counts', () => {
  const definition = mode(); definition.capabilities.promptLimits.value = { unit: 'characters', softMax: 10, hardMax: 200 };
  const registry = new ModelModeRegistry(); registry.register(definition); const pin = registry.pin('test-image', '1.0.0');
  expect(registry.compile(pin, { layer: 'video', sections: { action: 'a long action' } }).warnings).toContain('PROMPT_SOFT_LIMIT');
  for (const unit of ['bytes', 'tokens'] as const) {
    const item = { ...mode(), capabilities: { ...mode().capabilities, promptLimits: evidence({ unit, softMax: null, hardMax: 12 }) } };
    const modes = new ModelModeRegistry(); modes.register(item);
    expect(() => modes.compile(modes.pin('test-image', '1.0.0'), { layer: 'video', sections: { action: '中文汉字' } })).toThrow();
  }
});
it('validates optional compiler layers, frame policies, duration bounds and mode recipes', () => {
  const registry = new ModelModeRegistry(); registry.register(mode()); const pin = registry.pin('test-image', '1.0.0');
  expect(() => registry.compile(pin, { layer: 'text', sections: { content: 'x' } })).toThrow();
  expect(() => registry.compile(pin, { layer: 'video', sections: { action: 'x' }, durationSeconds: .5 })).toThrow();
  expect(() => registry.compile(pin, { layer: 'video', sections: {}, references: [1, 2, 3].map(rank => ({ id: String(rank), rank, slot: 'identity' })) })).toThrow();
  expect(() => registry.compile(pin, { layer: 'unknown' as 'video', sections: {} })).toThrow();
  for (const compiler of [{ keyframe: { ...mode().compiler.keyframe, sections: ['anchorLighting'] } }, { video: { ...mode().compiler.video, sections: ['anchorLighting'] } }]) expect(() => new ModelModeRegistry().register({ ...mode(), compiler })).toThrow();
  const invalidCaps = [{ durationSeconds: evidence({ min: 10, max: 1 }) }, { inputSlots: evidence([{ name: 'x', modality: 'image' }, { name: 'x', modality: 'image' }]) }, { promptLimits: evidence({ unit: 'bytes', softMax: 10, hardMax: 1 }) }];
  for (const patch of invalidCaps) expect(() => new ModelModeRegistry().register({ ...mode(), capabilities: { ...mode().capabilities, ...patch } })).toThrow();
  const verified = { ...mode(), capabilities: { ...mode().capabilities, firstFrame: { ...evidence(true), verification: 'locally_verified', evaluationIds: ['eval-local'] } }, quality: { passed: 1, total: 2, evaluationIds: ['quality-eval'], commonFailures: ['artifact'] } };
  expect(() => new ModelModeRegistry().register(verified)).not.toThrow();
});
