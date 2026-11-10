import { TimelineError } from './errors';
import { compareKeys } from './order';
import { add, compare, durationValue, rational, seconds, subtract } from './time';
import type { Rational } from './time';

interface Ordered { id: string; order_key: string }
interface Duration { planned: number; measured: number | null }
interface Anchor { ref: string; edge: 'start' | 'end'; offset: number }
interface Cue {
  id: string; rendition_id: string; episode_id: string; track_id: string;
  anchor: Anchor;
  extent: { kind: 'fixed'; duration: Duration } | { kind: 'until'; anchor: Anchor };
  line_id?: string; beat_refs?: readonly string[];
  mix: { fade_in_seconds: number; fade_out_seconds: number };
}

/** 结构化接口避免 timeline 反向依赖 IR，后续版本引擎也可复用同一代数。 */
export interface TimelineInput {
  episodes: Ordered[];
  renditions: Array<{ id: string; kind: 'video' | 'audio' }>;
  scenes: Array<Ordered & { episode_id: string }>;
  beats: Array<Ordered & { scene_id: string }>;
  lines: Array<{ id: string; beat_id: string }>;
  shots: Array<Ordered & { rendition_id: string; scene_id: string; beat_refs: readonly string[]; duration: Duration }>;
  audio_tracks: Array<{ id: string; rendition_id: string; allow_overlap: boolean }>;
  audio_cues: Cue[];
}
export interface TimelineIssue { code: string; where: string; message: string }
export interface ResolvedSpan { id: string; start: Rational; end: Rational; duration: Rational }
export interface EpisodeTimeline {
  episode_id: string; rendition_id: string; duration: Rational;
  spans: ReadonlyMap<string, ResolvedSpan>;
}
export interface TimelineResolution { valid: boolean; issues: TimelineIssue[]; timelines: EpisodeTimeline[] }

const ZERO = rational(0n);
const key = (id: string, edge: 'start' | 'end') => JSON.stringify([id, edge]);
type Values = ReadonlyMap<string, Rational>;
interface Node { deps: string[]; where: string; compute: (values: Values) => Rational }
const at = (values: Values, id: string, edge: 'start' | 'end') => values.get(key(id, edge))!;

/** 端点作为独立节点；用迭代拓扑排序处理长链，避免递归栈和“整条 cue”假循环。 */
class EndpointGraph {
  private readonly nodes = new Map<string, Node>();
  constructor(private readonly issue: (code: string, where: string, message: string) => void) {}
  define(id: string, edge: 'start' | 'end', deps: string[], where: string, compute: Node['compute']): void {
    this.nodes.set(key(id, edge), { deps: [...new Set(deps)], where, compute });
  }
  private dependants(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [id, node] of this.nodes) for (const dep of node.deps) {
      const rows = result.get(dep) ?? [];
      rows.push(id); result.set(dep, rows);
    }
    return result;
  }
  dependingOn(id: string): Set<string> {
    const edges = this.dependants();
    const seen = new Set([id]);
    const queue = [id];
    for (let i = 0; i < queue.length; i++) for (const next of edges.get(queue[i]!) ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    return seen;
  }
  run(): Map<string, Rational> {
    const values = new Map<string, Rational>();
    const edges = this.dependants();
    const blocked = new Set<string>();
    const queue: string[] = [];
    for (const [id, node] of this.nodes) if (node.deps.some(dep => !this.nodes.has(dep))) { blocked.add(id); queue.push(id); }
    for (let i = 0; i < queue.length; i++) for (const next of edges.get(queue[i]!) ?? []) {
      if (!blocked.has(next)) { blocked.add(next); queue.push(next); }
    }
    const degree = new Map<string, number>();
    queue.length = 0;
    for (const [id, node] of this.nodes) if (!blocked.has(id)) {
      degree.set(id, node.deps.length);
      if (node.deps.length === 0) queue.push(id);
    }
    const failed = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      const node = this.nodes.get(id)!;
      if (node.deps.some(dep => failed.has(dep))) failed.add(id);
      else {
        try { values.set(id, node.compute(values)); }
        catch (error) {
          if (!(error instanceof TimelineError)) throw error;
          this.issue(error.code, node.where, error.message); failed.add(id);
        }
      }
      for (const next of edges.get(id) ?? []) if (!blocked.has(next)) {
        const remaining = degree.get(next)! - 1;
        degree.set(next, remaining);
        if (remaining === 0) queue.push(next);
      }
    }
    const unresolved = new Set([...this.nodes.keys()].filter(id => !blocked.has(id) && !failed.has(id) && !values.has(id)));
    if (unresolved.size) {
      // 剩余图每个节点都有未解依赖；沿依赖走入环，报告实际环中的端点而非下游集尾。
      let current = unresolved.values().next().value!;
      const visited = new Set<string>();
      while (!visited.has(current)) {
        visited.add(current);
        current = this.nodes.get(current)!.deps.find(dep => unresolved.has(dep))!;
      }
      this.issue('ANCHOR_CYCLE', this.nodes.get(current)!.where, 'Endpoint participates in a cyclic anchor dependency');
    }
    return values;
  }
}

function extreme(values: Values, refs: readonly string[], direction: 'min' | 'max'): Rational {
  let best = values.get(refs[0]!)!;
  for (const ref of refs.slice(1)) {
    const value = values.get(ref)!;
    if (compare(value, best) === (direction === 'min' ? -1 : 1)) best = value;
  }
  return best;
}

export function resolveTimeline(input: Readonly<TimelineInput>): TimelineResolution {
  const issues: TimelineIssue[] = [];
  const issue = (code: string, where: string, message: string) => { issues.push({ code, where, message }); };
  const timelines: EpisodeTimeline[] = [];
  const result = (): TimelineResolution => ({ valid: issues.length === 0, issues, timelines });
  const ids = new Set<string>();
  const collections = ['episodes', 'renditions', 'scenes', 'beats', 'lines', 'shots', 'audio_tracks', 'audio_cues'] as const;
  for (const collection of collections) for (const [i, row] of input[collection].entries()) {
    if (typeof row.id !== 'string' || !row.id) issue('IDENTIFIER', `/${collection}/${i}/id`, 'Timeline object requires a nonempty identifier');
    if (ids.has(row.id)) issue('DUPLICATE_ID', `/${collection}/${i}/id`, 'Timeline object ID is ambiguous');
    ids.add(row.id);
  }
  const episodes = new Map(input.episodes.map(e => [e.id, e]));
  const renditions = new Map(input.renditions.map(r => [r.id, r]));
  const scenes = new Map(input.scenes.map(s => [s.id, s]));
  const beats = new Map(input.beats.map(b => [b.id, b]));
  const lines = new Map(input.lines.map(l => [l.id, l]));
  const shots = new Map(input.shots.map(s => [s.id, s]));
  const cues = new Map(input.audio_cues.map(c => [c.id, c]));
  const tracks = new Map(input.audio_tracks.map(t => [t.id, t]));
  const cuePaths = new Map(input.audio_cues.map((c, i) => [c.id, `/audio_cues/${i}`]));
  const shotPaths = new Map(input.shots.map((s, i) => [s.id, `/shots/${i}`]));
  function reference<T>(map: ReadonlyMap<string, T>, id: string, where: string): void {
    if (!map.has(id)) issue('TIMELINE_REFERENCE', where, `Referenced timeline object ${id} does not exist`);
  }
  function order<T extends Ordered>(rows: readonly T[], group: (row: T) => string, collection: string): void {
    const keys = new Set<string>();
    rows.forEach((row, i) => {
      const id = JSON.stringify([group(row), row.order_key]);
      if (!/^[0-9A-Za-z]+$/.test(row.order_key) || keys.has(id)) issue('ORDER_KEY', `/${collection}/${i}/order_key`, 'Order key must be valid and unique within its sequence');
      keys.add(id);
    });
  }
  order(input.episodes, () => '', 'episodes');
  order(input.scenes, s => s.episode_id, 'scenes');
  order(input.beats, b => b.scene_id, 'beats');
  order(input.shots, s => JSON.stringify([s.rendition_id, s.scene_id]), 'shots');
  input.scenes.forEach((s, i) => reference(episodes, s.episode_id, `/scenes/${i}/episode_id`));
  input.beats.forEach((b, i) => reference(scenes, b.scene_id, `/beats/${i}/scene_id`));
  input.lines.forEach((l, i) => reference(beats, l.beat_id, `/lines/${i}/beat_id`));
  input.shots.forEach((s, i) => {
    reference(scenes, s.scene_id, `/shots/${i}/scene_id`);
    reference(renditions, s.rendition_id, `/shots/${i}/rendition_id`);
    s.beat_refs.forEach(id => {
      reference(beats, id, `/shots/${i}/beat_refs`);
      if (beats.get(id) && beats.get(id)!.scene_id !== s.scene_id) issue('ANCHOR_SCOPE', `/shots/${i}/beat_refs`, 'Shot beat belongs to another scene');
    });
    if (renditions.get(s.rendition_id)?.kind === 'audio') issue('TARGET', `/shots/${i}`, 'Audio renditions cannot contain picture shots');
  });
  input.audio_tracks.forEach((t, i) => reference(renditions, t.rendition_id, `/audio_tracks/${i}/rendition_id`));
  input.audio_cues.forEach((c, i) => {
    reference(episodes, c.episode_id, `/audio_cues/${i}/episode_id`);
    reference(renditions, c.rendition_id, `/audio_cues/${i}/rendition_id`);
    if (!tracks.has(c.track_id) || tracks.get(c.track_id)!.rendition_id !== c.rendition_id) issue('TRACK_REFERENCE', `/audio_cues/${i}/track_id`, 'Cue track is missing or belongs to another rendition');
    const checkBeatEpisode = (id: string, where: string) => {
      const b = beats.get(id);
      if (b && scenes.get(b.scene_id) && scenes.get(b.scene_id)!.episode_id !== c.episode_id)
        issue('ANCHOR_SCOPE', where, 'Cue content belongs to another episode');
    };
    if (c.line_id !== undefined) {
      reference(lines, c.line_id, `/audio_cues/${i}/line_id`);
      const line = lines.get(c.line_id);
      if (line) checkBeatEpisode(line.beat_id, `/audio_cues/${i}/line_id`);
    }
    for (const id of c.beat_refs ?? []) {
      reference(beats, id, `/audio_cues/${i}/beat_refs`);
      checkBeatEpisode(id, `/audio_cues/${i}/beat_refs`);
    }
  });
  if (issues.length) return result();

  for (const episode of [...input.episodes].sort((a, b) => compareKeys(a.order_key, b.order_key))) for (const rendition of input.renditions) {
    const graph = new EndpointGraph(issue);
    const episodeWhere = `/episodes/${input.episodes.indexOf(episode)}`;
    const groupCues = input.audio_cues.filter(c => c.episode_id === episode.id && c.rendition_id === rendition.id);
    const groupShots = input.shots.filter(s => scenes.get(s.scene_id)!.episode_id === episode.id && s.rendition_id === rendition.id)
      .sort((a, b) => compareKeys(scenes.get(a.scene_id)!.order_key, scenes.get(b.scene_id)!.order_key) || compareKeys(a.order_key, b.order_key));
    graph.define(episode.id, 'start', [], episodeWhere, () => ZERO);
    let cursor = ZERO;
    for (const shot of groupShots) {
      try {
        const start = cursor;
        cursor = add(cursor, durationValue(shot.duration));
        const end = cursor;
        graph.define(shot.id, 'start', [], shotPaths.get(shot.id)!, () => start);
        graph.define(shot.id, 'end', [], shotPaths.get(shot.id)!, () => end);
      } catch (error) {
        if (!(error instanceof TimelineError)) throw error;
        issue(error.code, shotPaths.get(shot.id)! + '/duration', error.message);
      }
    }
    const pictureDuration = cursor;
    graph.define(episode.id, 'end', [], episodeWhere, () => pictureDuration);
    const groupBeatIds = new Set(input.beats.filter(b => scenes.get(b.scene_id)!.episode_id === episode.id).map(b => b.id));
    const beatMembers = new Map<string, string[]>();
    for (const id of groupBeatIds) {
      const visual = groupShots.filter(s => s.beat_refs.includes(id)).map(s => s.id);
      const audio = groupCues.filter(c => c.line_id !== undefined ? lines.get(c.line_id)!.beat_id === id : c.beat_refs?.includes(id)).map(c => c.id);
      const members = visual.length ? visual : audio;
      if (members.length) beatMembers.set(id, members);
    }
    for (const [id, members] of beatMembers) for (const edge of ['start', 'end'] as const) {
      const refs = members.map(member => key(member, edge));
      graph.define(id, edge, refs, '/beats/' + input.beats.findIndex(b => b.id === id), values => extreme(values, refs, edge === 'start' ? 'min' : 'max'));
    }
    const endpoint = (anchor: Anchor, where: string): string | undefined => {
      const targetShot = shots.get(anchor.ref);
      const targetCue = cues.get(anchor.ref);
      const targetBeat = beats.get(anchor.ref);
      const anchorEpisode = episodes.has(anchor.ref) ? anchor.ref
        : targetShot ? scenes.get(targetShot.scene_id)!.episode_id
        : targetCue ? targetCue.episode_id
        : targetBeat ? scenes.get(targetBeat.scene_id)!.episode_id : undefined;
      const anchorRendition = targetShot?.rendition_id ?? targetCue?.rendition_id;
      if (anchorEpisode === undefined) {
        issue('ANCHOR_REFERENCE', where, `Anchor ${anchor.ref} has no timing evidence in this timeline`); return undefined;
      }
      if (anchorEpisode !== episode.id || (anchorRendition !== undefined && anchorRendition !== rendition.id)) {
        issue('ANCHOR_SCOPE', where, 'Time anchors cannot cross episodes or renditions'); return undefined;
      }
      if (targetBeat && !beatMembers.has(targetBeat.id)) {
        issue('ANCHOR_REFERENCE', where, `Beat ${anchor.ref} has no timing evidence in this rendition`); return undefined;
      }
      return key(anchor.ref, anchor.edge);
    };
    for (const cue of groupCues) {
      const where = cuePaths.get(cue.id)!;
      const start = endpoint(cue.anchor, where + '/anchor');
      if (start !== undefined) graph.define(cue.id, 'start', [start], where + '/anchor', values => add(values.get(start)!, seconds(cue.anchor.offset)));
      if (cue.extent.kind === 'fixed') {
        const duration = cue.extent.duration;
        graph.define(cue.id, 'end', [key(cue.id, 'start')], where + '/extent', values => add(at(values, cue.id, 'start'), durationValue(duration)));
      } else {
        const anchor = cue.extent.anchor;
        const end = endpoint(anchor, where + '/extent/anchor');
        if (end !== undefined) graph.define(cue.id, 'end', [end], where + '/extent/anchor', values => add(values.get(end)!, seconds(anchor.offset)));
      }
    }
    if (rendition.kind === 'audio') {
      // 音频成品以独立的声音终点推算长度；“持续至集尾”的底乐不反过来定义集尾。
      const dependants = graph.dependingOn(key(episode.id, 'end'));
      const bodyEnds = groupCues.map(c => key(c.id, 'end')).filter(id => !dependants.has(id));
      if (groupCues.length && !bodyEnds.length) issue('UNRESOLVED_DURATION', episodeWhere, 'Audio episode has no duration evidence independent of its own end');
      graph.define(episode.id, 'end', bodyEnds, episodeWhere, values => bodyEnds.length ? extreme(values, bodyEnds, 'max') : ZERO);
    }
    const values = graph.run();
    const duration = values.get(key(episode.id, 'end')) ?? ZERO;
    const spans = new Map<string, ResolvedSpan>();
    for (const id of [episode.id, ...groupShots.map(s => s.id), ...beatMembers.keys(), ...groupCues.map(c => c.id)]) {
      const start = values.get(key(id, 'start'));
      const end = values.get(key(id, 'end'));
      if (start !== undefined && end !== undefined) spans.set(id, { id, start, end, duration: subtract(end, start) });
    }
    for (const cue of groupCues) {
      const span = spans.get(cue.id);
      if (span === undefined) continue;
      const where = cuePaths.get(cue.id)!;
      if (compare(span.duration, ZERO) <= 0) issue('CUE_DURATION', where + '/extent', 'Cue end must be later than its start');
      if (compare(span.start, ZERO) < 0 || compare(span.end, duration) > 0) issue('CUE_RANGE', where, 'Cue lies outside its episode timeline');
      try {
        const fadeIn = seconds(cue.mix.fade_in_seconds);
        const fadeOut = seconds(cue.mix.fade_out_seconds);
        if (compare(fadeIn, ZERO) < 0 || compare(fadeOut, ZERO) < 0 || compare(add(fadeIn, fadeOut), span.duration) > 0)
          issue('AUDIO_FADE', where + '/mix', 'Fade durations must fit inside the cue');
      } catch (error) {
        if (!(error instanceof TimelineError)) throw error;
        issue(error.code, where + '/mix', error.message);
      }
    }
    for (const track of input.audio_tracks.filter(t => t.rendition_id === rendition.id && !t.allow_overlap)) {
      const intervals = groupCues.filter(c => c.track_id === track.id).map(c => spans.get(c.id)).filter((s): s is ResolvedSpan => s !== undefined)
        .sort((a, b) => compare(a.start, b.start));
      let previous: ResolvedSpan | undefined;
      for (const span of intervals) {
        if (previous && compare(span.start, previous.end) < 0) issue('TRACK_OVERLAP', cuePaths.get(span.id)!, `Cue overlaps ${previous.id} on track ${track.id}`);
        if (previous === undefined || compare(span.end, previous.end) > 0) previous = span;
      }
    }
    timelines.push({ episode_id: episode.id, rendition_id: rendition.id, duration, spans });
  }
  return result();
}
