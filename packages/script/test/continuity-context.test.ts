import {describe,expect,it} from 'vitest';
import {upgradeV05Package,upgradeV06Package,validatePackage} from '@camery/ir';
import type {StoryboardPackage} from '@camery/ir';
import {fixtureId as id,makePackage} from '../../ir/test/fixtures.js';
import {captureContinuityContext,validateContinuityContext,validateContinuityDraft} from '../src/continuity/context.js';
import type {ContinuityContext,ContinuityDraft} from '../src/continuity/contracts.js';

const fixture=()=>structuredClone(makePackage());
function draft(context=captureContinuityContext(fixture())):ContinuityDraft{
  const event=context.events.find(item=>item.ref.id===id('b_open'))!;
  return structuredClone({version:1,episodeId:event.episodeId,events:[{id:'fact',op:'assert_fact',factId:'note',kind:'fact',text:'便签已经出现',evidence:{event:event.ref,quote:event.text}}]});
}
function physical(context:ContinuityContext){
  const event=context.events.find(item=>item.ref.id===id('b_open'))!,appearance=context.appearances.find(item=>item.id===id('look_lin'))!,spot=context.spots.find(item=>item.id===id('spot_desk'))!;
  return structuredClone({version:1 as const,episodeId:event.episodeId,events:[{id:'state',op:'set_character' as const,evidence:{event:event.ref,quote:event.text},value:{characterId:id('char_lin'),summary:'核对现场状态',appearance:{id:appearance.id,version:appearance.version},spot,holding:[context.props.find(item=>item.id===id('prop_note'))!]}}]});
}
describe('continuity context captured from actual adopted IR',()=>{
  it.each([fixture(),upgradeV05Package(fixture()),upgradeV06Package(upgradeV05Package(fixture()))])('projects a complete compatible package without altering its contract',pkg=>{
    expect(validatePackage(pkg).valid).toBe(true);const before=structuredClone(pkg),context=captureContinuityContext(pkg);
    expect(context).toMatchObject({version:1,projectId:pkg.project.id,packageId:pkg.package_id,snapshotRevision:pkg.revision.number});
    expect(context.episodes.map(item=>item.number)).toEqual([1,2]);expect(context.characters).toEqual(pkg.characters.map(({id,version})=>({id,version})));
    expect(context.events.map(item=>item.ref.id)).toEqual(['b_open','n_open','b_say','l_say','b_arrive','n_arrive','b_reply','l_reply'].map(id));
    expect(context.events.map(item=>item.sequence)).toEqual([1,2,3,4,1,2,3,4]);expect(context.events[3]!.speakerId).toBe(id('char_lin'));
    expect(context.events[0]!.lineKind).toBeNull();expect(context.events[1]!.lineKind).toBe('narration');expect(context.events[3]!.lineKind).toBe('on_screen');
    expect(context.events[0]!.text).toBe(pkg.beats[0]!.summary);expect(context.events[3]!.text).toBe(pkg.lines[0]!.text);
    expect(context.events[3]!.characterIds).toEqual(pkg.scenes[0]!.character_ids);expect(Object.isFrozen(context.events[0]!.characterIds)).toBe(true);expect(pkg).toEqual(before);
  });
  it('orders all source sequences by their declared keys rather than array placement',()=>{
    const pkg=fixture();for(const name of ['episodes','scenes','beats','lines'] as const)pkg[name].reverse();
    expect(captureContinuityContext(pkg).events.map(item=>item.ref.id)).toEqual(['b_open','n_open','b_say','l_say','b_arrive','n_arrive','b_reply','l_reply'].map(id));
  });
  it.each(['inner_monologue','off_screen'] as const)('retains native speech channel %s instead of inferring public dialogue',kind=>{
    const pkg=fixture(),line=pkg.lines.find(item=>item.id===id('l_say'))!;line.kind=kind;
    expect(validatePackage(pkg).valid).toBe(true);const context=captureContinuityContext(pkg);
    expect(context.events.find(item=>item.ref.id===line.id)).toMatchObject({lineKind:kind,speakerId:line.speaker_id,text:line.text});
  });
  it.each(['episodes','scenes','beats','lines'] as const)('rejects ambiguous %s ordering',collection=>{
    const pkg=fixture();if(collection==='episodes')pkg.episodes[1]!.order_key=pkg.episodes[0]!.order_key;
    else if(collection==='scenes'){pkg.scenes.push({...structuredClone(pkg.scenes[0]!),id:id('duplicate-scene')});pkg.project.scope.expected_scene_count++;}
    else if(collection==='beats'){pkg.beats[1]!.order_key=pkg.beats[0]!.order_key;}
    else pkg.lines.push({...structuredClone(pkg.lines[0]!),id:id('duplicate-line')});
    expect(()=>captureContinuityContext(pkg)).toThrow();
  });
  it('rejects a candidate head and graph damage without exposing supplied text',()=>{
    const pkg=fixture();pkg.revision.status='candidate';expect(()=>captureContinuityContext(pkg)).toThrow(expect.objectContaining({code:'UNADOPTED_SNAPSHOT'}));
    pkg.revision.status='adopted';pkg.lines[0]!.speaker_id=id('not-a-character');expect(()=>captureContinuityContext(pkg)).toThrow(expect.objectContaining({code:'INVALID_REFERENCE'}));
  });
  it('rejects duplicate scene participants even when the legacy graph permits repetition',()=>{
    const pkg=fixture();pkg.scenes[0]!.character_ids.push(pkg.scenes[0]!.character_ids[0]!);expect(()=>captureContinuityContext(pkg)).toThrow();
  });
  it('also checks participant duplicates on a scene without a beat to project',()=>{
    const pkg=fixture(),scene={...structuredClone(pkg.scenes[0]!),id:id('empty-scene'),order_key:'a1'};scene.character_ids.push(scene.character_ids[0]!);pkg.scenes.push(scene);pkg.project.scope.expected_scene_count++;
    expect(validatePackage(pkg).valid).toBe(true);expect(()=>captureContinuityContext(pkg)).toThrow(expect.objectContaining({code:'INVALID_REFERENCE'}));
  });
  it('does not silently truncate a project over the explicit 100 episode boundary',()=>{
    const pkg=fixture();for(let index=2;index<101;index++)pkg.episodes.push({...pkg.episodes[0]!,id:id('extra-ep-'+index),order_key:'z'+String(index).padStart(3,'0')});pkg.project.scope.expected_episode_count=101;
    expect(validatePackage(pkg).valid).toBe(true);expect(()=>captureContinuityContext(pkg)).toThrow(expect.objectContaining({code:'INVALID_INPUT'}));
  });
  it('preserves complete non-ASCII text and exact versions',()=>{
    const pkg=fixture();pkg.beats[0]!.summary='全文🙂\n原句'.repeat(1000);pkg.beats[0]!.version=7;const context=captureContinuityContext(pkg);
    expect(context.events[0]!.text).toBe(pkg.beats[0]!.summary);expect(context.events[0]!.ref.version).toBe(7);
  });
  it('accepts explicitly empty planned episodes and scenes without manufacturing script events',()=>{
    const pkg=fixture(),episode=structuredClone(pkg.episodes[0]!),scene=structuredClone(pkg.scenes[0]!);
    for(const [name,value] of Object.entries(pkg))if(Array.isArray(value))(pkg as unknown as Record<string,unknown>)[name]=[];
    pkg.episodes=[episode];pkg.project.source_ids=[];pkg.project.scope={label:'明确空基线',expected_episode_count:1,expected_scene_count:0,expected_required_beat_count:0};
    expect(captureContinuityContext(pkg).events).toEqual([]);scene.character_ids=[];scene.location_id=null;pkg.scenes=[scene];pkg.project.scope.expected_scene_count=1;
    expect(captureContinuityContext(pkg).events).toEqual([]);
  });
});

describe('intrinsic context integrity',()=>{
  const edits:Array<[string,(context:ContinuityContext)=>void]>=[
    ['episode numbering',c=>{c.episodes[1]!.number=4;}],['duplicate episode',c=>{c.episodes[1]!.id=c.episodes[0]!.id;}],
    ['character identity',c=>{c.characters.push({...c.characters[0]!});}],['appearance owner',c=>{c.appearances[0]!.characterId=id('missing');}],
    ['spot identity',c=>{c.spots.push(structuredClone(c.spots[0]!));}],['location revision',c=>{c.spots.push({id:id('new-spot'),location:{...c.spots[0]!.location,version:2}});}],
    ['episode ownership',c=>{c.events[0]!.episodeId=id('missing');}],['sequence gaps',c=>{c.events[0]!.sequence=2;}],
    ['duplicate source event',c=>{c.events[1]!.ref={...c.events[0]!.ref};}],['scene participant',c=>{c.events[0]!.characterIds.push(id('missing'));}],
    ['duplicate participant',c=>{c.events[0]!.characterIds.push(c.events[0]!.characterIds[0]!);}],['beat speaker',c=>{c.events[0]!.speakerId=id('char_lin');}],
    ['line speaker',c=>{c.events[1]!.speakerId=null;}],['speaker outside scene',c=>{c.events[1]!.characterIds=[];}],
    ['beat with speech channel',c=>{c.events[0]!.lineKind='on_screen';}],['line missing speech channel',c=>{c.events[1]!.lineKind=null;}],
    ['global event order',c=>{c.events.reverse();}],['cross-collection identity',c=>{c.characters[0]!.id=c.episodes[0]!.id;}],
    ['event text encoding',c=>{c.events[0]!.text='\ud800';}],['null control in text',c=>{c.events[0]!.text='text\0';}],
    ['spot location identity',c=>{c.spots[0]!.location.id=c.characters[0]!.id;}],['event location identity',c=>{c.events[0]!.ref.id=c.spots[0]!.location.id;}],
  ];
  it.each(edits)('rejects inconsistent %s',(_name,edit)=>{
    const context=structuredClone(captureContinuityContext(fixture()));edit(context);expect(()=>validateContinuityContext(context)).toThrow(expect.objectContaining({code:'INVALID_REFERENCE'}));
  });
  it('accepts an episode without events and independently captures its input',()=>{
    const context=structuredClone(captureContinuityContext(fixture()));context.events=[];const captured=validateContinuityContext(context);context.characters[0]!.version++;
    expect(captured.characters[0]!.version).not.toBe(context.characters[0]!.version);expect(Object.isFrozen(captured)).toBe(true);
  });
});

describe('four ledger draft evidence and physical references',()=>{
  it('retains complete commands and freezes validated data',()=>{
    const context=captureContinuityContext(fixture()),input=draft(context),result=validateContinuityDraft(context,input);expect(result).toEqual(input);expect(Object.isFrozen(result.events[0]!.evidence.event)).toBe(true);
    expect(validateContinuityDraft(context,{version:1,episodeId:context.episodes[0]!.id,events:[]})).toMatchObject({events:[]});
  });
  it.each([
    ['unknown object',(d:ContinuityDraft)=>{d.events[0]!.evidence.event.id=id('missing');}],
    ['wrong version',(d:ContinuityDraft)=>{d.events[0]!.evidence.event.version++;}],
    ['wrong kind',(d:ContinuityDraft)=>{d.events[0]!.evidence.event.kind='line';}],
    ['wrong episode',(d:ContinuityDraft)=>{d.episodeId=id('ep_2');}],
    ['unknown episode',(d:ContinuityDraft)=>{d.episodeId=id('missing');}],
    ['invented quote',(d:ContinuityDraft)=>{d.events[0]!.evidence.quote='这句话不在原文';}],
  ] as const)('rejects %s',(_name,edit)=>{const context=captureContinuityContext(fixture()),input=draft(context);edit(input);expect(()=>validateContinuityDraft(context,input)).toThrow(expect.objectContaining({code:'INVALID_REFERENCE'}));});
  it('rejects blank quotes and unknown command fields',()=>{
    const context=captureContinuityContext(fixture()),input=draft(context);input.events[0]!.evidence.quote='  ';expect(()=>validateContinuityDraft(context,input)).toThrow(expect.objectContaining({code:'INVALID_INPUT'}));
    expect(()=>validateContinuityDraft(context,{...draft(context),actor:'self-approved'})).toThrow(expect.objectContaining({code:'INVALID_INPUT'}));
  });
  it('rejects duplicate command IDs and reverse evidence order, while allowing several declarations at one source',()=>{
    const context=captureContinuityContext(fixture()),input=draft(context);input.events.push(structuredClone(input.events[0]!));expect(()=>validateContinuityDraft(context,input)).toThrow();
    input.events[1]!.id='second';expect(validateContinuityDraft(context,input)).toEqual(input);
    const later=context.events[3]!;input.events[0]!.evidence={event:later.ref,quote:later.text};expect(()=>validateContinuityDraft(context,input)).toThrow();
  });
  it.each(['learn','use_fact','set_character'] as const)('requires %s character to be present at the actual source event',op=>{
    const context=structuredClone(captureContinuityContext(fixture()));context.characters.push({id:id('absent'),version:1});const base=draft(context),evidence=base.events[0]!.evidence;
    const event=op==='set_character'?{id:'state',op,evidence,value:{characterId:id('absent'),summary:'缺席',appearance:null,spot:null,holding:[]}}:{id:'knowledge',op,evidence,characterId:id('absent'),factId:'note',...(op==='learn'?{source:{kind:'witness'}}:{})};
    expect(()=>validateContinuityDraft(context,{...base,events:[event]})).toThrow(expect.objectContaining({code:'INVALID_REFERENCE'}));
  });
  it('validates all physical pins and their character owner',()=>{const context=captureContinuityContext(fixture()),input=physical(context);expect(validateContinuityDraft(context,input)).toEqual(input);});
  it('rejects an unknown telling identity and duplicate deduction facts',()=>{
    const context=captureContinuityContext(fixture()),input=draft(context),base={id:'learn',op:'learn' as const,characterId:id('char_lin'),factId:'fact',evidence:input.events[0]!.evidence};
    expect(()=>validateContinuityDraft(context,{...input,events:[{...base,source:{kind:'told',fromCharacterId:id('missing')}}]})).toThrow(expect.objectContaining({code:'INVALID_REFERENCE'}));
    expect(()=>validateContinuityDraft(context,{...input,events:[{...base,source:{kind:'deduced',factIds:['fact','fact']}}]})).toThrow(expect.objectContaining({code:'INVALID_REFERENCE'}));
    expect(validateContinuityDraft(context,{...input,events:[{...base,source:{kind:'told',fromCharacterId:id('char_he')}}]}).events).toHaveLength(1);
    expect(validateContinuityDraft(context,{...input,events:[{...base,source:{kind:'deduced',factIds:['fact']}}]}).events).toHaveLength(1);
  });
  it.each(['appearance-version','appearance-owner','appearance-missing','spot-version','spot-location','spot-missing','holding-version','holding-missing','duplicate-holding'] as const)('rejects %s',change=>{
    const context=captureContinuityContext(fixture()),input=physical(context),value=input.events[0]!.value;
    if(change==='appearance-version')value.appearance.version++;
    else if(change==='appearance-owner')value.characterId=id('char_he');
    else if(change==='appearance-missing')value.appearance.id=id('missing');
    else if(change==='spot-version')value.spot.location.version++;
    else if(change==='spot-location')value.spot.location.id=id('loc_hill');
    else if(change==='spot-missing')value.spot.id=id('missing');
    else if(change==='holding-version')value.holding[0]!.version++;
    else if(change==='holding-missing')value.holding[0]!.id=id('missing');
    else value.holding.push({...value.holding[0]!});
    expect(()=>validateContinuityDraft(context,input)).toThrow(expect.objectContaining({code:'INVALID_REFERENCE'}));
  });
  it('supports explicit unknown physical state without inventing locations or media',()=>{
    const context=captureContinuityContext(fixture()),input=physical(context);expect(validateContinuityDraft(context,{...input,events:[{...input.events[0]!,value:{...input.events[0]!.value,appearance:null,spot:null,holding:[]}}]}).events).toHaveLength(1);
  });
  it('accepts future planned payoff but refuses missing or earlier episodes',()=>{
    const context=captureContinuityContext(fixture()),input=draft(context),event={id:'plant',op:'plant' as const,evidence:input.events[0]!.evidence,threadId:'thread',summary:'伏笔',payoffEpisodeId:id('ep_2')};
    expect(validateContinuityDraft(context,{...input,events:[event]}).events).toHaveLength(1);
    expect(()=>validateContinuityDraft(context,{...input,events:[{...event,payoffEpisodeId:id('missing')}]})).toThrow();
    const later=context.events[4]!;expect(()=>validateContinuityDraft(context,{version:1,episodeId:later.episodeId,events:[{...event,evidence:{event:later.ref,quote:later.text},payoffEpisodeId:id('ep_1')}]})).toThrow();
  });
  it('does not invoke accessors or expose opaque failures',()=>{
    let calls=0;const getter=Object.defineProperty({},'schema_version',{enumerable:true,get(){calls++;throw new Error('private-data');}});
    expect(()=>captureContinuityContext(getter)).toThrow(expect.objectContaining({code:'INVALID_INPUT'}));expect(calls).toBe(0);
    const opaque=new Proxy({},{ownKeys(){throw new Error('private-data');}});expect(()=>validateContinuityContext(opaque)).toThrow('Continuity');
    const context=captureContinuityContext(fixture());expect(()=>validateContinuityDraft(context,{padding:'x'.repeat(524289)})).toThrow(expect.objectContaining({code:'INPUT_LIMIT'}));
    const cyclic:{self?:unknown}={};cyclic.self=cyclic;expect(()=>validateContinuityDraft(context,cyclic)).toThrow(expect.objectContaining({code:'INVALID_INPUT'}));
  });
});

// Type-only use ensures this suite continues accepting all currently supported native IR readers.
const _supported:(input:StoryboardPackage)=>ContinuityContext=captureContinuityContext;
void _supported;
