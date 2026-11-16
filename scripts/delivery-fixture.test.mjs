import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { connectedOffset, frameTime, generateFixture, makeEdl, makeFcpxml, parseArguments, timecode } from './delivery-fixture.mjs';

await test('25fps fixture timecodes use exact frames and reject unsupported values', () => {
  assert.equal(timecode(0), '00:00:00:00');
  assert.equal(timecode(25), '00:00:01:00');
  assert.equal(timecode(1526), '00:01:01:01');
  assert.equal(frameTime(150), '150/25s');
  for (const value of [-1, 0.5, NaN, Infinity, 24 * 3600 * 25]) assert.throws(() => timecode(value), /frame/);
});

await test('connected audio offset uses the parent source timeline rather than record time', () => {
  const parent = { sourceIn: 25, recordIn: 0 };
  assert.equal(connectedOffset(parent, 0), 25);
  assert.equal(connectedOffset(parent, 10), 35);
  assert.equal(connectedOffset({ sourceIn: 0, recordIn: 50 }, 75), 25);
});

await test('FCPXML encodes nonadjacent reuse and continuous detached audio without path or XML corruption', () => {
  const directory = path.resolve('fixture 空格 & quoted');
  const xml = makeFcpxml(directory, 'Camery "A&B"');
  assert.match(xml, /<fcpxml version="1\.10">/);
  assert.match(xml, /name="Camery &quot;A&amp;B&quot;"/);
  assert.match(xml, /frameDuration="1\/25s" width="1920" height="1080"/);
  assert.match(xml, /%20/);
  assert.match(xml, /%E7%A9%BA%E6%A0%BC/);
  assert.match(xml, /%20&amp;%20quoted\/source-a\.mov/);
  assert.doesNotMatch(xml, /%20&%20/);
  assert.match(xml, /ref="r2" offset="0\/25s" start="25\/25s" duration="50\/25s"/);
  assert.match(xml, /ref="r3" offset="50\/25s" start="0\/25s" duration="50\/25s"/);
  assert.match(xml, /ref="r2" offset="100\/25s" start="75\/25s" duration="50\/25s"/);
  assert.match(xml, /ref="r4" lane="-1" offset="25\/25s" start="0\/25s" duration="150\/25s"/);
});

await test('CMX3600 has three video-only events with matching source filenames and exclusive out points', () => {
  const edl = makeEdl();
  assert.match(edl, /FCM: NON-DROP FRAME/);
  assert.match(edl, /001  RED00001 V     C        00:00:01:00 00:00:03:00 00:00:00:00 00:00:02:00/);
  assert.match(edl, /002  BLUE0001 V     C        00:00:00:00 00:00:02:00 00:00:02:00 00:00:04:00/);
  assert.match(edl, /003  RED00001 V     C        00:00:03:00 00:00:05:00 00:00:04:00 00:00:06:00/);
  assert.equal((edl.match(/^\d{3}\s+\S+\s+V\s+C\s+/gm) ?? []).length, 3);
  assert.equal((edl.match(/FROM CLIP NAME: source-a\.mov/g) ?? []).length, 2);
  assert.ok(!/^\d{3}.*\sA\s/m.test(edl));
});

await test('CLI requires explicitly installed tools and accepts no hidden installation or unknown options', () => {
  assert.throws(() => parseArguments([]), /ffmpeg.*ffprobe/);
  assert.throws(() => parseArguments(['--ffmpeg=x', '--ffprobe=y', '--install']), /Unknown/);
  assert.throws(() => parseArguments(['--ffmpeg=x', '--ffmpeg=z', '--ffprobe=y']), /Duplicate/);
  assert.deepEqual(parseArguments(['--ffmpeg=x', '--ffprobe=y', '--output=z']), { ffmpeg: 'x', ffprobe: 'y', output: 'z' });
});

await test('generation refuses an existing output directory before attempting any executable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'camery-delivery-refuse-'));
  try {
    await writeFile(path.join(directory, 'sentinel.txt'), 'keep user data');
    await assert.rejects(generateFixture({ ffmpeg: 'must-not-run', ffprobe: 'must-not-run', output: directory }), /already exists/);
    assert.equal(await readFile(path.join(directory, 'sentinel.txt'), 'utf8'), 'keep user data');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
