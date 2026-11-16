import type { Json } from '@camery/model-modes';
import type { z } from 'zod';
import { digest, freeze, jsonCopy, MethodError } from './data.js';
import { outputValidator, Pack, Pin } from './schema.js';
import type { MethodPack, MethodPin } from './schema.js';
import { validateEvaluationSuite } from './evaluation.js';

export class MethodRegistry {
  private readonly entries = new Map<string, { pin: MethodPin; pack: MethodPack; output: z.ZodType }>();
  register(input: unknown): MethodPin {
    const parsed = Pack.safeParse(jsonCopy(input));
    if (!parsed.success) throw new MethodError('INVALID_PACK', 'method registration');
    const pack = parsed.data; const manifest = pack.manifest;
    if ((manifest.provenance.kind === 'original') !== (manifest.provenance.sources.length === 0) || [pack.rules, pack.examples, pack.cards].some(items => new Set(items.map(item => item.id)).size !== items.length) || new Set(manifest.inputKinds).size !== manifest.inputKinds.length || new Set(manifest.languages).size !== manifest.languages.length) throw new MethodError('INVALID_PACK', 'method metadata');
    const output = outputValidator(manifest.outputSchema);
    for (const example of pack.examples) if (!output.safeParse(example.output).success) throw new MethodError('INVALID_PACK', 'method example output');
    const suites = pack.evals.map(validateEvaluationSuite);
    if (new Set(suites.map(value => value.id)).size !== suites.length) throw new MethodError('INVALID_PACK', 'method evaluation identities');
    const pin = { id: manifest.id, version: manifest.version, digest: digest(pack) }; const key = `${pin.id}@${pin.version}`;
    const existing = this.entries.get(key);
    if (existing && existing.pin.digest !== pin.digest) throw new MethodError('VERSION_CONFLICT', 'method version');
    if (!existing) this.entries.set(key, { pin: freeze(pin), pack: freeze(pack), output });
    return freeze(jsonCopy(pin));
  }
  private entry(input: MethodPin) {
    const pin = Pin.safeParse(jsonCopy(input));
    if (!pin.success) throw new MethodError('INVALID_PIN', 'method resolution');
    const found = this.entries.get(`${pin.data.id}@${pin.data.version}`);
    if (!found || found.pin.digest !== pin.data.digest) throw new MethodError('PIN_MISMATCH', 'method resolution');
    return found;
  }
  resolve(pin: MethodPin): MethodPack { return freeze(jsonCopy(this.entry(pin).pack)); }
  validateOutput(pin: MethodPin, value: Json): boolean { return this.entry(pin).output.safeParse(jsonCopy(value)).success; }
  route(request: { stage: string; inputKind: string; language: string }, pins: readonly MethodPin[]): MethodPin {
    if (pins.length > 100 || new Set(pins.map(pin => `${pin.id}@${pin.version}`)).size !== pins.length) throw new MethodError('INVALID_ROUTE', 'method routing pins');
    const matches = pins.filter(pin => { const pack = this.entry(pin).pack.manifest; return pack.stage === request.stage && pack.inputKinds.includes(request.inputKind) && pack.languages.includes(request.language); });
    if (matches.length !== 1) throw new MethodError(matches.length ? 'AMBIGUOUS_ROUTE' : 'METHOD_NOT_FOUND', 'method routing');
    return freeze(jsonCopy(matches[0]!));
  }
}
