import {expect,it} from 'vitest';
import {z} from 'zod';
import {captureScreenplay,freezeScreenplay} from '../src/screenplay/boundary.js';
import {validateScreenplayContext,inspectScreenplayDraft,projectScreenplayContinuity} from '../src/screenplay/context.js';
import {SCREENPLAY_DRAFT_BYTES,ScreenplayError} from '../src/screenplay/contracts.js';
import {CONTINUITY_LEDGER_BYTES} from '../src/continuity/contracts.js';
import type {ScreenplayIssueCode,ScreenplayBeatSchema} from '../src/screenplay/contracts.js';
import {screenplayFixture} from './screenplay-support.js';

const codes=(issues:readonly {code:ScreenplayIssueCode}[])=>issues.map(issue=>issue.code);
const inspect=(f:ReturnType<typeof screenplayFixture>)=>inspectScreenplayDraft(f.context,f.draft);

it.each(['project','package','revision','native-order','episode-id','episode-number','episode-version'] as const)('rejects inconsistent writing/native context binding %s',field=>{
  const f=screenplayFixture();if(field==='project')f.context.projectId=f.id('foreign-project');else if(field==='package')f.context.packageId=f.id('foreign-package');else if(field==='revision')f.context.snapshotRevision++;else if(field==='native-order'){f.context.nativeContext=structuredClone(f.context.nativeContext);f.context.nativeContext.events[0]!.sequence=2;}else if(field==='episode-id')f.context.episode.id=f.id('foreign-episode');else if(field==='episode-number')f.context.episode.number=2;else f.context.episode.version++;
  expect(()=>validateScreenplayContext(f.context)).toThrow('INVALID_REFERENCE');
});

it('refuses a draft for a different actual episode before projecting local events',()=>{
  const f=screenplayFixture();f.draft.episodeId=f.id('different-draft-episode');expect(()=>inspect(f)).toThrow('CONFLICT');expect(()=>projectScreenplayContinuity(f.context,f.draft)).toThrow('CONFLICT');
});

it.each(['unexpected-first','missing-later','nonadjacent-id','number','version','ledger-episode','ledger-project','ledger-package','future-adoption','future-source','invalid-ledger'] as const)('rejects an inconsistent previous-episode constraint %s',field=>{
  const f=screenplayFixture(field==='unexpected-first'?1:2),previous=screenplayFixture(2).context.previous!;
  if(field==='unexpected-first')f.context.previous=previous;else if(field==='missing-later')f.context.previous=null;else{
    const value=f.context.previous!;if(field==='nonadjacent-id')value.episode.id=f.context.episode.id;else if(field==='number')value.episode.number=2;else if(field==='version')value.episode.version++;else if(field==='ledger-episode')value.ledger.episodeId=f.context.episode.id;else if(field==='ledger-project')value.ledger.projectId=f.id('foreign-ledger-project');else if(field==='ledger-package')value.ledger.packageId=f.id('foreign-ledger-package');else if(field==='future-adoption')value.adoptedRevision=f.context.snapshotRevision+1;else if(field==='future-source')value.ledger.snapshotRevision=value.adoptedRevision+1;else value.ledger.knowledge[0]!.factId='missing-previous-fact';
  }
  expect(()=>validateScreenplayContext(f.context)).toThrow('INVALID_REFERENCE');
});

it.each(['characters','locations','references','outline-id','outline-order','outline-character','outline-reference','module-id','module-kind'] as const)('requires unique identities in the projected %s namespace',field=>{
  const f=screenplayFixture();if(field==='characters')f.context.characters.push(structuredClone(f.context.characters[0]!));else if(field==='locations')f.context.locations.push(structuredClone(f.context.locations[0]!));else if(field==='references')f.context.references.push(structuredClone(f.context.references[0]!));else if(field==='outline-id')f.context.outline.beats.push({...structuredClone(f.context.outline.beats[0]!),order:2});else if(field==='outline-order')f.context.outline.beats.push({...structuredClone(f.context.outline.beats[0]!),ref:{id:f.id('new-outline-beat'),version:1}});else if(field==='outline-character')f.context.outline.beats[0]!.characters.push(structuredClone(f.context.outline.beats[0]!.characters[0]!));else if(field==='outline-reference')f.context.outline.beats[0]!.referenceIds.push(f.context.outline.beats[0]!.referenceIds[0]!);else if(field==='module-id')f.context.rules.firstEpisode!.modules[1]!.id=f.context.rules.firstEpisode!.modules[0]!.id;else f.context.rules.firstEpisode!.modules[0]!.requiredKinds=['action','action'];
  expect(()=>validateScreenplayContext(f.context)).toThrow('INVALID_REFERENCE');
});

it.each(['character-version','unknown-character','beat-character-version','unknown-reference','backward-outline','opening-ref','closing-version'] as const)('checks exact projected source relationships: %s',field=>{
  const f=screenplayFixture();if(field==='character-version')f.context.characters[0]!.version++;else if(field==='unknown-character')f.context.characters[0]!.id=f.id('unknown-source-character');else if(field==='beat-character-version')f.context.outline.beats[0]!.characters[0]!.version++;else if(field==='unknown-reference')f.context.outline.beats[0]!.referenceIds=['unknown-source'];else if(field==='backward-outline'){
    const first=f.context.outline.beats[0]!;first.order=2;f.context.outline.beats.push({...structuredClone(first),ref:{id:f.id('earlier-outline-beat'),version:1},order:1});
  }else if(field==='opening-ref')f.context.outline.openingHook.beat.id=f.id('unknown-outline-hook');else f.context.outline.cliffhanger.beat.version++;
  expect(()=>validateScreenplayContext(f.context)).toThrow('INVALID_REFERENCE');
});

it.each(['on_screen','inner_monologue','off_screen','narration'] as const)('requires an ordered configured speech-rate interval for %s',kind=>{
  const f=screenplayFixture();f.context.rules.speech.rates[kind]={minCharactersPerSecond:6,maxCharactersPerSecond:3};expect(()=>validateScreenplayContext(f.context)).toThrow('INVALID_REFERENCE');
});

it.each(['project','package','plan','episode-plan','outline-beat','location','episode','character','prop','appearance','spot','native-location','native-event','previous-snapshot'] as const)('does not let a local event impersonate a formal %s identity',kind=>{
  const f=screenplayFixture(kind==='previous-snapshot'?2:1),context=f.context,native=context.nativeContext;
  const reserved=kind==='project'?context.projectId:kind==='package'?context.packageId:kind==='plan'?context.outline.plan.id:kind==='episode-plan'?context.outline.episodePlan.id:kind==='outline-beat'?context.outline.beats[0]!.ref.id:kind==='location'?context.locations[0]!.id:kind==='episode'?native.episodes[0]!.id:kind==='character'?native.characters[0]!.id:kind==='prop'?native.props[0]!.id:kind==='appearance'?native.appearances[0]!.id:kind==='spot'?native.spots[0]!.id:kind==='native-location'?native.spots[0]!.location.id:kind==='native-event'?native.events[0]!.ref.id:context.previous!.snapshot.id;
  f.draft.scenes[0]!.beats[0]!.id=reserved;expect(codes(inspect(f).issues)).toContain('DUPLICATE_ID');
});

it.each(['scene','beat','line','participants','outline-refs'] as const)('locates duplicate draft identities or references at the actual %s field',kind=>{
  const f=screenplayFixture(),scene=f.draft.scenes[0]!;
  if(kind==='scene'){const duplicate=structuredClone(scene);duplicate.beats=[{...structuredClone(scene.beats[0]!),id:'other-beat'}];f.draft.scenes.push(duplicate);}
  else if(kind==='beat')scene.beats[1]!.id=scene.beats[0]!.id;else if(kind==='line')scene.beats[1]!.lines[0]!.id=scene.beats[0]!.id;else if(kind==='participants')scene.characterIds.push(scene.characterIds[0]!);else scene.beats[0]!.outlineBeatIds.push(scene.beats[0]!.outlineBeatIds[0]!);
  expect(codes(inspect(f).issues)).toContain('DUPLICATE_ID');const preview=projectScreenplayContinuity(f.context,f.draft);expect(preview.ledger).toBeNull();expect(preview.references).toEqual([]);
});

it.each(['participant','speaker','location','outline','source'] as const)('rejects a draft reference outside the projected actual %s directory',kind=>{
  const f=screenplayFixture(),scene=f.draft.scenes[0]!;
  if(kind==='participant')scene.characterIds.push(f.id('unregistered-character'));else if(kind==='speaker')scene.beats[1]!.lines[0]!.speakerId=f.id('unregistered-speaker');else if(kind==='location')scene.locationId=f.id('unregistered-location');else if(kind==='outline')scene.beats[0]!.outlineBeatIds=[f.id('other-episode-outline')];else scene.beats[0]!.origin.citations=[{referenceId:'not-reviewed-source',relationship:'adapted',quote:null}];
  const expected=kind==='participant'||kind==='speaker'?'UNKNOWN_CHARACTER':kind==='location'?'UNKNOWN_LOCATION':kind==='outline'?'UNKNOWN_OUTLINE_BEAT':'UNKNOWN_SOURCE';expect(codes(inspect(f).issues)).toContain(expected);
});

it.each(['invented-without-reason','adapted-without-citation','adapted-without-outline'] as const)('requires meaningful source/originality annotations: %s',kind=>{
  const f=screenplayFixture(),beat=f.draft.scenes[0]!.beats[0]!;
  if(kind==='invented-without-reason')beat.origin.reason=null;else{beat.origin={kind:'adapted',reason:null,citations:kind==='adapted-without-citation'?[]:[{referenceId:f.context.references[0]!.id,relationship:'adapted',quote:null}]};if(kind==='adapted-without-outline')beat.outlineBeatIds=[];}
  expect(codes(inspect(f).issues)).toContain('ORIGIN_REQUIRED');
});

it('accepts an adapted real quote substring but rejects a quote supported only by the display text',()=>{
  const f=screenplayFixture(),reference=f.context.references[0]!,beat=f.draft.scenes[0]!.beats[0]!;beat.origin={kind:'adapted',reason:null,citations:[{referenceId:reference.id,relationship:'quoted',quote:'推门看见'}]};
  expect(codes(inspect(f).issues)).not.toContain('ORIGIN_REQUIRED');expect(codes(inspect(f).issues)).not.toContain('SOURCE_QUOTE');reference.quotes=[];expect(reference.text).toContain('推门看见');expect(codes(inspect(f).issues)).toContain('SOURCE_QUOTE');
});

it.each(['quoted-null','quoted-fake','inspired-fake','unknown-quoted'] as const)('checks citation evidence independently of the relationship label: %s',kind=>{
  const f=screenplayFixture(),beat=f.draft.scenes[0]!.beats[0]!;beat.origin.citations=[{referenceId:kind==='unknown-quoted'?'unknown-reference':f.context.references[0]!.id,relationship:kind==='inspired-fake'?'inspired':'quoted',quote:kind==='quoted-null'?null:'原文没有这一句。'}];
  const report=inspect(f);expect(codes(report.issues)).toContain('SOURCE_QUOTE');if(kind==='unknown-quoted')expect(codes(report.issues)).toContain('UNKNOWN_SOURCE');
});

it.each(['on_screen','inner_monologue','off_screen','narration'] as const)('requires the actual %s speaker to be explicitly included in scene participation',kind=>{
  const f=screenplayFixture(),scene=f.draft.scenes[0]!,beat=scene.beats[1]!;scene.characterIds=[];beat.lines[0]!.kind=kind;beat.kind=kind==='narration'?'narration':'dialogue';
  expect(codes(inspect(f).issues)).toContain('SCENE_SPEAKER');expect(codes(inspect(f).issues)).not.toContain('UNKNOWN_CHARACTER');
});

it.each(['action-with-line','empty-dialogue','empty-narration','narration-as-dialogue','dialogue-as-narration'] as const)('reports incompatible beat/voice structure: %s',kind=>{
  const f=screenplayFixture(),scene=f.draft.scenes[0]!,beat=scene.beats[1]!;if(kind==='action-with-line')beat.kind='action';else if(kind==='empty-dialogue')beat.lines=[];else if(kind==='empty-narration'){beat.kind='narration';beat.lines=[];}else if(kind==='narration-as-dialogue')beat.lines[0]!.kind='narration';else beat.kind='narration';
  expect(codes(inspect(f).issues)).toContain('VOICE_SEMANTICS');
});

it.each(['inner_monologue','off_screen'] as const)('keeps a valid %s voice distinct without demanding an on-screen mouth',kind=>{
  const f=screenplayFixture();f.draft.scenes[0]!.beats[1]!.lines[0]!.kind=kind;expect(inspect(f).issues).toEqual([]);
});

it('reports inverse pause intervals without silently swapping the authored range',()=>{
  const f=screenplayFixture(),pause={minMs:2000,maxMs:500};f.draft.scenes[0]!.beats[0]!.plannedPause=pause;expect(codes(inspect(f).issues)).toContain('PLANNED_RANGE');expect(pause).toEqual({minMs:2000,maxMs:500});
});

it.each(['unknown-local','wrong-kind','fake-quote','duplicate-declaration','unknown-character','unknown-state-character'] as const)('requires local continuity evidence and declared real characters: %s',kind=>{
  const f=screenplayFixture(),evidence={event:{kind:'beat' as const,id:'action-0'},quote:f.draft.scenes[0]!.beats[0]!.summary};
  f.draft.continuity=[{id:'assert-note',op:'assert_fact',factId:'note',kind:'fact',text:'本稿明确声明的事实。',evidence}];
  if(kind==='unknown-local')evidence.event.id='unknown-event';else if(kind==='wrong-kind')f.draft.continuity[0]!.evidence.event.kind='line';else if(kind==='fake-quote')evidence.quote='不在本稿里的句子';else if(kind==='duplicate-declaration')f.draft.continuity.push(structuredClone(f.draft.continuity[0]!));else if(kind==='unknown-character')f.draft.continuity.push({id:'learn-note',op:'learn',characterId:f.id('unknown-continuity-character'),factId:'note',source:{kind:'witness'},evidence:structuredClone(evidence)});else f.draft.continuity.push({id:'state-note',op:'set_character',value:{characterId:f.id('unknown-state-character'),summary:'状态声明。',appearance:null,spot:null,holding:[]},evidence:structuredClone(evidence)});
  expect(codes(inspect(f).issues)).toContain(kind==='duplicate-declaration'?'DUPLICATE_ID':kind==='unknown-character'||kind==='unknown-state-character'?'UNKNOWN_CHARACTER':'CONTINUITY_REFERENCE');expect(projectScreenplayContinuity(f.context,f.draft).ledger).toBeNull();
});

it.each(['appearance','spot','prop','informant'] as const)('keeps invalid %s references out of the causal preview without leaking native diagnostics',kind=>{
  const f=screenplayFixture(),evidence={event:{kind:'beat' as const,id:'action-0'},quote:f.draft.scenes[0]!.beats[0]!.summary};
  if(kind==='informant')f.draft.continuity=[{id:'bad-informant',op:'learn',characterId:f.speaker,factId:'note',source:{kind:'told',fromCharacterId:f.id('unknown-informant')},evidence}];
  else f.draft.continuity=[{id:'bad-state',op:'set_character',value:{characterId:f.speaker,summary:'需要校验实际物理引用。',appearance:kind==='appearance'?{id:f.id('unknown-appearance'),version:1}:null,spot:kind==='spot'?{id:f.id('unknown-spot'),location:{id:f.context.locations[0]!.id,version:1}}:null,holding:kind==='prop'?[{id:f.id('unknown-prop'),version:1}]:[]},evidence}];
  expect(inspect(f).issues).toEqual([]);const projection=projectScreenplayContinuity(f.context,f.draft);expect(projection.ledger).toBeNull();expect(projection.issues).toMatchObject([{code:'CONTINUITY_REFERENCE',severity:'error'}]);expect(projection.issues[0]!.detail).not.toContain('unknown-');
});

it('does not assign narration-derived knowledge to a character',()=>{
  const f=screenplayFixture(),scene=f.draft.scenes[0]!,line=scene.beats[1]!.lines[0]!,intro={event:{kind:'beat' as const,id:'action-0'},quote:scene.beats[0]!.summary};scene.beats[1]!.kind='narration';line.kind='narration';
  f.draft.continuity=[{id:'assert-note',op:'assert_fact',factId:'note',kind:'fact',text:'明确声明便签。',evidence:intro},{id:'narration-learning',op:'learn',characterId:f.speaker,factId:'note',source:{kind:'witness'},evidence:{event:{kind:'line',id:line.id},quote:line.text}}];
  const projection=projectScreenplayContinuity(f.context,f.draft);expect(codes(projection.issues)).toContain('CONTINUITY_RULE');expect(projection.ledger?.knowledge).toEqual([]);
});

it('inherits every previous ledger column yet keeps current references explicitly provisional and the source unchanged',()=>{
  const f=screenplayFixture(2),before=structuredClone(f.context),projection=projectScreenplayContinuity(f.context,f.draft);expect(projection.kind).toBe('candidate_projection');
  for(const key of ['facts','knowledge','characters','threads'] as const)expect(projection.ledger?.[key]).toEqual(f.context.previous!.ledger[key]);
  expect(projection.references.every(row=>row.ref.version===1&&row.ref.id!==row.localId)).toBe(true);expect(Object.hasOwn(projection,'adopted')).toBe(false);expect(Object.hasOwn(projection,'proofDigest')).toBe(false);expect(f.context).toEqual(before);
});

it('avoids occupied native identities when allocating disposable preview event references',()=>{
  const f=screenplayFixture(),occupied='00000000000000000000000001';f.context.nativeContext=structuredClone(f.context.nativeContext);f.context.nativeContext.props.push({id:occupied,version:1});const first=projectScreenplayContinuity(f.context,f.draft),second=projectScreenplayContinuity(f.context,f.draft);
  expect(first.references[0]!.ref.id).not.toBe(occupied);expect(new Set(first.references.map(row=>row.ref.id)).size).toBe(first.references.length);expect(first.references).toEqual(second.references);
});

it('enforces the aggregate beat limit across individually legal scenes',()=>{
  const f=screenplayFixture(),template: z.infer<typeof ScreenplayBeatSchema>={id:'template',kind:'action',summary:'动作。',outlineBeatIds:[],origin:{kind:'invented',reason:'原创动作。',citations:[]},plannedPause:{minMs:0,maxMs:0},lines:[]},scene=f.draft.scenes[0]!;
  scene.beats=Array.from({length:1025},(_,index)=>({...template,id:'a'+index}));f.draft.scenes.push({...scene,id:'other-scene',beats:Array.from({length:1024},(_,index)=>({...template,id:'b'+index}))});expect(Buffer.byteLength(JSON.stringify(f.draft))).toBeLessThan(SCREENPLAY_DRAFT_BYTES);
  expect(()=>inspect(f)).toThrow('INPUT_LIMIT');f.draft.scenes[1]!.beats.pop();expect(inspect(f).issues).toEqual([]);
});

it('enforces the aggregate line limit without truncating otherwise legal per-beat arrays',()=>{
  const f=screenplayFixture(),scene=f.draft.scenes[0]!,first=scene.beats[0]!,second=scene.beats[1]!,line={id:'template',speakerId:f.speaker,kind:'on_screen' as const,text:'说',delivery:'平'};first.kind='dialogue';first.lines=Array.from({length:8192},(_,index)=>({...line,id:'l'+index}));second.lines=[{...line,id:'overflow-line'}];
  expect(Buffer.byteLength(JSON.stringify(f.draft))).toBeLessThan(SCREENPLAY_DRAFT_BYTES);expect(()=>inspect(f)).toThrow('INPUT_LIMIT');first.lines.pop();expect(inspect(f).issues).toEqual([]);
});

it('propagates the full-ledger byte limit when legal previous and current declarations grow beyond it together',()=>{
  const f=screenplayFixture(2),previous=f.context.previous!,event=f.context.nativeContext.events.find(row=>row.episodeId===previous.episode.id&&row.ref.kind==='beat')!,ledger=previous.ledger;
  ledger.facts=Array.from({length:1400},(_,index)=>({id:'prior-fact-'+index,kind:'fact',text:'P'.repeat(1000),introduced:{episodeId:previous.episode.id,eventId:'prior-declaration-'+index,order:index+1,evidence:{event:{...event.ref},quote:event.text}},retired:null}));ledger.knowledge=[];ledger.characters=[];ledger.threads=[];
  const evidence={event:{kind:'beat' as const,id:'action-0'},quote:f.draft.scenes[0]!.beats[0]!.summary};f.draft.continuity=Array.from({length:400},(_,index)=>({id:'current-declaration-'+index,op:'assert_fact',factId:'current-fact-'+index,kind:'fact',text:'C'.repeat(1000),evidence:structuredClone(evidence)}));
  expect(Buffer.byteLength(JSON.stringify(ledger))).toBeLessThan(CONTINUITY_LEDGER_BYTES);expect(Buffer.byteLength(JSON.stringify(f.draft))).toBeLessThan(SCREENPLAY_DRAFT_BYTES);expect(inspect(f).issues).toEqual([]);
  expect(()=>projectScreenplayContinuity(f.context,f.draft)).toThrow('INPUT_LIMIT');
});

it('captures valid null-prototype input while rejecting nested accessors and opaque traps without diagnostics leakage',()=>{
  const f=screenplayFixture(),plain=Object.assign(Object.create(null) as Record<string,unknown>,f.context);expect(validateScreenplayContext(plain)).toEqual(f.context);
  let touched=false;const unsafe=Object.defineProperty({...f.context},'episode',{enumerable:true,get:()=>{touched=true;return f.context.episode;}});expect(()=>validateScreenplayContext(unsafe)).toThrow('INVALID_INPUT');expect(touched).toBe(false);
  const opaqueError=new Proxy(new Error('private-storage-uri'),{getPrototypeOf:()=>{throw new Error('private-prototype');}}),opaque=new Proxy({}, {ownKeys:()=>{throw opaqueError;}});let error:unknown;try{captureScreenplay(z.unknown(),opaque,'opaque input',128);}catch(value){error=value;}
  expect(error).toMatchObject({code:'INVALID_INPUT'});expect(error instanceof Error&&error.message.includes('private')).toBe(false);
});

it('applies UTF-8 byte budgets before schema errors and freezes captured plain values recursively',()=>{
  const schema=z.strictObject({text:z.string()}),valid=captureScreenplay(schema,{text:'汉'},'byte budget',15);expect(valid.text).toBe('汉');expect(()=>captureScreenplay(schema,{text:'汉汉'},'byte budget',15)).toThrow('INPUT_LIMIT');
  expect(()=>captureScreenplay(schema,{unexpected:'must not leak'},'schema boundary',128)).toThrow(ScreenplayError);const frozen=freezeScreenplay({children:[{value:'kept'},null,1]});expect(Object.isFrozen(frozen.children)).toBe(true);expect(Object.isFrozen(frozen.children[0])).toBe(true);expect(freezeScreenplay(null)).toBeNull();
});
