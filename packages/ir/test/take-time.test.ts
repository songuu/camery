import { expect, it } from 'vitest';
import { validatePackage } from '../src/index';
import { errorCodes, fixtureId as id, makeProductionPackage, mutate, row, warningCodes } from './fixtures';

it.each([0.0000005, 0.0000000005, Number.MIN_VALUE])('rejects a leading take gap of %s seconds', offset => {
  const pkg = mutate(makeProductionPackage(), p => { p.shot_takes[0]!.timeline_offset = offset; });
  expect(errorCodes(validatePackage(pkg, { stage: 'delivery' }))).toContain('TAKE_COVERAGE');
});

it.each([1.9999995, 2.0000005, 1.9999999995, 2.0000000005])('rejects an interior overlap or gap at %s seconds', offset => {
  const pkg = mutate(makeProductionPackage(), p => {
    const first = p.shot_takes[0]!;
    first.source_out = 2.5;
    p.shot_takes.push({ ...first, id: id('take-boundary'), timeline_offset: offset });
  });
  expect(errorCodes(validatePackage(pkg, { stage: 'delivery' }))).toContain('TAKE_COVERAGE');
});

it('rejects a trailing half-microsecond coverage loss', () => {
  const pkg = mutate(makeProductionPackage(), p => { p.shot_takes[0]!.source_out = 4.4999995; });
  expect(errorCodes(validatePackage(pkg, { stage: 'delivery' }))).toContain('TAKE_COVERAGE');
});

it('compares usable source boundaries as exact decimal declarations', () => {
  const pkg = mutate(makeProductionPackage(), p => {
    const first = p.shot_takes[0]!;
    p.shot_takes = [{ ...first, source_in: 0, source_out: 0.1, status: 'candidate' }];
    p.segments[0]!.handles = { head: 0, tail: 0.2 };
    row(p.assets, 'video').measured_seconds = 0.3;
  });
  expect(validatePackage(pkg).valid).toBe(true);
  expect(errorCodes(validatePackage(mutate(pkg, p => { p.shot_takes[0]!.source_out = 0.10000000000000002; })))).toContain('TAKE_RANGE');
});

it('rejects handles that exactly consume the declared planned segment', () => {
  const pkg = mutate(makeProductionPackage(), p => {
    p.segments[0]!.planned_duration = 0.8;
    p.segments[0]!.handles = { head: 0.1, tail: 0.7 };
  });
  expect(errorCodes(validatePackage(pkg))).toContain('SEGMENT_HANDLES');
});

it('does not overflow a duration whose large playback numerator and denominator cancel', () => {
  const pkg = mutate(makeProductionPackage(), p => {
    p.shots[0]!.duration.planned = 1e300;
    p.segments[0]!.planned_duration = 1e301;
    row(p.assets, 'video').measured_seconds = 1e301;
    const take = p.shot_takes[0]!;
    take.source_in = 0.5; take.source_out = 1e300;
    take.playback_rate = { numerator: Number.MAX_SAFE_INTEGER, denominator: Number.MAX_SAFE_INTEGER };
  });
  // The 0.5-second difference remains significant even at enormous source timestamps.
  expect(errorCodes(validatePackage(pkg))).toContain('TAKE_COVERAGE');
  const complete = mutate(pkg, p => { p.shot_takes[0]!.source_in = 0; p.segments[0]!.handles.head = 0; });
  expect(validatePackage(complete).valid).toBe(true);
});

it('does not accept a near-total tiny-shot loss caused by underflow in rate conversion', () => {
  const pkg = mutate(makeProductionPackage(), p => {
    const first = p.shot_takes[0]!;
    first.source_in = 0; first.source_out = Number.MIN_VALUE;
    first.playback_rate = { numerator: Number.MAX_SAFE_INTEGER, denominator: 1 };
    p.shots[0]!.duration.planned = Number.MIN_VALUE;
    p.segments[0]!.handles.head = 0;
  });
  expect(errorCodes(validatePackage(pkg))).toContain('TAKE_COVERAGE');
});

it('accepts and reports only bounded source snapshot rounding at fractional playback rates', () => {
  const pkg = mutate(makeProductionPackage(), p => {
    const first = p.shot_takes[0]!;
    first.playback_rate = { numerator: 1, denominator: 3 };
    first.source_out = 1.1666666666666667;
    p.shot_takes.push({ ...first, id: id('take-rounded'), source_in: first.source_out, source_out: 2.5, timeline_offset: 2 });
    p.shots[0]!.duration.planned = 6;
  });
  expect(validatePackage(pkg).valid).toBe(true);
  expect(warningCodes(validatePackage(pkg))).toContain('TAKE_TIME_ROUNDED');
});

it('retains valid fractional cuts at large source offsets without granting a general nanosecond tolerance', () => {
  const pkg = mutate(makeProductionPackage(), p => {
    const first = p.shot_takes[0]!;
    first.playback_rate = { numerator: 1, denominator: 3 };
    first.source_in = 1e6; first.source_out = 1000000.6666666666;
    row(p.assets, 'video').measured_seconds = 1e7;
    p.shots[0]!.duration.planned = 2;
  });
  expect(validatePackage(pkg).valid).toBe(true);
  expect(warningCodes(validatePackage(pkg))).toContain('TAKE_TIME_ROUNDED');
});

it('keeps the one-nanosecond ceiling even when source coordinates have larger representational uncertainty', () => {
  const pkg = mutate(makeProductionPackage(), p => {
    const first = p.shot_takes[0]!;
    first.source_in = 1e8; first.source_out = 1e8 + 4.00000001;
    row(p.assets, 'video').measured_seconds = 1e9;
  });
  expect(errorCodes(validatePackage(pkg))).toContain('TAKE_COVERAGE');
});
