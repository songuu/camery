import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const FPS = 25;
const TOTAL_FRAMES = 150;
const CUTS = Object.freeze([
  Object.freeze({ file: 'source-a.mov', reel: 'RED00001', resource: 'r2', sourceIn: 25, sourceOut: 75, recordIn: 0, recordOut: 50 }),
  Object.freeze({ file: 'source-b.mov', reel: 'BLUE0001', resource: 'r3', sourceIn: 0, sourceOut: 50, recordIn: 50, recordOut: 100 }),
  Object.freeze({ file: 'source-a.mov', reel: 'RED00001', resource: 'r2', sourceIn: 75, sourceOut: 125, recordIn: 100, recordOut: 150 }),
]);
const SOURCES = Object.freeze([
  Object.freeze({ file: 'source-a.mov', color: 'red', frames: 150, reel: 'RED00001' }),
  Object.freeze({ file: 'source-b.mov', color: 'blue', frames: 100, reel: 'BLUE0001' }),
]);

function requireFrame(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 24 * 3600 * FPS) throw new Error('Fixture frame must be an integer within one 25fps day');
}
export function frameTime(frames) { requireFrame(frames); return `${frames}/${FPS}s`; }
export function timecode(frames) {
  requireFrame(frames);
  return [Math.floor(frames / (3600 * FPS)), Math.floor(frames / (60 * FPS)) % 60, Math.floor(frames / FPS) % 60, frames % FPS]
    .map(value => String(value).padStart(2, '0')).join(':');
}
export function connectedOffset(parent, recordFrame) {
  requireFrame(parent.sourceIn); requireFrame(parent.recordIn); requireFrame(recordFrame);
  const result = parent.sourceIn + recordFrame - parent.recordIn;
  requireFrame(result); return result;
}
const xmlAttribute = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&apos;');

/** Apple 1.10 DTD: parent start establishes its local timeline for connected items.
 * https://developer.apple.com/documentation/professional-video-applications/document-type-definition
 * Syntax and planned coordinates do not prove a target editor accepted this document.
 */
export function makeFcpxml(directory, projectName = 'Camery Phase0 FCPXML') {
  const source = file => xmlAttribute(pathToFileURL(path.join(path.resolve(directory), file)).href);
  const clips = CUTS.map((cut, index) => {
    const attributes = `name="${cut.file}" ref="${cut.resource}" offset="${frameTime(cut.recordIn)}" start="${frameTime(cut.sourceIn)}" duration="${frameTime(cut.sourceOut - cut.sourceIn)}"`;
    if (index !== 0) return `            <asset-clip ${attributes}/>`;
    // Record frame 0 maps to source frame 25 in the first clip's local timeline.
    return `            <asset-clip ${attributes}>
              <asset-clip name="dialogue.wav" ref="r4" lane="-1" offset="${frameTime(connectedOffset(cut, 0))}" start="0/25s" duration="150/25s" audioRole="dialogue"/>
            </asset-clip>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat1080p25" frameDuration="1/25s" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>
    <asset id="r2" name="source-a.mov" start="0/25s" duration="150/25s" hasVideo="1" hasAudio="0" format="r1"><media-rep kind="original-media" src="${source('source-a.mov')}"/></asset>
    <asset id="r3" name="source-b.mov" start="0/25s" duration="100/25s" hasVideo="1" hasAudio="0" format="r1"><media-rep kind="original-media" src="${source('source-b.mov')}"/></asset>
    <asset id="r4" name="dialogue.wav" start="0/25s" duration="150/25s" hasVideo="0" hasAudio="1" audioSources="1" audioChannels="1" audioRate="48000"><media-rep kind="original-media" src="${source('dialogue.wav')}"/></asset>
  </resources>
  <library>
    <event name="Camery synthetic phase0">
      <project name="${xmlAttribute(projectName)}">
        <sequence format="r1" duration="150/25s" tcStart="0/25s" tcFormat="NDF" audioLayout="mono" audioRate="48k">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

/** The CMX3600 fixture intentionally carries only V cuts; WAV is an explicit companion. */
export function makeEdl() {
  return 'TITLE: CAMERY_PHASE0_EDL\nFCM: NON-DROP FRAME\n\n' + CUTS.map((cut, index) =>
    `${String(index + 1).padStart(3, '0')}  ${cut.reel} V     C        ${timecode(cut.sourceIn)} ${timecode(cut.sourceOut)} ${timecode(cut.recordIn)} ${timecode(cut.recordOut)}\n* FROM CLIP NAME: ${cut.file}\n`
  ).join('\n');
}

export function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    const match = /^--(ffmpeg|ffprobe|output)=(.+)$/.exec(argument);
    if (!match) throw new Error('Unknown fixture option; use --ffmpeg=path --ffprobe=path [--output=new-directory]');
    if (Object.hasOwn(options, match[1])) throw new Error(`Duplicate fixture option: ${match[1]}`);
    options[match[1]] = match[2];
  }
  if (!options.ffmpeg || !options.ffprobe) throw new Error('Explicit --ffmpeg and --ffprobe paths are required; tools are never installed automatically');
  return options;
}

function execute(tool, args, label) {
  const result = spawnSync(tool, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  if (result.error || result.signal || result.status !== 0) throw new Error(`${label} did not finish successfully (exit=${result.status}, signal=${result.signal ?? 'none'}): ${(result.stderr ?? '').slice(-2000)}`, { cause: result.error });
  return result.stdout;
}
function verifyVideo(probe, source) {
  const videos = probe.streams.filter(stream => stream.codec_type === 'video');
  const video = videos[0];
  if (videos.length !== 1 || probe.streams.some(stream => stream.codec_type === 'audio') || video.codec_name !== 'prores' || video.width !== 1920 || video.height !== 1080 || video.r_frame_rate !== '25/1' || Number(video.nb_read_frames) !== source.frames || Number(video.duration) !== source.frames / FPS)
    throw new Error(`Video probe differs from the fixed fixture contract: ${source.file}`);
  if (!probe.streams.some(stream => stream.tags?.timecode === '00:00:00:00')) throw new Error(`Video timecode origin was not verified: ${source.file}`);
}
function verifyAudio(probe) {
  const audio = probe.streams[0];
  if (probe.streams.length !== 1 || audio.codec_type !== 'audio' || audio.codec_name !== 'pcm_s16le' || audio.sample_rate !== '48000' || audio.channels !== 1 || audio.time_base !== '1/48000' || Number(audio.duration_ts) !== 288000)
    throw new Error('Audio probe differs from the fixed 48kHz six-second fixture contract');
}

export async function generateFixture(options) {
  const directory = path.resolve(options.output ?? path.join(root, 'artifacts/delivery', `phase0-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`));
  await mkdir(path.dirname(directory), { recursive: true });
  try { await mkdir(directory); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Fixture output directory already exists; refusing to overwrite it'); throw error; }
  let stage = 'tool validation';
  try {
    if (!path.isAbsolute(options.ffmpeg ?? '') || !path.isAbsolute(options.ffprobe ?? '')) throw new Error('Both tool paths must be absolute installed executable paths');
    const tools = {
      ffmpeg: { path: options.ffmpeg, version: execute(options.ffmpeg, ['-version'], 'FFmpeg version').split(/\r?\n/)[0] },
      ffprobe: { path: options.ffprobe, version: execute(options.ffprobe, ['-version'], 'ffprobe version').split(/\r?\n/)[0] },
    };
    const probes = {};
    for (const source of SOURCES) {
      stage = `generating ${source.file}`;
      execute(options.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', `color=c=${source.color}:size=1920x1080:rate=25`,
        '-frames:v', String(source.frames), '-an', '-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le', '-threads', '2',
        '-vendor', 'apl0', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-timecode', '00:00:00:00', '-metadata', `reel_name=${source.reel}`, path.join(directory, source.file)], stage);
      stage = `probing ${source.file}`;
      const probe = JSON.parse(execute(options.ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path.join(directory, source.file)], stage));
      verifyVideo(probe, source); probes[source.file] = probe;
    }
    stage = 'generating dialogue.wav';
    execute(options.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', path.join(directory, 'dialogue.wav')], stage);
    stage = 'probing dialogue.wav';
    probes['dialogue.wav'] = JSON.parse(execute(options.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(directory, 'dialogue.wav')], stage));
    verifyAudio(probes['dialogue.wav']);
    stage = 'writing interchange documents';
    await writeFile(path.join(directory, 'camery-phase0.fcpxml'), makeFcpxml(directory), { flag: 'wx' });
    await writeFile(path.join(directory, 'camery-phase0.edl'), makeEdl(), { flag: 'wx' });
    const hashes = {};
    for (const file of [...SOURCES.map(source => source.file), 'dialogue.wav', 'camery-phase0.fcpxml', 'camery-phase0.edl'])
      hashes[file] = createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex');
    const manifest = {
      schemaVersion: 1, purpose: 'T0.13 synthetic interchange feasibility fixture; not a production exporter', outputDirectory: directory,
      generatedAt: new Date().toISOString(), generatorSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'), tools,
      sourceContent: 'Locally synthesized solid colors and a 440Hz sine; no external media, voice clone, AI model, or rights approval asserted',
      expected: { fps: FPS, width: 1920, height: 1080, durationFrames: TOTAL_FRAMES, sourceTimecode: '00:00:00:00', outPoints: 'exclusive', videoCuts: CUTS,
        detachedAudio: { file: 'dialogue.wav', sourceIn: 0, recordIn: 0, durationFrames: 150, sampleRate: 48000, samples: 288000, channels: 1, fcpxmlParentOffsetFrames: 25 },
      }, probes, sha256: hashes, importAcceptance: { status: 'not_run', targets: [], note: 'Only the media probe contract has been checked; editor import, playback, missing media and synchronization remain unverified' },
      limitations: ['Fixed 25fps non-drop-frame fixture only', 'FCPXML uses a connected audio item spanning cuts', 'EDL carries video cuts only; dialogue.wav must be imported/aligned separately', 'XML/timecode text checks do not prove target editor acceptance', 'No AIGC compliance or source authorization conclusion'],
      references: ['https://developer.apple.com/documentation/professional-video-applications/document-type-definition', 'https://developer.apple.com/documentation/professional-video-applications/creating-fcpxml-documents'],
    };
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    return { directory, manifest };
  } catch (error) {
    throw new Error(`Fixture generation failed during ${stage}; partial task-owned output retained at ${directory}: ${error.message}`, { cause: error });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await generateFixture(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify({ directory: result.directory, manifest: path.join(result.directory, 'manifest.json'), importAcceptance: 'not_run' }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
