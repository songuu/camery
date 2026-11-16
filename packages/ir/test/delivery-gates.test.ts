import { expect, it } from 'vitest';
import { validatePackage } from '../src/index';
import { errorCodes, fixtureId as id, makePackage, makeProductionPackage, mutate, row, warningCodes } from './fixtures';

it('requires an adopted revision and declared-ready targets only for delivery', () => {
  const source = makeProductionPackage(); expect(validatePackage(source, { stage: 'delivery' }).valid).toBe(true);
  const candidate = mutate(source, p => { p.revision.status = 'candidate'; });
  expect(validatePackage(candidate).valid).toBe(true);
  expect(errorCodes(validatePackage(candidate, { stage: 'delivery' }))).toContain('DELIVERY_REVISION');
  const planned = mutate(source, p => { p.renditions[0]!.readiness = 'planned'; });
  expect(validatePackage(planned).valid).toBe(true);
  expect(errorCodes(validatePackage(planned, { stage: 'delivery' }))).toContain('RENDITION_READINESS');
});
it('rejects consumed planned references without blocking unused candidate plans', () => {
  const source = makeProductionPackage();
  const planned = mutate(source, p => { p.audio_cues[0]!.asset_ref_ids.push(id('ar_voice')); });
  expect(validatePackage(planned).valid).toBe(true);
  expect(errorCodes(validatePackage(planned, { stage: 'delivery' }))).toContain('DELIVERY_REFERENCE');
  expect(validatePackage(source, { stage: 'delivery' }).valid).toBe(true);
  expect(warningCodes(validatePackage(source))).toContain('PLANNED_MEDIA');
});
it('does not treat an empty episode or a content-free rendition as a deliverable', () => {
  const episode = mutate(makeProductionPackage(), p => {
    p.episodes.push({ ...p.episodes[0]!, id: id('empty-episode'), order_key: 'z9' }); p.project.scope.expected_episode_count++;
  });
  expect(validatePackage(episode).valid).toBe(true);
  expect(errorCodes(validatePackage(episode, { stage: 'delivery' }))).toContain('EPISODE_CONTENT');
  for (const kind of ['audio', 'video'] as const) {
    const target = mutate(makeProductionPackage(), p => {
      const identity = { id: id('empty-target'), version: 1, label: 'empty output', readiness: 'ready' as const };
      p.renditions.push(kind === 'audio' ? { ...identity, kind } : { ...identity, kind, aspect_ratio: '16:9' });
      p.beats.forEach(beat => { beat.required = false; }); p.project.scope.expected_required_beat_count = 0;
    });
    expect(validatePackage(target).valid).toBe(true);
    expect(errorCodes(validatePackage(target, { stage: 'delivery' }))).toContain('RENDITION_CONTENT');
  }
});
it('allows an empty planning skeleton but requires a delivery episode and target', () => {
  const empty = mutate(makePackage(), p => {
    p.episodes = []; p.scenes = []; p.beats = []; p.lines = []; p.shots = []; p.panels = []; p.audio_tracks = []; p.audio_cues = []; p.renditions = [];
    p.appearances.forEach(appearance => { appearance.scene_ids = []; });
    p.project.scope = { ...p.project.scope, expected_episode_count: 0, expected_scene_count: 0, expected_required_beat_count: 0 };
  });
  expect(validatePackage(empty).valid).toBe(true);
  expect(errorCodes(validatePackage(empty, { stage: 'delivery' }))).toEqual(expect.arrayContaining(['DELIVERY_CONTENT', 'DELIVERY_TARGETS']));
});
it('preserves declaration warnings for planned media, estimated timing and incomplete source captures', () => {
  const source = mutate(makePackage(), p => { p.sources[0]!.capture_state = 'partial'; p.sources[0]!.coverage = 'partial'; p.sources[0]!.selected_content = null; });
  expect(validatePackage(source).valid).toBe(true);
  expect(warningCodes(validatePackage(source))).toEqual(expect.arrayContaining(['PLANNED_MEDIA', 'ESTIMATED_TIMING', 'REFERENCE_ONLY']));
});
it('rejects direct self replacement even when its beat is otherwise covered', () => {
  const source = mutate(makeProductionPackage(), p => { p.adaptation_decisions.push({ id: id('self-replace'), version: 1, rendition_id: null, affected_beat_ids: [p.beats[0]!.id], replacement_beat_ids: [p.beats[0]!.id], action: 'replace', reason: 'invalid provenance', status: 'approved' }); });
  expect(errorCodes(validatePackage(source))).toContain('DECISION_OVERLAP');
  expect(errorCodes(validatePackage(source, { stage: 'delivery' }))).toContain('DECISION_OVERLAP');
});
it('reports the offending consumed shot reference instead of accepting its planning declaration', () => {
  const source = mutate(makeProductionPackage(), p => {
    const ref = row(p.asset_references, 'ar_img'); const asset = p.assets.find(asset => asset.id === ref.asset_id)!;
    p.shots[0]!.asset_ref_ids.push(ref.id);
    ref.mode = 'planned'; Object.assign(asset, { status: 'planned', file: null });
  });
  const issue = validatePackage(source, { stage: 'delivery' }).errors.find(issue => issue.code === 'DELIVERY_REFERENCE');
  expect(issue?.where).toMatch(/^\/shots\/\d+\/asset_ref_ids\/\d+$/);
});
