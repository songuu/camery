import {expect,it} from 'vitest';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {ScreenplayDraftSchema,ScreenplayRulesSchema,ScreenplayVoiceKindSchema} from '../src/screenplay/contracts.js';

const line={id:'line',speakerId:id('speaker'),kind:'on_screen',text:'我已经看见便签。',delivery:'压低声音。'};
const beat={id:'beat',kind:'dialogue',summary:'人物当面核对便签。',outlineBeatIds:[id('outline-beat')],origin:{kind:'invented',reason:'原创对白推动已采用大纲的同一冲突。',citations:[]},plannedPause:{minMs:0,maxMs:500},lines:[line]};
const draft={version:1,episodeId:id('episode'),title:'核对',scenes:[{id:'scene',title:'房间',locationId:null,characterIds:[id('speaker')],startState:'人物拿着便签。',endState:'人物决定核对。',beats:[beat]}],openingHook:{beatId:'beat',type:'mystery',reason:'便签来源未明。'},closingHook:null,modules:[],continuity:[]};
it('retains complete screenplay text and accepts exactly the existing four voice kinds',()=>{
  expect(ScreenplayVoiceKindSchema.options).toEqual(['on_screen','inner_monologue','off_screen','narration']);
  for(const kind of ScreenplayVoiceKindSchema.options){const input=structuredClone(draft);input.scenes[0]!.beats[0]!.lines[0]!.kind=kind;expect(ScreenplayDraftSchema.parse(input)).toEqual(input);}
});
it('does not accept caller-authored locks, readiness or adoption claims',()=>{
  expect(ScreenplayDraftSchema.safeParse({...draft,status:'adopted'}).success).toBe(false);
  const locked=structuredClone(draft);Object.assign(locked.scenes[0]!.beats[0]!.lines[0]!,{locked:true});expect(ScreenplayDraftSchema.safeParse(locked).success).toBe(false);
  const scene=structuredClone(draft);Object.assign(scene.scenes[0]!,{assetUrl:'https://example.invalid/fake'});expect(ScreenplayDraftSchema.safeParse(scene).success).toBe(false);
});
it('requires explicit versioned timing and five module definitions rather than invented defaults',()=>{
  const rates=Object.fromEntries(ScreenplayVoiceKindSchema.options.map(kind=>[kind,{minCharactersPerSecond:2,maxCharactersPerSecond:5}]));
  const rules={version:1,speech:{id:'fixture-rate',version:1,rates},firstEpisode:null};expect(ScreenplayRulesSchema.parse(rules)).toEqual(rules);
  const modules=Array.from({length:5},(_,index)=>({id:'module-'+index,label:'测试配置项'+index,purpose:'仅用于验证配置合同。',minBeats:1,requiredKinds:[]}));
  expect(ScreenplayRulesSchema.safeParse({...rules,firstEpisode:{id:'fixture-five',version:1,modules}}).success).toBe(true);
  expect(ScreenplayRulesSchema.safeParse({...rules,firstEpisode:{id:'fixture-five',version:1,modules:modules.slice(1)}}).success).toBe(false);
  expect(ScreenplayRulesSchema.safeParse({version:1,firstEpisode:null}).success).toBe(false);
});
