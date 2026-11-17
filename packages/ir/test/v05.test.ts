import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { StoryboardPackage, toChangeSetJsonSchema, toJsonSchema, validatePackage } from '../src/index';
import { errorCodes, fixtureId as id, makePackage, makeSegment, mutate, row } from './fixtures';

describe('IR v0.5 canonical contract', () => {
  it('exports a strict, versioned JSON Schema', () => {
    const schema = toJsonSchema();
    expect(schema).toMatchObject({oneOf:[{type:'object',additionalProperties:false,properties:{schema_version:{const:'0.5.0-draft'}}},{type:'object',additionalProperties:false,properties:{schema_version:{const:'0.6.0-draft'}}}]});
    expect(JSON.stringify(schema)).toContain('0.5.0-draft');
    expect(StoryboardPackage.safeParse(makePackage()).success).toBe(true);
  });

  it('keeps the checked-in JSON Schema synchronized with Zod', () => {
    const stored: unknown = JSON.parse(readFileSync(new URL('../contracts/storyboard-package.schema.json', import.meta.url), 'utf8'));
    expect(stored).toEqual(toJsonSchema());
    const changeSchema: unknown = JSON.parse(readFileSync(new URL('../contracts/changeset.schema.json', import.meta.url), 'utf8'));
    expect(changeSchema).toEqual(toChangeSetJsonSchema());
  });

  it('rejects imported readable IDs and legacy dialogue semantics in canonical data', () => {
    expect(errorCodes(validatePackage(mutate(makePackage(), p => { p.shots[0]!.id = 'sh_legacy'; })))).toContain('SCHEMA');
    expect(errorCodes(validatePackage(mutate(makePackage(), p => {
      Object.assign(p.lines[0]!, { kind: 'dialogue' });
    })))).toContain('SCHEMA');
  });

  it.each(['on_screen', 'inner_monologue', 'off_screen', 'narration'] as const)('supports %s voice semantics', kind => {
    expect(errorCodes(validatePackage(mutate(makePackage(), p => { p.lines[0]!.kind = kind; })))).not.toContain('SCHEMA');
  });

  it('rejects duplicate IDs and dangling references with paths', () => {
    const report = validatePackage(mutate(makePackage(), p => {
      p.shots[1]!.id = p.shots[0]!.id;
      p.scenes[0]!.location_id = id('missing-location');
    }));
    expect(errorCodes(report)).toEqual(expect.arrayContaining(['DUPLICATE_ID', 'MISSING_REFERENCE']));
    expect(report.errors.find(e => e.code === 'MISSING_REFERENCE')?.where).toBe('/scenes/0/location_id');
  });

  it('checks scene ownership and declared scope', () => {
    const report = validatePackage(mutate(makePackage(), p => {
      p.shots[0]!.beat_refs = [id('b_arrive')];
      p.project.scope.expected_scene_count++;
    }));
    expect(errorCodes(report)).toEqual(expect.arrayContaining(['SCENE_OWNERSHIP', 'SCOPE']));
  });

  it('permits planned shots without fabricated media takes', () => {
    expect(validatePackage(makePackage()).valid).toBe(true);
    expect(errorCodes(validatePackage(makePackage(), { stage: 'delivery' }))).toContain('TAKE_COVERAGE');
  });

  it('allows a generated segment to serve nonadjacent shots', () => {
    const pkg = mutate(makePackage(), p => {
      p.segments.push(makeSegment());
      p.assets.push({
        id: id('video'), version: 1, media_type: 'video', description: 'reaction take', origin: 'generated',
        consent_ref: null, status: 'ready', file: { path: 'video/take.mp4', sha256: 'b'.repeat(64), mime_type: 'video/mp4' },
        measured_seconds: 12, quality_tier: 'draft', derived_from: null,
        generated_from_segment: { id: id('seg_1'), version: 1 },
      });
      for (const [shot, start, end] of [['sh_1', 0.5, 4.5], ['sh_3', 6, 11]] as const) {
        p.shot_takes.push({
          id: id('take-' + shot), version: 1, shot_id: id(shot), segment_revision_id: { id: id('seg_1'), version: 1 },
          media_asset_id: { id: id('video'), version: 1 }, source_in: start, source_out: end,
          timeline_offset: 0, playback_rate: { numerator: 1, denominator: 1 },
          audio_policy: 'mute', visible_speaker_id: null, status: 'adopted',
        });
      }
    });
    expect(validatePackage(pkg)).toMatchObject({ valid: true });
  });

  it('rejects stale material revisions, handles and unmeasured takes', () => {
    const p = mutate(makePackage(), p => {
      p.segments.push(makeSegment());
      p.shot_takes.push({
        id: id('take'), version: 1, shot_id: id('sh_1'), segment_revision_id: { id: id('seg_1'), version: 7 },
        media_asset_id: { id: id('as_img'), version: 1 }, source_in: 0, source_out: 4,
        timeline_offset: 0, playback_rate: { numerator: 1, denominator: 1 },
        audio_policy: 'keep', visible_speaker_id: null, status: 'adopted',
      });
    });
    expect(errorCodes(validatePackage(p))).toEqual(expect.arrayContaining(['STALE_REFERENCE', 'TAKE_MEDIA', 'TAKE_RANGE']));
  });

  it('validates strict segment handles and quality tiers', () => {
    const pkg = mutate(makePackage(), p => {
      p.segments.push(makeSegment({ handles: { head: 10, tail: 10 } }));
      Object.assign(row(p.assets, 'as_img'), { quality_tier: 'ultra' });
    });
    expect(errorCodes(validatePackage(pkg))).toContain('SCHEMA');
  });
});
