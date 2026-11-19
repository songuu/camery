import {expect,it} from 'vitest';
import {estimateScreenplayTiming,screenplayTimingIssues} from '../src/screenplay/timing.js';
import {screenplayFixture} from './screenplay-support.js';

function sample(){const f=screenplayFixture();f.draft.scenes[0]!.beats=f.draft.scenes[0]!.beats.slice(0,2);return f;}
const spoken=(f:ReturnType<typeof sample>)=>f.draft.scenes[0]!.beats[1]!.lines[0]!;

it('estimates a Unicode-letter-or-number range and preserves separately planned pauses and complete ordering',()=>{
  const f=sample();spoken(f).text='你好 A9🙂， e\u0301 𠮷Ⅻ!';const before=JSON.stringify(f.draft),timing=estimateScreenplayTiming(f.context,f.draft);
  expect(timing).toMatchObject({version:1,kind:'estimated',basis:'configured_unicode_letter_or_number_rate',episodeId:f.draft.episodeId,profile:{id:'fixture-speech',version:1},total:{minMs:1900,maxMs:5000}});
  expect(timing.scenes[0]!.sceneId).toBe(f.draft.scenes[0]!.id);
  expect(timing.scenes[0]!.beats.map(row=>row.beatId)).toEqual(f.draft.scenes[0]!.beats.map(row=>row.id));
  expect(timing.scenes[0]!.beats[0]).toMatchObject({plannedPause:{minMs:500,maxMs:1000},total:{minMs:500,maxMs:1000},lines:[]});
  expect(timing.scenes[0]!.beats[1]).toMatchObject({plannedPause:{minMs:0,maxMs:500},total:{minMs:1400,maxMs:4000},lines:[{lineId:spoken(f).id,kind:'on_screen',units:7,duration:{minMs:1400,maxMs:3500}}]});
  expect(JSON.stringify(f.draft)).toBe(before);expect(Object.isFrozen(timing.scenes[0]!.beats[1]!.lines[0]!.duration)).toBe(true);expect(Object.isFrozen(f.draft)).toBe(false);
});

it.each([['中文ab12',6],['é e\u0301',2],['𠮷𝟘',2],['Ⅻ½²',3],['١٢',2],['！？🙂 \t',0]] as const)('counts only Letter/Number codepoints in %j', (text,units)=>{
  const f=sample();spoken(f).text=text;const line=estimateScreenplayTiming(f.context,f.draft).scenes[0]!.beats[1]!.lines[0]!;expect(line.units).toBe(units);expect(line.duration).toEqual({minMs:Math.floor(units/5*1000),maxMs:Math.ceil(units/2*1000)});
});

it('uses each configured voice-kind rate and rounds bounds outward',()=>{
  const f=sample(),template=f.draft.scenes[0]!.beats[1]!,kinds=['on_screen','inner_monologue','off_screen','narration'] as const;
  f.draft.scenes[0]!.beats=kinds.map((kind,index)=>{f.context.rules.speech.rates[kind]={minCharactersPerSecond:2**index,maxCharactersPerSecond:2**(index+1)};return {...structuredClone(template),id:'voice-beat-'+index,kind:kind==='narration'?'narration':'dialogue',plannedPause:{minMs:0,maxMs:0},lines:[{...structuredClone(template.lines[0]!),id:'voice-line-'+index,kind,text:'四个字符'}]};});
  const timing=estimateScreenplayTiming(f.context,f.draft);expect(timing.total).toEqual({minMs:3750,maxMs:7500});expect(timing.scenes[0]!.beats.map(row=>row.lines[0]!.duration)).toEqual([{minMs:2000,maxMs:4000},{minMs:1000,maxMs:2000},{minMs:500,maxMs:1000},{minMs:250,maxMs:500}]);
  f.context.rules.speech.rates.on_screen={minCharactersPerSecond:3,maxCharactersPerSecond:7};expect(estimateScreenplayTiming(f.context,f.draft).scenes[0]!.beats[0]!.lines[0]!.duration).toEqual({minMs:571,maxMs:1334});
});

it('adds complete scene totals without moving pauses into speech estimates',()=>{
  const f=sample(),second=structuredClone(f.draft.scenes[0]!);second.id='second-scene';for(const beat of second.beats){beat.id='second-'+beat.id;for(const line of beat.lines)line.id='second-'+line.id;}f.draft.scenes.push(second);
  const timing=estimateScreenplayTiming(f.context,f.draft);expect(timing.scenes).toHaveLength(2);expect(timing.scenes[0]!.total).toEqual(timing.scenes[1]!.total);expect(timing.total.minMs).toBe(timing.scenes[0]!.total.minMs*2);expect(timing.total.maxMs).toBe(timing.scenes[0]!.total.maxMs*2);
});

it.each([0.4,1])('accepts an inclusive target of %s seconds and recalculates from the draft',target=>{
  const f=sample();f.draft.scenes[0]!.beats=[f.draft.scenes[0]!.beats[1]!];spokenLine(f).text='你好';f.draft.scenes[0]!.beats[0]!.plannedPause={minMs:0,maxMs:0};f.context.episode.targetSeconds=target;
  expect(screenplayTimingIssues(f.context,f.draft)).toEqual([]);
  spokenLine(f).text='这是一段更长而且需要重新估时的台词';expect(screenplayTimingIssues(f.context,f.draft).map(row=>row.code)).toContain('TIMING_BUDGET');
});
function spokenLine(f:ReturnType<typeof sample>){return f.draft.scenes[0]!.beats[0]!.lines[0]!;}

it.each([0.399,1.001])('warns when the target %s seconds lies outside the independently estimated interval',target=>{
  const f=sample();f.draft.scenes[0]!.beats=[f.draft.scenes[0]!.beats[1]!];spokenLine(f).text='你好';f.draft.scenes[0]!.beats[0]!.plannedPause={minMs:0,maxMs:0};f.context.episode.targetSeconds=target;
  const issues=screenplayTimingIssues(f.context,f.draft);expect(issues).toHaveLength(1);expect(issues[0]).toMatchObject({code:'TIMING_BUDGET',severity:'warning',path:'/episode/targetSeconds'});expect(issues[0]!.audienceImpact.length).toBeGreaterThan(0);expect(issues[0]!.remedy.length).toBeGreaterThan(0);
});

it('warns about unplanned action and punctuation-only voiced beats without inventing measured duration',()=>{
  const f=sample();f.draft.scenes[0]!.beats[0]!.plannedPause={minMs:0,maxMs:0};spoken(f).text='……🙂！';f.context.episode.targetSeconds=0.25;
  const issues=screenplayTimingIssues(f.context,f.draft);expect(issues.map(row=>row.code)).toEqual(['ACTION_TIMING','NO_SPOKEN_UNITS']);expect(issues.every(row=>row.severity==='warning')).toBe(true);expect(new Set(issues.map(row=>row.id)).size).toBe(issues.length);
  const timing=estimateScreenplayTiming(f.context,f.draft);expect(timing.kind).toBe('estimated');expect(timing.total).toEqual({minMs:0,maxMs:500});
});

it('accepts zero lower planned action time when its upper bound is explicitly planned',()=>{
  const f=sample();f.draft.scenes[0]!.beats[0]!.plannedPause={minMs:0,maxMs:1000};expect(screenplayTimingIssues(f.context,f.draft).map(row=>row.code)).not.toContain('ACTION_TIMING');
});

it('keeps zero-unit lines distinct from a voiced beat that also has countable text',()=>{
  const f=sample(),line=spoken(f);f.draft.scenes[0]!.beats[1]!.lines.push({...line,id:'punctuation-only',text:'？！🙂'});
  expect(estimateScreenplayTiming(f.context,f.draft).scenes[0]!.beats[1]!.lines[1]).toMatchObject({units:0,duration:{minMs:0,maxMs:0}});expect(screenplayTimingIssues(f.context,f.draft).map(row=>row.code)).not.toContain('NO_SPOKEN_UNITS');
});

it.each(['tiny-rate','finite-unsafe-rate','beat-total','scene-total','episode-total'] as const)('rejects %s arithmetic overflow explicitly',kind=>{
  const f=sample();
  if(kind==='tiny-rate'||kind==='finite-unsafe-rate')f.context.rules.speech.rates.on_screen={minCharactersPerSecond:kind==='tiny-rate'?Number.MIN_VALUE:1e-20,maxCharactersPerSecond:5};
  else if(kind==='beat-total')f.draft.scenes[0]!.beats[1]!.plannedPause={minMs:Number.MAX_SAFE_INTEGER,maxMs:Number.MAX_SAFE_INTEGER};
  else if(kind==='scene-total')f.draft.scenes[0]!.beats[0]!.plannedPause={minMs:Number.MAX_SAFE_INTEGER,maxMs:Number.MAX_SAFE_INTEGER};
  else{const action=f.draft.scenes[0]!.beats[0]!;action.plannedPause={minMs:Number.MAX_SAFE_INTEGER,maxMs:Number.MAX_SAFE_INTEGER};f.draft.scenes[0]!.beats=[action];const second=structuredClone(f.draft.scenes[0]!);second.id='overflow-scene';second.beats[0]!.id='overflow-action';f.draft.scenes.push(second);}
  expect(()=>estimateScreenplayTiming(f.context,f.draft)).toThrow('INPUT_LIMIT');expect(()=>screenplayTimingIssues(f.context,f.draft)).toThrow('INPUT_LIMIT');
});

it('permits an exactly safe millisecond total and finite extremely fast configured rates',()=>{
  const f=sample();f.draft.scenes[0]!.beats=[f.draft.scenes[0]!.beats[0]!];f.draft.scenes[0]!.beats[0]!.plannedPause={minMs:Number.MAX_SAFE_INTEGER,maxMs:Number.MAX_SAFE_INTEGER};
  expect(estimateScreenplayTiming(f.context,f.draft).total).toEqual({minMs:Number.MAX_SAFE_INTEGER,maxMs:Number.MAX_SAFE_INTEGER});
  const g=sample();g.context.rules.speech.rates.on_screen={minCharactersPerSecond:Number.MAX_VALUE,maxCharactersPerSecond:Number.MAX_VALUE};expect(estimateScreenplayTiming(g.context,g.draft).scenes[0]!.beats[1]!.lines[0]!.duration).toEqual({minMs:0,maxMs:1});
});

it.each(['unknown-speaker','reversed-pause'] as const)('rejects structural %s errors instead of estimating a misleading valid range',kind=>{
  const f=sample();if(kind==='unknown-speaker')spoken(f).speakerId=f.id('missing-writing-speaker');else f.draft.scenes[0]!.beats[0]!.plannedPause={minMs:2,maxMs:1};
  expect(()=>estimateScreenplayTiming(f.context,f.draft)).toThrow('INVALID_REFERENCE');expect(()=>screenplayTimingIssues(f.context,f.draft)).toThrow('INVALID_REFERENCE');
});

it('rejects malformed rates, unsafe draft getters and a foreign episode through the shared boundary',()=>{
  const f=sample();f.context.rules.speech.rates.on_screen.minCharactersPerSecond=0;expect(()=>estimateScreenplayTiming(f.context,f.draft)).toThrow('INVALID_INPUT');
  const g=sample();let touched=false;Object.defineProperty(spoken(g),'text',{enumerable:true,get(){touched=true;throw new Error('private getter');}});expect(()=>estimateScreenplayTiming(g.context,g.draft)).toThrow('INVALID_INPUT');expect(touched).toBe(false);
  const h=sample();h.draft.episodeId=h.id('foreign-writing-episode');expect(()=>screenplayTimingIssues(h.context,h.draft)).toThrow('CONFLICT');
});
