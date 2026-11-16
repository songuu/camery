import { z } from 'zod';
import { digest, jsonValue } from './json.js';
import { ModelError } from './types.js';
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const verification = z.enum(['unverified', 'documented', 'locally_verified']);
const evidence = <T extends z.ZodType>(schema: T) => z.strictObject({ value: schema.nullable(), source: z.string().min(1), modeVersion: version, verification, evaluationIds: z.array(z.string().min(1)) })
  .refine(value => value.verification !== 'locally_verified' || value.evaluationIds.length > 0, 'Local verification requires evaluation evidence');
const size = z.strictObject({ width: z.int().positive(), height: z.int().positive() });
const section = z.enum(['identity', 'appearance', 'anchorLighting', 'action', 'expression', 'camera', 'dramaticLighting', 'style', 'instructions', 'content']);
const recipe = z.strictObject({ sections: z.array(section).min(1).refine(values => new Set(values).size === values.length), separator: z.string().max(20), prefix: z.string().max(1000) });
export const ModeDefinition = z.strictObject({
  id: slug, version, kind: z.enum(['llm', 'image', 'video', 'tts', 'lipsync']), connector: z.strictObject({ kind: z.enum(['openai', 'comfyui', 'fal']), profile: slug }),
  capabilities: z.strictObject({
    durationSeconds: evidence(z.strictObject({ min: z.number().positive(), max: z.number().positive() }).refine(value => value.min <= value.max)),
    maxReferenceImages: evidence(z.int().nonnegative()), firstFrame: evidence(z.boolean()), lastFrame: evidence(z.boolean()), nativeAudio: evidence(z.boolean()), lipsync: evidence(z.boolean()),
    aspectRatios: evidence(z.array(z.string().regex(/^\d+:\d+$/))), resolutions: evidence(z.array(size)),
    inputSlots: evidence(z.array(z.strictObject({ name: slug, modality: z.enum(['image', 'audio', 'video', 'text']) })).refine(values => new Set(values.map(v => v.name)).size === values.length)),
    promptLimits: evidence(z.strictObject({ unit: z.enum(['characters', 'tokens', 'bytes']), softMax: z.int().positive().nullable(), hardMax: z.int().positive().nullable() }).refine(value => value.softMax === null || value.hardMax === null || value.softMax <= value.hardMax)),
    maxConcurrency: evidence(z.int().positive()),
  }),
  compiler: z.strictObject({ anchor: recipe.optional(), keyframe: recipe.optional(), video: recipe.optional(), text: recipe.optional() }).refine(value => Object.keys(value).length > 0),
  cost: evidence(z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/), unit: z.enum(['token', 'image', 'second', 'request']), amount: z.string().regex(/^\d+(?:\.\d+)?$/) })),
  quality: z.strictObject({ passed: z.int().nonnegative().nullable(), total: z.int().positive().nullable(), evaluationIds: z.array(z.string().min(1)), commonFailures: z.array(z.string().min(1)) })
    .refine(value => value.passed === null && value.total === null || value.passed !== null && value.total !== null && value.passed <= value.total && value.evaluationIds.length > 0),
}).superRefine((mode, ctx) => {
  for (const value of [...Object.values(mode.capabilities), mode.cost]) if (value.modeVersion !== mode.version) ctx.addIssue({ code: 'custom', message: 'Evidence applies to a different mode version' });
  if ((mode.kind === 'llm') !== (mode.connector.kind === 'openai')) ctx.addIssue({ code: 'custom', message: 'Connector kind does not support this mode kind' });
  if (mode.compiler.keyframe?.sections.includes('anchorLighting') || mode.compiler.video?.sections.includes('anchorLighting')) ctx.addIssue({ code: 'custom', message: 'Neutral anchor lighting cannot leak to dramatic output' });
});
export type ModeDefinition = z.infer<typeof ModeDefinition>;
export interface ModePin { id: string; version: string; digest: string }
const PromptInput = z.strictObject({ layer: z.enum(['anchor', 'keyframe', 'video', 'text']), sections: z.partialRecord(section, z.string()), references: z.array(z.strictObject({ id: z.string().min(1), slot: slug, rank: z.int().nonnegative() })).default([]),
  startFrame: z.boolean().optional(), endFrame: z.boolean().optional(), nativeAudio: z.boolean().optional(), lipsync: z.boolean().optional(), durationSeconds: z.number().positive().optional(), aspectRatio: z.string().optional(), resolution: size.optional() });
type PromptInput = z.input<typeof PromptInput>;
function declared<T>(item: { value: T | null; verification: string }): T {
  if (item.value === null || item.verification === 'unverified') throw new ModelError('CAPABILITY_UNKNOWN', 'prompt compile', 'not_sent');
  return item.value;
}
/** Installed content releases are immutable. A pin is resolved against the trusted registry, never a client definition. */
export class ModelModeRegistry {
  private readonly releases = new Map<string, ModeDefinition>();
  register(input: unknown): void {
    const parsed = ModeDefinition.safeParse(jsonValue(input));
    if (!parsed.success) throw new ModelError('INVALID_MODE', 'mode registration', 'not_sent');
    const key = `${parsed.data.id}:${parsed.data.version}`; const previous = this.releases.get(key);
    if (previous && digest(previous) !== digest(parsed.data)) throw new ModelError('MODE_VERSION_CONFLICT', 'mode registration', 'not_sent');
    this.releases.set(key, parsed.data);
  }
  pin(id: string, version: string): Readonly<ModePin> {
    const mode = this.releases.get(`${id}:${version}`);
    if (!mode) throw new ModelError('MODE_NOT_FOUND', 'mode pin', 'not_sent');
    return Object.freeze({ id, version, digest: digest(mode) });
  }
  resolve(pin: ModePin): ModeDefinition {
    const mode = this.releases.get(`${pin.id}:${pin.version}`);
    if (!mode || digest(mode) !== pin.digest) throw new ModelError('MODE_PIN_MISMATCH', 'mode resolution', 'not_sent');
    return structuredClone(mode);
  }
  compile(pin: ModePin, input: PromptInput) {
    const mode = this.resolve(pin); const parsed = PromptInput.safeParse(jsonValue(input));
    if (!parsed.success) throw new ModelError('INVALID_INPUT', 'prompt compile', 'not_sent');
    const request = parsed.data; const recipe = mode.compiler[request.layer];
    if (!recipe) throw new ModelError('UNSUPPORTED_LAYER', 'prompt compile', 'not_sent');
    const caps = mode.capabilities;
    for (const [wanted, cap] of [[request.startFrame, caps.firstFrame], [request.endFrame, caps.lastFrame], [request.nativeAudio, caps.nativeAudio], [request.lipsync, caps.lipsync]] as const) if (wanted && !declared(cap)) throw new ModelError('UNSUPPORTED_CAPABILITY', 'prompt compile', 'not_sent');
    if (request.durationSeconds !== undefined) { const range = declared(caps.durationSeconds); if (request.durationSeconds < range.min || request.durationSeconds > range.max) throw new ModelError('DURATION_LIMIT', 'prompt compile', 'not_sent'); }
    if (request.aspectRatio !== undefined && !declared(caps.aspectRatios).includes(request.aspectRatio)) throw new ModelError('UNSUPPORTED_RATIO', 'prompt compile', 'not_sent');
    if (request.resolution !== undefined && !declared(caps.resolutions).some(size => size.width === request.resolution!.width && size.height === request.resolution!.height)) throw new ModelError('UNSUPPORTED_RESOLUTION', 'prompt compile', 'not_sent');
    if (request.references.length) {
      if (request.references.length > declared(caps.maxReferenceImages)) throw new ModelError('REFERENCE_LIMIT', 'prompt compile', 'not_sent');
      const slots = declared(caps.inputSlots);
      if (request.references.some(ref => !slots.some(slot => slot.name === ref.slot && slot.modality === 'image'))) throw new ModelError('UNSUPPORTED_SLOT', 'prompt compile', 'not_sent');
    }
    const text = recipe.prefix + recipe.sections.filter(key => request.sections[key] !== undefined).map(key => `${key}: ${request.sections[key]}`).join(recipe.separator);
    const limits = mode.capabilities.promptLimits;
    const warnings: string[] = [];
    if (limits.value !== null && limits.verification !== 'unverified') {
      if (limits.value.unit === 'tokens' && (limits.value.hardMax !== null || limits.value.softMax !== null)) throw new ModelError('TOKENIZER_REQUIRED', 'prompt length', 'not_sent');
      // The capability declares code-point characters, rather than grapheme clusters.
      const length = limits.value.unit === 'bytes' ? Buffer.byteLength(text) : Array.from(text).length;
      if (limits.value.hardMax !== null && length > limits.value.hardMax) throw new ModelError('PROMPT_LIMIT', 'prompt length', 'not_sent');
      if (limits.value.softMax !== null && length > limits.value.softMax) warnings.push('PROMPT_SOFT_LIMIT');
    }
    return { text, references: request.references.toSorted((a, b) => a.rank - b.rank), modeDigest: pin.digest, layer: request.layer, warnings };
  }
}
