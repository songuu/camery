import { describe, expect, it } from 'vitest';
import { ChangeSet, validatePackage } from '../src/index';
import type { StoryboardPackage } from '../src/index';
import { changeSet, errorCodes, makePackage, mutate, row } from './fixtures';

const base = makePackage();
const loose = (value: unknown) => value as Record<string, unknown>;

type Edit = (draft: StoryboardPackage) => void;

const INVALID_SHAPES: ReadonlyArray<readonly [string, Edit]> = [
  ['顶层未知字段', (d) => void (loose(d).extra = 1)],
  ['镜头未知字段', (d) => void (loose(row(d.shots, 'sh_1')).start_seconds = 0)],
  ['旧版协议号', (d) => void (loose(d).schema_version = '0.3.0-draft')],
  ['口语 cue 自带文本（必须从台词推导）', (d) => void (loose(row(d.audio_cues, 'cue_say')).text = '私自改词')],
  ['口语 cue 自带说话人', (d) => void (loose(row(d.audio_cues, 'cue_say')).speaker_id = 'char_lin')],
  ['音效 cue 带台词引用', (d) => void (loose(row(d.audio_cues, 'cue_music_1')).line_id = 'l_say')],
  [
    '口语 cue 用 until 定长（台词时长是自身属性）',
    (d) =>
      void (loose(row(d.audio_cues, 'cue_say')).extent = {
        kind: 'until',
        anchor: { ref: 'sh_2', edge: 'end', offset: 0 },
      }),
  ],
  ['景别不在受控词表', (d) => void (loose(row(d.shots, 'sh_1').camera).shot_size = '中景')],
  ['运镜不在受控词表', (d) => void (loose(row(d.shots, 'sh_1').camera).movement = '固定观察主要动作')],
  ['时长为零', (d) => void (row(d.shots, 'sh_1').duration.planned = 0)],
  ['顺序键含非法字符', (d) => void (row(d.shots, 'sh_1').order_key = 'a-1')],
  ['ID 非法', (d) => void (row(d.shots, 'sh_1').id = '1 shot')],
  ['ready 资产缺文件', (d) => void (loose(row(d.assets, 'as_img')).file = null)],
  [
    'planned 资产带文件',
    (d) => void (loose(row(d.assets, 'as_voice')).file = { path: 'a.wav', sha256: 'b'.repeat(64), mime_type: 'audio/wav' }),
  ],
  ['key 画格缺比例', (d) => void delete loose(row(d.panels, 'p_key')).offset_ratio],
  ['key 画格比例越界', (d) => void (loose(row(d.panels, 'p_key')).offset_ratio = 1)],
  ['start 画格带比例', (d) => void (loose(row(d.panels, 'p_start')).offset_ratio = 0.5)],
  ['视频版本缺画幅', (d) => void delete loose(row(d.renditions, 'rnd_v')).aspect_ratio],
  ['音频版本带画幅', (d) => void (loose(row(d.renditions, 'rnd_a')).aspect_ratio = '9:16')],
  [
    'replace 决定没有替代节拍',
    (d) =>
      d.adaptation_decisions.push({
        id: 'dec_x',
        version: 1,
        action: 'replace',
        rendition_id: null,
        affected_beat_ids: ['b_open'],
        replacement_beat_ids: [],
        reason: '理由',
        status: 'approved',
      } as never),
  ],
  [
    'omit 决定带替代节拍',
    (d) =>
      d.adaptation_decisions.push({
        id: 'dec_x',
        version: 1,
        action: 'omit',
        rendition_id: null,
        affected_beat_ids: ['b_open'],
        replacement_beat_ids: ['b_say'],
        reason: '理由',
        status: 'approved',
      } as never),
  ],
];

describe('StoryboardPackage 结构', () => {
  it('接受完整夹具', () => {
    expect(validatePackage(base)).toMatchObject({ valid: true, errors: [] });
  });

  it.each(INVALID_SHAPES)('拒绝：%s', (_name, edit) => {
    expect(errorCodes(validatePackage(mutate(base, edit)))).toContain('SCHEMA');
  });

  it('非对象输入报告 SCHEMA 而不是抛异常', () => {
    expect(errorCodes(validatePackage('not a package'))).toEqual(['SCHEMA']);
    expect(errorCodes(validatePackage(null))).toEqual(['SCHEMA']);
  });

  it('SCHEMA 问题带可定位路径', () => {
    const report = validatePackage(mutate(base, (d) => void (row(d.shots, 'sh_1').duration.planned = -1)));
    expect(report.errors[0]?.where).toBe('/shots/0/duration/planned');
  });

  it('报告声明校验的含义边界', () => {
    expect(validatePackage(base).meaning).toContain('不代表');
  });
});

describe('ChangeSet 结构', () => {
  const update = { op: 'update', op_id: 'op_1', collection: 'shots', target: 'sh_1', set: {} } as const;

  it('接受合法变更集', () => {
    expect(ChangeSet.safeParse(changeSet([update])).success).toBe(true);
  });

  it.each([
    ['空操作列表', changeSet([])],
    ['未知作者类型', { ...changeSet([update]), author: { kind: 'robot', id: 'x' } }],
    ['未知操作', changeSet([{ op: 'rename', op_id: 'op_1' } as never])],
    ['生成段不是可编辑集合', changeSet([{ ...update, collection: 'render_segments' } as never])],
    ['拆镜少于两段', changeSet([{ op: 'split', op_id: 'op_1', target: 'sh_1', into: [] } as never])],
    ['并镜少于两个目标', changeSet([{ op: 'merge', op_id: 'op_1', targets: ['sh_1'], into: {} } as never])],
  ])('拒绝：%s', (_name, input) => {
    expect(ChangeSet.safeParse(input).success).toBe(false);
  });
});
