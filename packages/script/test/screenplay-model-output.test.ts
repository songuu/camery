import {expect,it,vi} from 'vitest';
import {normalizeScreenplayModelOutput} from '../src/screenplay/node/model-output.js';
import {SCREENPLAY_MODEL_OUTPUT_BYTES} from '../src/screenplay/node/model-contracts.js';
import type {ScreenplayModelOutput} from '../src/screenplay/node/model-contracts.js';
import {ScreenplayVoiceKindSchema} from '../src/screenplay/contracts.js';
import {screenplayFixture} from './screenplay-support.js';

function fixture(){
  const f=screenplayFixture(),evidence={event:{kind:'beat' as const,id:'action-0'},quote:f.draft.scenes[0]!.beats[0]!.summary};
  const output:ScreenplayModelOutput={...structuredClone(f.draft),openingHook:f.draft.openingHook!,closingHook:f.draft.closingHook!,continuity:{assertFacts:[{id:'assert',order:1,factId:'note',kind:'fact',text:'本集核对便签。',evidence}],retireFacts:[{id:'retire',order:7,factId:'note',evidence}],learnFacts:[{id:'learn',order:2,characterId:f.speaker,factId:'note',source:{kind:'witness',fromCharacterId:null,factIds:[]},evidence}],useFacts:[{id:'use',order:3,characterId:f.speaker,factId:'note',evidence}],setCharacters:[{id:'state',order:4,characterId:f.speaker,summary:'决定继续追查。',appearance:{id:null,version:0},spot:{id:null,locationId:null,locationVersion:0},holding:[],evidence}],plantThreads:[{id:'plant',order:5,threadId:'origin',summary:'追查便签来处。',payoffEpisodeId:null,evidence}],payoffThreads:[{id:'payoff',order:6,threadId:'origin',evidence}]}};
  return {...f,output,evidence};
}
it('preserves the complete screenplay and converts all seven proposal groups into one declared causal order',()=>{
  const f=fixture(),before=structuredClone(f.output),actual=normalizeScreenplayModelOutput(f.output);
  expect(actual).toEqual({...f.draft,continuity:[
    {id:'assert',op:'assert_fact',factId:'note',kind:'fact',text:'本集核对便签。',evidence:f.evidence},
    {id:'learn',op:'learn',characterId:f.speaker,factId:'note',source:{kind:'witness'},evidence:f.evidence},
    {id:'use',op:'use_fact',characterId:f.speaker,factId:'note',evidence:f.evidence},
    {id:'state',op:'set_character',value:{characterId:f.speaker,summary:'决定继续追查。',appearance:null,spot:null,holding:[]},evidence:f.evidence},
    {id:'plant',op:'plant',threadId:'origin',summary:'追查便签来处。',payoffEpisodeId:null,evidence:f.evidence},
    {id:'payoff',op:'payoff',threadId:'origin',evidence:f.evidence},
    {id:'retire',op:'retire_fact',factId:'note',evidence:f.evidence},
  ]});expect(f.output).toEqual(before);expect(Object.isFrozen(actual.scenes)).toBe(true);expect(Object.isFrozen(actual.continuity[0]!.evidence)).toBe(true);
});
it.each(ScreenplayVoiceKindSchema.options)('keeps %s text and delivery unchanged without inventing speaker or native evidence',kind=>{const f=fixture(),line=f.output.scenes[0]!.beats[1]!.lines[0]!;line.kind=kind;line.text='逐字保留\n“原话”、停顿🙂。';line.delivery='低声\n克制。';expect(normalizeScreenplayModelOutput(f.output).scenes[0]!.beats[1]!.lines[0]).toEqual(line);});
it.each(['told','deduced'] as const)('preserves explicit %s learning provenance',kind=>{const f=fixture(),row=f.output.continuity.learnFacts[0]!;row.source=kind==='told'?{kind,fromCharacterId:f.id('informant'),factIds:[]}:{kind,fromCharacterId:null,factIds:['before-one','before-two']};const result=normalizeScreenplayModelOutput(f.output).continuity[1]!;expect(result.op).toBe('learn');if(result.op==='learn')expect(result.source).toEqual(kind==='told'?{kind,fromCharacterId:f.id('informant')}:{kind,factIds:['before-one','before-two']});});
it('preserves complete physical references rather than replacing them with empty state',()=>{const f=fixture(),row=f.output.continuity.setCharacters[0]!;row.appearance={id:f.id('appearance'),version:3};row.spot={id:f.id('spot'),locationId:f.id('location'),locationVersion:4};row.holding=[{id:f.id('prop'),version:5}];f.output.continuity.plantThreads[0]!.payoffEpisodeId=f.id('later-episode');const result=normalizeScreenplayModelOutput(f.output),state=result.continuity[3]!;expect(state).toMatchObject({op:'set_character',value:{appearance:{id:f.id('appearance'),version:3},spot:{id:f.id('spot'),location:{id:f.id('location'),version:4}},holding:row.holding}});expect(result.continuity[4]).toMatchObject({payoffEpisodeId:f.id('later-episode')});});
it('accepts an empty declaration set while retaining the full candidate text for later human review',()=>{const f=fixture();for(const group of Object.values(f.output.continuity))group.length=0;expect(normalizeScreenplayModelOutput(f.output)).toEqual(f.draft);});
it('sorts declarations within one provider group without mutating the original proposal array',()=>{const f=fixture();for(const group of Object.values(f.output.continuity))group.length=0;f.output.continuity.assertFacts=[{id:'second',order:2,factId:'second-fact',kind:'timeline',text:'后发生的事实。',evidence:f.evidence},{id:'first',order:1,factId:'first-fact',kind:'world_rule',text:'先明确的世界规则。',evidence:f.evidence}];expect(normalizeScreenplayModelOutput(f.output).continuity.map(row=>row.id)).toEqual(['first','second']);expect(f.output.continuity.assertFacts.map(row=>row.id)).toEqual(['second','first']);});
const invalid:readonly [string,(f:ReturnType<typeof fixture>)=>void][]=[
  ['duplicate cross-group id',f=>{f.output.continuity.useFacts[0]!.id='assert';}],
  ['duplicate cross-group order',f=>{f.output.continuity.useFacts[0]!.order=1;}],
  ['missing first order',f=>{for(const group of Object.values(f.output.continuity))for(const row of group)row.order++;}],
  ['order gap',f=>{f.output.continuity.retireFacts[0]!.order=8;}],
  ['witness informant',f=>{f.output.continuity.learnFacts[0]!.source.fromCharacterId=f.id('informant');}],
  ['witness deductions',f=>{f.output.continuity.learnFacts[0]!.source.factIds=['note'];}],
  ['told missing informant',f=>{f.output.continuity.learnFacts[0]!.source.kind='told';}],
  ['told deductions',f=>{f.output.continuity.learnFacts[0]!.source={kind:'told',fromCharacterId:f.id('informant'),factIds:['note']};}],
  ['deduced informant',f=>{f.output.continuity.learnFacts[0]!.source={kind:'deduced',fromCharacterId:f.id('informant'),factIds:['note']};}],
  ['deduced empty facts',f=>{f.output.continuity.learnFacts[0]!.source.kind='deduced';}],
  ['deduced duplicate facts',f=>{f.output.continuity.learnFacts[0]!.source={kind:'deduced',fromCharacterId:null,factIds:['note','note']};}],
  ['null appearance with version',f=>{f.output.continuity.setCharacters[0]!.appearance.version=1;}],
  ['appearance without version',f=>{f.output.continuity.setCharacters[0]!.appearance.id=f.id('appearance');}],
  ['null spot with location',f=>{f.output.continuity.setCharacters[0]!.spot.locationId=f.id('location');}],
  ['null spot with version',f=>{f.output.continuity.setCharacters[0]!.spot.locationVersion=1;}],
  ['spot without location',f=>{f.output.continuity.setCharacters[0]!.spot.id=f.id('spot');}],
  ['spot without version',f=>{f.output.continuity.setCharacters[0]!.spot={id:f.id('spot'),locationId:f.id('location'),locationVersion:0};}],
];
it.each(invalid)('refuses %s instead of discarding or guessing data',(_label,change)=>{const f=fixture();change(f);expect(()=>normalizeScreenplayModelOutput(f.output)).toThrow();try{normalizeScreenplayModelOutput(f.output);}catch(error){expect(error).toMatchObject({name:'ScreenplayError',code:'INVALID_REFERENCE',path:expect.stringContaining('continuity')});}});
it.each(['extra','missing','invalid-id','invalid-kind','zero-order','negative-order','negative-version','nul','ill-formed'] as const)('rejects structurally invalid provider %s',mode=>{const f=fixture();if(mode==='extra')Object.assign(f.output,{adopted:true});if(mode==='missing')delete (f.output as Partial<ScreenplayModelOutput>).openingHook;if(mode==='invalid-id')f.output.continuity.learnFacts[0]!.characterId='self-reported-narrator';if(mode==='invalid-kind')Object.assign(f.output.scenes[0]!.beats[1]!.lines[0]!,{kind:'automatic_lipsync'});if(mode==='zero-order')f.output.continuity.assertFacts[0]!.order=0;if(mode==='negative-order')f.output.continuity.assertFacts[0]!.order=-1;if(mode==='negative-version')f.output.continuity.setCharacters[0]!.appearance.version=-1;if(mode==='nul')f.output.title='bad\0text';if(mode==='ill-formed')f.output.title='bad\uD800';expect(()=>normalizeScreenplayModelOutput(f.output)).toThrow('INVALID_INPUT');});
it('enforces the aggregate declaration boundary across all seven independently bounded groups',()=>{const f=fixture();for(const group of Object.values(f.output.continuity))group.length=0;f.output.continuity.retireFacts=Array.from({length:1024},(_,index)=>({id:'retire-'+index,order:index+1,factId:'note',evidence:f.evidence}));f.output.continuity.payoffThreads=Array.from({length:1024},(_,index)=>({id:'payoff-'+index,order:index+1025,threadId:'origin',evidence:f.evidence}));expect(normalizeScreenplayModelOutput(f.output).continuity).toHaveLength(2048);f.output.continuity.payoffThreads.push({id:'overflow',order:2048,threadId:'origin',evidence:f.evidence});expect(()=>normalizeScreenplayModelOutput(f.output)).toThrow('INPUT_LIMIT');});
it('checks total UTF-8 bytes before accepting individually legal scene and beat fields',()=>{const f=fixture(),template=f.output.scenes[0]!.beats[0]!;f.output.scenes[0]!.beats=Array.from({length:45},(_,i)=>({...structuredClone(template),id:'action-'+i,summary:'长'.repeat(4000)}));expect(Buffer.byteLength(JSON.stringify(f.output))).toBeGreaterThan(SCREENPLAY_MODEL_OUTPUT_BYTES);expect(()=>normalizeScreenplayModelOutput(f.output)).toThrow('INPUT_LIMIT');});
it('captures caller input without evaluating getters or revealing opaque prototype errors',()=>{const f=fixture(),getter=vi.fn(()=>{throw new Error('private getter');});Object.defineProperty(f.output,'title',{get:getter,enumerable:true});expect(()=>normalizeScreenplayModelOutput(f.output)).toThrow('INVALID_INPUT');expect(getter).not.toHaveBeenCalled();const opaque=new Proxy({},{getPrototypeOf(){throw new Error('private prototype');}});expect(()=>normalizeScreenplayModelOutput(opaque)).toThrow('INVALID_INPUT');});
