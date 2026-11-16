#!/usr/bin/env python3
"""Read-only validation for the proposed storyboard-package interchange draft.

Requires jsonschema. Never runs Skill code, generators, media tools or network calls.
Validation cannot establish factual, dramatic, audiovisual or platform-import quality.
"""
import argparse
import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path, PurePosixPath

try:
    from jsonschema import Draft202012Validator
except ImportError:
    raise SystemExit('Missing dependency: jsonschema (not installed automatically).')

EPS = 1e-6
TABLES = ('revisions', 'sources', 'locations', 'characters', 'episodes', 'scene_occurrences',
          'beats', 'dialogue_lines', 'assets', 'asset_references', 'shots', 'panels',
          'audio_tracks', 'audio_cues', 'render_segments', 'adaptation_decisions')


def load_json(path):
    def reject_constant(value):
        raise ValueError('Non-finite JSON number: '+value)
    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('JSON number outside finite range: '+value)
        return number
    def unique_object(pairs):
        data = {}
        for key, value in pairs:
            if key in data:
                raise ValueError('Duplicate JSON object key: '+key)
            data[key] = value
        return data
    return json.loads(Path(path).read_text(encoding='utf-8'), parse_constant=reject_constant,
                      parse_float=finite_float, object_pairs_hook=unique_object)


def validate(package, schema, asset_root):
    errors, warnings = [], []

    def error(code, where, message):
        errors.append({'code': code, 'where': where, 'message': message})

    def warn(code, where, message):
        warnings.append({'code': code, 'where': where, 'message': message})

    def result():
        return {'valid': not errors, 'errors': errors, 'warnings': warnings,
                'meaning': 'Structure, references, declared coverage, timing and file readiness only; '
                           'not factual, artistic, audiovisual or external-platform acceptance.'}

    Draft202012Validator.check_schema(schema)
    for e in sorted(Draft202012Validator(schema).iter_errors(package), key=lambda e: str(list(e.absolute_path))):
        error('SCHEMA', '/'+ '/'.join(str(p) for p in e.absolute_path), e.message)
    if errors:
        return result()

    p = package
    idx = {}
    global_ids = {p['package_id']: 'package_id', p['project']['id']: 'project.id'}
    if p['package_id'] == p['project']['id']:
        error('DUPLICATE_ID', 'project.id', 'Package and project IDs must differ.')
    for table in TABLES:
        idx[table] = {}
        for row in p[table]:
            ident = row['id']
            if ident in global_ids:
                error('DUPLICATE_ID', table+'/'+ident, 'Already used at '+global_ids[ident])
            else:
                global_ids[ident] = table+'/'+ident
            idx[table].setdefault(ident, row)

    def need(table, ident, where, nullable=False):
        if ident is None and nullable:
            return None
        item = idx[table].get(ident)
        if item is None:
            error('MISSING_REFERENCE', where, f'{table}: {ident!r} does not exist.')
        return item

    def many(table, identifiers, where):
        return [x for ident in identifiers if (x := need(table, ident, where)) is not None]

    def span(row):
        t = row['timing']
        return t['start_seconds'], t['start_seconds'] + t['duration_seconds']

    def intersects(a, b):
        return min(a[1], b[1]) - max(a[0], b[0]) > EPS

    def sequence(rows, where):
        values = [r['sequence'] for r in rows]
        if sorted(values) != list(range(1, len(rows)+1)):
            error('SEQUENCE', where, 'Sequence must be unique and consecutive from 1.')

    active = need('revisions', p['active_revision_id'], 'active_revision_id')
    adopted = need('revisions', p['adopted_revision_id'], 'adopted_revision_id', True)
    if adopted and adopted['status'] != 'adopted':
        error('ADOPTION', 'adopted_revision_id', 'Pointer must refer to an adopted revision.')
    if active and active['status'] == 'adopted' and p['adopted_revision_id'] != active['id']:
        error('ADOPTION', 'active_revision_id', 'An adopted active body must match adopted_revision_id.')
    for revision in p['revisions']:
        parent = need('revisions', revision['parent_revision_id'], revision['id'], True)
        if parent and parent['number'] >= revision['number']:
            error('REVISION_ORDER', revision['id'], 'Parent revision number must be lower.')
        seen, current = set(), revision
        while current:
            if current['id'] in seen:
                error('REVISION_CYCLE', revision['id'], 'Revision ancestry contains a cycle.'); break
            seen.add(current['id'])
            current = idx['revisions'].get(current['parent_revision_id'])

    project_source_ids = set(p['project']['source_ids'])
    many('sources', p['project']['source_ids'], 'project.source_ids')
    scope = p['project']['scope']
    if len(p['episodes']) != scope['expected_episode_count']:
        error('SCOPE', 'project.scope', 'Declared episode count does not match the complete package.')
    if len(p['scene_occurrences']) != scope['expected_scene_count']:
        error('SCOPE', 'project.scope', 'Declared scene count does not match the complete package.')
    required_beats = [b for b in p['beats'] if b['required']]
    if len(required_beats) != scope['expected_required_beat_count']:
        error('SCOPE', 'project.scope', 'Declared required-beat count does not match the package.')
    sequence(p['episodes'], 'episodes')
    ordered_episodes=sorted(p['episodes'],key=lambda x:x['sequence'])
    if [e['id'] for e in ordered_episodes] != [e['id'] for e in p['episodes']]:
        error('EPISODE_ORDER','episodes','Array order must follow episode sequence.')
    for prev,nxt in zip(ordered_episodes,ordered_episodes[1:]):
        if span(prev)[1] > span(nxt)[0]+EPS:
            error('EPISODE_TIME',nxt['id'],'Episodes cannot overlap or restart their time at zero.')
    for episode in p['episodes']:
        if not any(s['episode_id']==episode['id'] for s in p['scene_occurrences']):
            error('EPISODE_EMPTY',episode['id'],'Every declared episode needs at least one scene occurrence.')
    sequence(p['scene_occurrences'], 'scene_occurrences')
    previous_episode_sequence=0
    for scene in sorted(p['scene_occurrences'],key=lambda x:x['sequence']):
        episode=idx['episodes'].get(scene['episode_id'])
        if episode:
            if episode['sequence'] < previous_episode_sequence:
                error('SCENE_EPISODE_ORDER',scene['id'],'Global scene order must follow episode order.')
            previous_episode_sequence=episode['sequence']
    for scene in p['scene_occurrences']:
        need('episodes',scene['episode_id'],scene['id'])
        need('locations', scene['location_id'], scene['id'], True)
        many('characters', scene['character_ids'], scene['id'])
        sequence([b for b in p['beats'] if b['scene_id'] == scene['id']], scene['id']+'/beats')
    for beat in p['beats']:
        need('scene_occurrences', beat['scene_id'], beat['id'])
        for source in beat['source_refs']:
            need('sources', source['source_id'], beat['id'])
            if source['source_id'] not in project_source_ids:
                error('SOURCE_SCOPE', beat['id'], 'Source is outside project.source_ids.')
    for line in p['dialogue_lines']:
        scene = need('scene_occurrences', line['scene_id'], line['id'])
        beat = need('beats', line['beat_id'], line['id'])
        need('characters', line['speaker_id'], line['id'])
        if beat and beat['scene_id'] != line['scene_id']:
            error('SCENE_OWNERSHIP', line['id'], 'Line and beat belong to different scene occurrences.')
        if scene and line['speaker_id'] not in scene['character_ids']:
            error('SPEAKER_SCOPE', line['id'], 'Speaker is not a participant of this scene occurrence.')

    asset_root = Path(asset_root).resolve()
    verified_assets = set()
    for asset in p['assets']:
        if asset['status'] != 'ready':
            continue
        name = asset['file']['path']
        parts = PurePosixPath(name).parts
        if name.startswith('/') or '\\' in name or '..' in parts or re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', name):
            error('ASSET_PATH', asset['id'], 'Use a relative POSIX path without traversal or URI scheme.'); continue
        file_path = (asset_root/name).resolve()
        if not file_path.is_relative_to(asset_root) or not file_path.is_file():
            error('ASSET_FILE', asset['id'], 'Ready asset is not an existing file inside asset root.'); continue
        digest = hashlib.sha256()
        with file_path.open('rb') as handle:
            for block in iter(lambda: handle.read(1024*1024), b''):
                digest.update(block)
        if digest.hexdigest() != asset['file']['sha256']:
            error('ASSET_HASH', asset['id'], 'Actual bytes do not match declared SHA-256.'); continue
        verified_assets.add(asset['id'])
    for r in p['asset_references']:
        asset = need('assets', r['asset_id'], r['id'])
        if asset and r['mode'] == 'actual' and asset['id'] not in verified_assets:
            error('ACTUAL_REFERENCE', r['id'], 'Actual reference requires a verified ready file.')
        if asset and r['mode'] == 'planned' and asset['status'] == 'ready':
            error('PLANNED_REFERENCE', r['id'], 'Adopt an actual reference or keep the asset planned/missing.')
    for character in p['characters']:
        ar = need('asset_references', character['voice_reference_id'], character['id'], True)
        if ar and ar['purpose'] != 'voice':
            error('VOICE_REFERENCE', character['id'], 'Voice reference must have purpose=voice.')
        if ar and (a := idx['assets'].get(ar['asset_id'])) and a['media_type'] != 'audio':
            error('VOICE_REFERENCE', character['id'], 'Voice reference asset must be audio.')

    total = p['project']['target_duration_seconds']
    for table in ('episodes', 'shots', 'audio_cues', 'render_segments'):
        for row in p[table]:
            start, end = span(row)
            if not all(math.isfinite(x) for x in (start, end)) or end > total+EPS:
                error('TIMING', row['id'], 'Timing must be finite and inside the declared project duration.')
            t = row['timing']
            if t['basis'] == 'measured':
                a = need('assets', t['measurement_asset_id'], row['id'])
                if a and a['id'] not in verified_assets:
                    error('MEASUREMENT_ASSET', row['id'], 'Measured timing requires an available evidence asset.')

    sequence(p['shots'], 'shots')
    ordered = sorted(p['shots'], key=lambda x:x['sequence'])
    if [s['id'] for s in ordered] != [s['id'] for s in p['shots']]:
        error('SHOT_ORDER', 'shots', 'Array order must follow sequence.')
    for prev, nxt in zip(ordered, ordered[1:]):
        if span(prev)[1] > span(nxt)[0]+EPS:
            error('SHOT_OVERLAP', nxt['id'], 'Visual shots overlap on the single ordered picture track.')
        a, b = idx['scene_occurrences'].get(prev['scene_id']), idx['scene_occurrences'].get(nxt['scene_id'])
        if a and b and a['sequence'] > b['sequence']:
            error('SCENE_ORDER', nxt['id'], 'Use a new occurrence for a later return or flashback to a location.')
    for shot in p['shots']:
        scene=need('scene_occurrences', shot['scene_id'], shot['id'])
        episode=idx['episodes'].get(scene['episode_id']) if scene else None
        if episode and (span(shot)[0] < span(episode)[0]-EPS or span(shot)[1] > span(episode)[1]+EPS):
            error('SHOT_EPISODE_TIME',shot['id'],'Shot lies outside its scene episode on the global timeline.')
        many('asset_references', shot['asset_ref_ids'], shot['id'])
        for beat in many('beats', shot['beat_refs'], shot['id']):
            if beat['scene_id'] != shot['scene_id']:
                error('SCENE_OWNERSHIP', shot['id'], 'A shot cannot claim a beat from another scene occurrence.')
    for panel in p['panels']:
        shot = need('shots', panel['shot_id'], panel['id'])
        ar = need('asset_references', panel['asset_ref_id'], panel['id'], True)
        if shot:
            duration, offset = shot['timing']['duration_seconds'], panel['offset_seconds']
            valid = offset <= duration+EPS
            valid &= (abs(offset) <= EPS if panel['position']=='start' else
                      abs(offset-duration) <= EPS if panel['position']=='end' else EPS < offset < duration-EPS)
            if not valid: error('PANEL_TIME', panel['id'], 'Key moment does not match the shot interval/position.')
        if panel['status']=='ready' and (not ar or ar['mode']!='actual'):
            error('PANEL_READINESS', panel['id'], 'Ready panel requires an actual image reference.')
        if ar and (a := idx['assets'].get(ar['asset_id'])) and a['media_type']!='image':
            error('PANEL_ASSET', panel['id'], 'Panel reference must resolve to an image.')

    track_cues = defaultdict(list)
    for cue in p['audio_cues']:
        track = need('audio_tracks', cue['track_id'], cue['id'])
        scene=need('scene_occurrences', cue['scene_id'], cue['id'], True)
        declared_episodes=many('episodes',cue['episode_ids'],cue['id'])
        touched={e['id'] for e in p['episodes'] if intersects(span(cue),span(e))}
        if set(cue['episode_ids']) != touched:
            error('AUDIO_EPISODE_SCOPE',cue['id'],'Declare exactly every episode intersected by this cue; crossing is never implicit.')
        if scene and scene['episode_id'] not in cue['episode_ids']:
            error('AUDIO_EPISODE_OWNERSHIP',cue['id'],'Cue must include the episode of its associated scene.')
        cursor=span(cue)[0]
        for episode in sorted(declared_episodes,key=lambda e:span(e)[0]):
            lo,hi=max(span(cue)[0],span(episode)[0]),min(span(cue)[1],span(episode)[1])
            if hi<=lo+EPS: continue
            if lo>cursor+EPS:
                error('AUDIO_EPISODE_TIME',cue['id'],'Cue crosses time not covered by declared episodes.');break
            cursor=max(cursor,hi)
        if cursor < span(cue)[1]-EPS:
            error('AUDIO_EPISODE_TIME',cue['id'],'Cue extends outside its declared episode ranges.')
        if track and track['role'] != cue['kind']:
            error('TRACK_ROLE', cue['id'], 'Cue kind differs from the track role.')
        track_cues[cue['track_id']].append(cue)
        many('asset_references', cue['asset_ref_ids'], cue['id'])
        for beat in many('beats', cue['beat_refs'], cue['id']):
            if cue['scene_id'] and beat['scene_id'] != cue['scene_id']:
                error('SCENE_OWNERSHIP', cue['id'], 'Cue beat is from another scene occurrence.')
        for shot in many('shots', cue['shot_refs'], cue['id']):
            if not intersects(span(cue), span(shot)):
                error('AUDIO_SHOT_TIME', cue['id'], 'Referenced shot has no temporal intersection.')
            if cue['scene_id'] and shot['scene_id'] != cue['scene_id']:
                error('SCENE_OWNERSHIP', cue['id'], 'Use scene_id=null for a global cross-scene cue.')
        if cue['kind'] in ('dialogue','narration'):
            need('characters', cue['speaker_id'], cue['id'])
            line = need('dialogue_lines', cue['line_id'], cue['id'])
            if line and any(cue[k] != line[k] for k in ('scene_id','speaker_id','kind','text')):
                error('AUDIO_SCRIPT', cue['id'], 'Spoken words, kind, speaker and scene must match the script line.')
            if line and line['beat_id'] not in cue['beat_refs']:
                error('AUDIO_BEAT', cue['id'], 'Cue must carry the beat of its canonical script line.')
        if cue['mix']['fade_in_seconds']+cue['mix']['fade_out_seconds'] > cue['timing']['duration_seconds']+EPS:
            error('AUDIO_FADE', cue['id'], 'Combined fade intervals exceed cue duration.')
    for tid, cues in track_cues.items():
        track = idx['audio_tracks'].get(tid)
        if track and not track['allow_overlap']:
            ordered_cues = sorted(cues,key=lambda c:span(c)[0])
            for prev,nxt in zip(ordered_cues,ordered_cues[1:]):
                if intersects(span(prev),span(nxt)):
                    error('TRACK_OVERLAP', nxt['id'], 'Track does not permit overlapping cues.')

    visual_uses, video_cues, audio_cues = Counter(), set(), set()
    for segment in p['render_segments']:
        modality = segment['media_type']
        if modality not in p['project']['targets']:
            error('TARGET', segment['id'], 'Segment modality is not a project target.')
        shots = many('shots', segment['shot_ids'], segment['id'])
        cues = many('audio_cues', segment['audio_cue_ids'], segment['id'])
        refs = many('asset_references', segment['required_asset_ref_ids'], segment['id'])
        if modality=='video':
            visual_uses.update(segment['shot_ids']); video_cues.update(segment['audio_cue_ids'])
            seq = [s['sequence'] for s in shots]
            if seq and seq != list(range(seq[0],seq[0]+len(seq))):
                error('SEGMENT_ORDER', segment['id'], 'Video segment shots must be consecutive and ordered.')
            for shot in shots:
                if span(shot)[0] < span(segment)[0]-EPS or span(shot)[1] > span(segment)[1]+EPS:
                    error('SEGMENT_SHOT_TIME', segment['id'], 'Segment must contain each assigned shot interval.')
        else:
            audio_cues.update(segment['audio_cue_ids'])
        for cue in cues:
            if not intersects(span(cue),span(segment)):
                error('SEGMENT_AUDIO_TIME', segment['id'], 'Assigned audio cue does not intersect this segment.')
        if segment['status'] in ('ready','produced'):
            for ar in refs:
                if ar['mode']!='actual': error('SEGMENT_READINESS',segment['id'],'Required reference is still planned.')
        out = need('assets',segment['output_asset_id'],segment['id'],True)
        if segment['status']=='produced' and (not out or out['id'] not in verified_assets or out['media_type']!=modality):
            error('SEGMENT_OUTPUT',segment['id'],'Produced output requires a verified file of matching media type.')
    if 'video' in p['project']['targets']:
        if not p['shots']: error('VIDEO_EMPTY','shots','Video target requires a visual plan.')
        for shot in p['shots']:
            if visual_uses[shot['id']] != 1:
                error('SHOT_DELIVERY',shot['id'],'Each shot must belong to exactly one video render segment in this rendition.')
    if 'audio' in p['project']['targets'] and not audio_cues:
        error('AUDIO_EMPTY','render_segments','Audio target requires an audio delivery segment.')

    coverage = {}
    for row in p['coverage']:
        bid = row['beat_id'];need('beats',bid,'coverage')
        if bid in coverage: error('COVERAGE_DUPLICATE',bid,'A beat has more than one coverage row.')
        coverage[bid] = row
        for shot in many('shots',row['shot_ids'],bid):
            if bid not in shot['beat_refs']: error('COVERAGE_EDGE',bid,'Shot does not claim this beat.')
        for cue in many('audio_cues',row['audio_cue_ids'],bid):
            if bid not in cue['beat_refs']: error('COVERAGE_EDGE',bid,'Audio cue does not claim this beat.')
        decision = need('adaptation_decisions',row['decision_id'],bid,True)
        if decision and bid not in decision['affected_beat_ids']:
            error('DECISION_EDGE',bid,'Decision does not cover this beat.')
    for d in p['adaptation_decisions']:
        many('beats',d['affected_beat_ids']+d['replacement_beat_ids'],d['id'])
        if set(d['affected_beat_ids']) & set(d['replacement_beat_ids']):
            error('DECISION_CYCLE',d['id'],'A replacement cannot replace a beat with itself.')

    def covered(bid, target, seen=None):
        seen = set() if seen is None else set(seen)
        if bid in seen: return False
        seen.add(bid); row = coverage.get(bid)
        if not row:return False
        if target=='audio':
            direct = bool(set(row['audio_cue_ids']) & audio_cues)
        elif target=='video':
            direct = any(visual_uses[sid] for sid in row['shot_ids']) or bool(set(row['audio_cue_ids']) & video_cues)
        else: direct = bool(row['shot_ids'] or row['audio_cue_ids'])
        if direct:return True
        d = idx['adaptation_decisions'].get(row['decision_id'])
        if not d or d['status']!='approved' or bid not in d['affected_beat_ids']:return False
        if d['action']=='omit':return True
        return all(covered(replacement,target,seen) for replacement in d['replacement_beat_ids'])

    for beat in required_beats:
        for target in p['project']['targets']:
            if not covered(beat['id'],target):
                error('BEAT_COVERAGE',beat['id'],f'Required beat lacks {target} delivery coverage or an approved adaptation decision.')
    for table, field, cf in [('shots','beat_refs','shot_ids'),('audio_cues','beat_refs','audio_cue_ids')]:
        for row in p[table]:
            for bid in row[field]:
                if bid in coverage and row['id'] not in coverage[bid][cf]:
                    error('COVERAGE_LEDGER',row['id'],'Declared beat edge is missing from its coverage row.')

    if p['export']['status'] in ('render_ready','exported'):
        if not active or active['status']!='adopted' or p['adopted_revision_id']!=p['active_revision_id']:
            error('EXPORT_READINESS','export','Ready handoff requires an adopted active revision.')
        used_refs = {rid for group,field in [(p['shots'],'asset_ref_ids'),(p['audio_cues'],'asset_ref_ids'),
            (p['render_segments'],'required_asset_ref_ids')] for row in group for rid in row[field]}
        used_refs.update(x['asset_ref_id'] for x in p['panels'] if x['asset_ref_id'])
        for rid in used_refs:
            ar=idx['asset_references'].get(rid)
            if ar and ar['mode']!='actual': error('EXPORT_READINESS',rid,'Handoff prerequisite is a plan, not a real asset.')
        if p['export']['unsupported_features']:
            error('EXPORT_LOSS','export','Resolve unsupported features before declaring a ready handoff.')

    planned = sum(a['status']!='ready' for a in p['assets'])
    if planned:warn('PLANNED_MEDIA','assets',f'{planned} media assets are plans or missing; no media quality was verified.')
    if all(r['timing']['basis']=='estimated' for table in ('shots','audio_cues','render_segments') for r in p[table]):
        warn('ESTIMATED_TIMING','timing','Timing is planned; actual speech, motion and edit timing must be measured later.')
    if any(s['capture_state']=='reference_only' for s in p['sources']):
        warn('REFERENCE_ONLY','sources','Some sources are links, not captured complete text. Factual coverage is not verified.')
    return result()


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('package',type=Path)
    ap.add_argument('--schema',type=Path,default=Path(__file__).resolve().parents[1]/'contracts/storyboard_package.schema.json')
    ap.add_argument('--asset-root',type=Path,help='Root for relative ready-asset paths; defaults to package directory.')
    args=ap.parse_args()
    try:
        report=validate(load_json(args.package),load_json(args.schema),args.asset_root or args.package.parent)
    except (OSError,ValueError) as exc:
        report={'valid':False,'errors':[{'code':'INPUT','where':str(args.package),'message':str(exc)}],'warnings':[]}
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if report['valid'] else 1


if __name__=='__main__':
    raise SystemExit(main())
