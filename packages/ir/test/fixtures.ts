import { createHash } from 'node:crypto';
import type {
  AdaptationDecision,
  Asset,
  AssetReference,
  AudioCue,
  ChangeOp,
  ChangeSet,
  DialogueLine,
  Claim,
  Issue,
  Segment,
  Shot,
  StoryboardPackage,
  ValidationReport,
} from '../src/index';

export const REVISION = 5;

/** 可读别名仅存在于测试；序列化夹具使用合法且稳定的 ULID。 */
export function fixtureId(alias: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let value = BigInt('0x' + createHash('sha256').update(alias).digest('hex').slice(0, 32));
  let result = '';
  for (let i = 0; i < 26; i++) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

function canonicalIds<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'string' && /^(pkg|prj|src|char|loc|spot|look|prop|ep|sc|b|l|n|rnd|sh|p|tr|cue|as|ar|seg|claim|dec|cs|op|user|profile)_/.test(item)
      ? fixtureId(item) : item)) as T;
}

/** 冻结夹具，让任何对输入的就地修改都当场抛错，用来证明核心函数不可变。 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function characterStates(spotId: string, holding: readonly string[] = []) {
  return [{ character_id: 'char_lin', appearance_id: 'look_lin', spot_id: spotId, holding: [...holding] }];
}

interface ShotSpec {
  readonly id: string;
  readonly sceneId: string;
  readonly orderKey: string;
  readonly beats: readonly string[];
  readonly seconds: number;
  readonly spotId: string;
}

function shot(spec: ShotSpec, version = 1): Shot {
  return {
    id: spec.id,
    version,
    rendition_id: 'rnd_v',
    scene_id: spec.sceneId,
    order_key: spec.orderKey,
    beat_refs: [...spec.beats],
    visual_purpose: `${spec.id} 的视觉目的`,
    start_state: { summary: '起始', characters: characterStates(spec.spotId) },
    action: '动作',
    end_state: { summary: '结束', characters: characterStates(spec.spotId) },
    camera: { shot_size: 'medium', angle: 'eye_level', movement: 'static', lens_mm: null, note: null },
    asset_ref_ids: [],
    duration: { planned: spec.seconds, measured: null },
    continuity_break: null,
  };
}

/** 供拆镜、并镜的 `into` 使用：不带 version，由 apply 统一赋值。 */
export function shotDraft(spec: ShotSpec): Omit<Shot, 'version'> {
  const { version: _version, ...draft } = shot(spec);
  return canonicalIds(draft);
}

const NO_MIX = { gain_db: 0, fade_in_seconds: 0, fade_out_seconds: 0 };

interface SpokenSpec {
  readonly id: string;
  readonly renditionId: string;
  readonly episodeId: string;
  readonly trackId: string;
  readonly lineId: string;
  readonly kind: 'dialogue' | 'narration';
  readonly anchor: { ref: string; edge: 'start' | 'end'; offset: number };
  readonly seconds: number;
}

function spoken(spec: SpokenSpec): AudioCue {
  return {
    id: spec.id,
    version: 1,
    rendition_id: spec.renditionId,
    episode_id: spec.episodeId,
    track_id: spec.trackId,
    asset_ref_ids: [],
    anchor: spec.anchor,
    mix: NO_MIX,
    kind: spec.kind,
    line_id: spec.lineId,
    extent: { kind: 'fixed', duration: { planned: spec.seconds, measured: null } },
  };
}

function music(id: string, episodeId: string, continuesFrom: string | null): AudioCue {
  return {
    id,
    version: 1,
    rendition_id: 'rnd_v',
    episode_id: episodeId,
    track_id: 'tr_v_music',
    asset_ref_ids: [],
    anchor: { ref: episodeId, edge: 'start', offset: 0 },
    mix: NO_MIX,
    kind: 'music',
    scene_id: null,
    beat_refs: [],
    sound_intent: '贯穿全集的器乐',
    extent: { kind: 'until', anchor: { ref: episodeId, edge: 'end', offset: 0 } },
    continues_from: continuesFrom,
  };
}

function beat(id: string, sceneId: string, orderKey: string, kind: 'action' | 'dialogue') {
  return {
    id,
    version: 1,
    scene_id: sceneId,
    order_key: orderKey,
    kind,
    required: true,
    summary: `${id} 摘要`,
    source_refs: [{ source_id: 'src_novel', locator: '第一章', relationship: 'adapted' as const }],
    claim_ids: [],
  };
}

function line(id: string, beatId: string, speakerId: string, kind: 'dialogue' | 'narration', only: string[] | null): DialogueLine {
  return {
    id,
    version: 1,
    beat_id: beatId,
    order_key: 'a0',
    speaker_id: speakerId,
    kind: kind === 'dialogue' ? 'on_screen' : kind,
    text: `${id} 台词`,
    delivery: '自然',
    locked: false,
    only_rendition_ids: only,
  };
}

function scene(id: string, episodeId: string, locationId: string) {
  return {
    id,
    version: 1,
    episode_id: episodeId,
    order_key: 'a0',
    title: `${id} 标题`,
    location_id: locationId,
    character_ids: ['char_lin', 'char_he', 'char_narrator'],
    script_text: '场次正文',
    start_state: '开场状态',
    end_state: '收场状态',
  };
}

const TRACKS = [
  { id: 'tr_v_dlg', version: 1, rendition_id: 'rnd_v', role: 'dialogue', allow_overlap: false },
  { id: 'tr_v_music', version: 1, rendition_id: 'rnd_v', role: 'music', allow_overlap: false },
  { id: 'tr_a_nar', version: 1, rendition_id: 'rnd_a', role: 'narration', allow_overlap: false },
  { id: 'tr_a_dlg', version: 1, rendition_id: 'rnd_a', role: 'dialogue', allow_overlap: false },
] as const;

const cueAt = (ref: string, edge: 'start' | 'end', offset = 0) => ({ ref, edge, offset });

function makeCues(): AudioCue[] {
  const video = { renditionId: 'rnd_v', trackId: 'tr_v_dlg', kind: 'dialogue' as const, seconds: 3 };
  const narration = { renditionId: 'rnd_a', trackId: 'tr_a_nar', kind: 'narration' as const, seconds: 3 };
  const dialogue = { renditionId: 'rnd_a', trackId: 'tr_a_dlg', kind: 'dialogue' as const, seconds: 3 };
  return [
    spoken({ ...video, id: 'cue_say', episodeId: 'ep_1', lineId: 'l_say', anchor: cueAt('sh_2', 'start', 0.5) }),
    spoken({ ...video, id: 'cue_reply', episodeId: 'ep_2', lineId: 'l_reply', anchor: cueAt('sh_4', 'start') }),
    music('cue_music_1', 'ep_1', null),
    music('cue_music_2', 'ep_2', 'cue_music_1'),
    spoken({ ...narration, id: 'cue_a_open', episodeId: 'ep_1', lineId: 'n_open', anchor: cueAt('ep_1', 'start') }),
    spoken({ ...dialogue, id: 'cue_a_say', episodeId: 'ep_1', lineId: 'l_say', anchor: cueAt('cue_a_open', 'end', 0.2) }),
    spoken({ ...narration, id: 'cue_a_arrive', episodeId: 'ep_2', lineId: 'n_arrive', anchor: cueAt('ep_2', 'start') }),
    spoken({ ...dialogue, id: 'cue_a_reply', episodeId: 'ep_2', lineId: 'l_reply', anchor: cueAt('cue_a_arrive', 'end') }),
  ];
}

function makeAssets(): Asset[] {
  const base = { version: 1, origin: 'generated' as const, consent_ref: null };
  return [
    {
      ...base,
      id: 'as_img',
      media_type: 'image',
      description: '已生成关键帧',
      status: 'ready',
      file: { path: 'img/a.png', sha256: 'a'.repeat(64), mime_type: 'image/png' },
    },
    { ...base, id: 'as_voice', media_type: 'audio', description: '待选声音', status: 'planned', file: null },
  ];
}

function makeAssetReferences(): AssetReference[] {
  const base = { version: 1, controls: '外观', must_not_control: '不得改写台词' };
  return [
    { ...base, id: 'ar_img', mode: 'actual', asset_id: 'as_img', purpose: 'keyframe' },
    { ...base, id: 'ar_voice', mode: 'planned', asset_id: 'as_voice', purpose: 'voice' },
  ];
}

function makeBible() {
  return {
    characters: [
      { id: 'char_lin', version: 1, name: '林澄', role: '主角', default_voice_ref_id: 'ar_voice' },
      { id: 'char_he', version: 1, name: '阿禾', role: '朋友', default_voice_ref_id: null },
      { id: 'char_narrator', version: 1, name: '旁白', role: '画外讲述', default_voice_ref_id: null },
    ],
    appearances: [
      {
        id: 'look_lin',
        version: 1,
        character_id: 'char_lin',
        label: '日常装',
        description: '灰色外套',
        scene_ids: ['sc_1', 'sc_2'],
        reference_asset_ref_ids: [],
      },
    ],
    props: [{ id: 'prop_note', version: 1, name: '便签', description: '父亲留下的便签' }],
    locations: [
      {
        id: 'loc_shop',
        version: 1,
        name: '书店',
        description: '傍晚',
        spots: [
          { id: 'spot_desk', label: '木桌' },
          { id: 'spot_door', label: '门口' },
        ],
      },
      { id: 'loc_hill', version: 1, name: '山顶', description: '清晨', spots: [{ id: 'spot_bench', label: '长椅' }] },
    ],
  };
}

function makeShots(): Shot[] {
  return [
    shot({ id: 'sh_1', sceneId: 'sc_1', orderKey: 'a0', beats: ['b_open'], seconds: 4, spotId: 'spot_desk' }),
    shot({ id: 'sh_2', sceneId: 'sc_1', orderKey: 'a1', beats: ['b_say'], seconds: 6, spotId: 'spot_desk' }, REVISION),
    shot({ id: 'sh_3', sceneId: 'sc_2', orderKey: 'a0', beats: ['b_arrive'], seconds: 5, spotId: 'spot_bench' }),
    shot({ id: 'sh_4', sceneId: 'sc_2', orderKey: 'a1', beats: ['b_reply'], seconds: 5, spotId: 'spot_bench' }),
  ];
}

function makeScript() {
  return {
    episodes: [
      { id: 'ep_1', version: 1, title: '第一集', order_key: 'a0', target_seconds: 20 },
      { id: 'ep_2', version: 1, title: '第二集', order_key: 'a1', target_seconds: 20 },
    ],
    scenes: [scene('sc_1', 'ep_1', 'loc_shop'), scene('sc_2', 'ep_2', 'loc_hill')],
    beats: [
      beat('b_open', 'sc_1', 'a0', 'action'),
      beat('b_say', 'sc_1', 'a1', 'dialogue'),
      beat('b_arrive', 'sc_2', 'a0', 'action'),
      beat('b_reply', 'sc_2', 'a1', 'dialogue'),
    ],
    lines: [
      line('l_say', 'b_say', 'char_lin', 'dialogue', null),
      line('l_reply', 'b_reply', 'char_he', 'dialogue', null),
      line('n_open', 'b_open', 'char_narrator', 'narration', ['rnd_a']),
      line('n_arrive', 'b_arrive', 'char_narrator', 'narration', ['rnd_a']),
    ],
  };
}

/** 两集、视频 + 纯音频两个版本的最小完整包：覆盖齐全、版权干净，便于各用例只破坏一处。 */
export function makePackage(): StoryboardPackage {
  return deepFreeze<StoryboardPackage>(canonicalIds({
    schema_version: '0.5.0-draft',
    package_id: 'pkg_demo',
    project: {
      id: 'prj_demo',
      title: '演示作品',
      mode: 'studio',
      content_kind: 'fiction',
      rights_status: 'authorized',
      content_pack_versions: {},
      source_ids: ['src_novel'],
      scope: { label: '全部两集', expected_episode_count: 2, expected_scene_count: 2, expected_required_beat_count: 4 },
    },
    revision: { number: REVISION, status: 'adopted', note: '测试夹具' },
    sources: [
      {
        id: 'src_novel',
        version: 1,
        kind: 'novel',
        title: '授权小说',
        origin_uri: null,
        capture_state: 'provided',
        coverage: 'full_selected_content',
        usage_basis: 'authorized',
        selected_content: null,
        note: '已取得改编授权',
      },
    ],
    ...makeBible(),
    claims: [],
    ...makeScript(),
    renditions: [
      { id: 'rnd_v', version: 1, label: '竖屏短剧', readiness: 'planned', kind: 'video', aspect_ratio: '9:16' },
      { id: 'rnd_a', version: 1, label: '有声版', readiness: 'planned', kind: 'audio' },
    ],
    shots: makeShots(),
    panels: [
      {
        id: 'p_start',
        version: 1,
        shot_id: 'sh_1',
        description: '开场画格',
        candidate_asset_ref_ids: ['ar_img'],
        adopted_asset_ref_id: 'ar_img',
        position: 'start',
      },
      {
        id: 'p_key',
        version: 1,
        shot_id: 'sh_2',
        description: '中段画格',
        candidate_asset_ref_ids: [],
        adopted_asset_ref_id: null,
        position: 'intermediate',
        offset_ratio: 0.5,
      },
      {
        id: 'p_end',
        version: 1,
        shot_id: 'sh_2',
        description: '收尾画格',
        candidate_asset_ref_ids: [],
        adopted_asset_ref_id: null,
        position: 'end',
      },
    ],
    audio_tracks: TRACKS.map((track) => ({ ...track })),
    audio_cues: makeCues(),
    assets: makeAssets(),
    asset_references: makeAssetReferences(),
    adaptation_decisions: [],
    segments: [],
    shot_takes: [],
    plot_units: [],
    episode_state_snapshots: [],
    shot_lineage: [],
    locks: [],
  }));
}

/** 在私有副本上改一处，返回新的冻结包；基准夹具本身绝不被修改。 */
export function mutate(pkg: StoryboardPackage, edit: (draft: StoryboardPackage) => void): StoryboardPackage {
  const draft = structuredClone(pkg);
  edit(draft);
  return deepFreeze(draft);
}

export function row<T extends { id: string }>(rows: readonly T[], id: string): T {
  const found = rows.find((candidate) => candidate.id === id || candidate.id === fixtureId(id));
  if (found === undefined) {
    throw new Error(`夹具中不存在 ${id}`);
  }
  return found;
}

export function makeSegment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: fixtureId('seg_1'),
    version: 1,
    rendition_id: fixtureId('rnd_v'),
    target_mode: 'test-video',
    purpose: 'listener_reaction',
    planned_duration: 12,
    handles: { head: 0.5, tail: 0.5 },
    priority: 'first',
    continuity_from: null,
    ...overrides,
  };
}

export function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return canonicalIds({
    id: 'claim_1',
    version: 1,
    statement: '太阳照亮月球的一半',
    kind: 'fact',
    evidence: [{ source_id: 'src_novel', locator: '第三章' }],
    verification: 'verified',
    ...overrides,
  });
}

export function makeOmitDecision(overrides: Partial<AdaptationDecision> = {}): AdaptationDecision {
  return canonicalIds({
    id: 'dec_1',
    version: 1,
    action: 'omit',
    rendition_id: null,
    affected_beat_ids: ['b_open'],
    replacement_beat_ids: [],
    reason: '合并到下一场',
    status: 'approved',
    ...overrides,
  }) as AdaptationDecision;
}

export function changeSet(ops: ChangeOp[], overrides: Partial<ChangeSet> = {}): ChangeSet {
  return canonicalIds({
    schema_version: '0.5.0-draft',
    id: 'cs_test',
    base_revision: REVISION,
    author: { kind: 'user', id: 'user_1' },
    status: 'candidate',
    base_revisions: [],
    ops,
    ...overrides,
  });
}

export const codes = (issues: readonly Issue[]): string[] => issues.map((issue) => issue.code);
export const errorCodes = (report: ValidationReport): string[] => codes(report.errors);
export const warningCodes = (report: ValidationReport): string[] => codes(report.warnings);

/** 声明级出片夹具；文件内容由 Node 边界测试另行创建和核验。 */
export function makeProductionPackage(): StoryboardPackage {
  return mutate(makePackage(), p => {
    p.renditions.forEach(rendition => { rendition.readiness = 'ready'; });
    const consumed = new Set([...p.shots.flatMap(shot => shot.asset_ref_ids), ...p.audio_cues.flatMap(cue => cue.asset_ref_ids)]);
    const consumedAssets = new Set(p.asset_references.filter(ref => consumed.has(ref.id)).map(ref => ref.asset_id));
    p.assets = p.assets.map(asset => {
      if (!consumedAssets.has(asset.id) || asset.status === 'ready') return asset;
      const suffix = asset.media_type === 'image' ? 'png' : asset.media_type === 'audio' ? 'wav' : 'mp4';
      const mime = asset.media_type === 'image' ? 'image/png' : asset.media_type === 'audio' ? 'audio/wav' : 'video/mp4';
      return { ...asset, status: 'ready', file: { path: `ready/${asset.id}.${suffix}`, sha256: 'a'.repeat(64), mime_type: mime } };
    });
    p.asset_references.forEach(ref => { if (consumedAssets.has(ref.asset_id)) ref.mode = 'actual'; });
    p.segments.push(makeSegment());
    p.assets.push({
      id: fixtureId('video'), version: 1, media_type: 'video', description: '已声明素材', origin: 'generated',
      consent_ref: null, status: 'ready', file: { path: 'video/a.mp4', sha256: 'b'.repeat(64), mime_type: 'video/mp4' },
      measured_seconds: 12, quality_tier: 'draft', derived_from: null,
      generated_from_segment: { id: fixtureId('seg_1'), version: 1 },
    });
    for (const s of p.shots) p.shot_takes.push({
      id: fixtureId('take-' + s.id), version: 1, shot_id: s.id,
      segment_revision_id: { id: fixtureId('seg_1'), version: 1 }, media_asset_id: { id: fixtureId('video'), version: 1 },
      source_in: 0.5, source_out: s.duration.planned + 0.5, timeline_offset: 0,
      playback_rate: { numerator: 1, denominator: 1 }, audio_policy: 'mute', visible_speaker_id: null, status: 'adopted',
    });
  });
}
