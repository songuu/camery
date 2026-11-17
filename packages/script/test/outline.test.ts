import { describe,expect,it } from 'vitest';
import { captureOutlineContext,validateOutline,reviewOutlineCraft } from '../src/outline/outline.js';
import { OutlineError,OUTLINE_BYTES } from '../src/outline/contracts.js';
import { outlineFixture } from './outline-support.js';

describe('adaptation five-piece outline',()=>{
  it('captures a complete immutable plan without inventing scripts, quality scores or ready assets',()=>{
    const {context,output}=outlineFixture();const plan=validateOutline(context,output);
    expect(plan).toEqual(output);expect(Object.isFrozen(plan.episodes[0])).toBe(true);output.episodes[0]!.title='changed';expect(plan.episodes[0]!.title).not.toBe('changed');
    const report=reviewOutlineCraft(context,plan);expect(report.kind).toBe('craft_review');expect(report.emotionCurve).toEqual([{episodeNumber:1,intensity:7},{episodeNumber:2,intensity:7},{episodeNumber:3,intensity:7}]);
    expect(report.issues).toEqual([expect.objectContaining({code:'ABLATION_REVIEW',path:'recipe.ablations.0'})]);expect(report).not.toHaveProperty('score');expect(report).not.toHaveProperty('approved');
  });
  it.each(['adaptation','recipe','characters','beats','episodes','assets','plotUnits','seasonEngine'] as const)('requires %s',key=>{
    const {context,output}=outlineFixture();delete (output as unknown as Record<string,unknown>)[key];expect(()=>validateOutline(context,output)).toThrow('INVALID_INPUT');
  });
  it('rejects dangling, duplicate, foreign-source and wrong-episode references',()=>{
    const changes=[(f:ReturnType<typeof outlineFixture>)=>{f.output.beats[0]!.characterIds=['absent'];},
      (f:ReturnType<typeof outlineFixture>)=>{f.output.characters.push(f.output.characters[0]!);},
      (f:ReturnType<typeof outlineFixture>)=>{f.output.assets[0]!.origin.sourceRefIds=['source:foreign'];},
      (f:ReturnType<typeof outlineFixture>)=>{f.output.episodes[0]!.openingHook.beatId='b2';},
      (f:ReturnType<typeof outlineFixture>)=>{f.output.assets[0]!.propStates[0]!.beatId='absent';}];
    for(const change of changes){const f=outlineFixture();change(f);expect(()=>validateOutline(f.context,f.output)).toThrow('INVALID_REFERENCE');}
  });
  it('checks the effective paid-breakpoint selection and complete episode coverage',()=>{
    const f=outlineFixture();f.output.episodes[2]!.paidBreakpoint=false;expect(()=>validateOutline(f.context,f.output)).toThrow('INVALID_REFERENCE');
    const g=outlineFixture();g.output.episodes.pop();expect(()=>validateOutline(g.context,g.output)).toThrow('INCOMPLETE');
  });
  it('reports configurable consecutive cliffhanger and emotion rules without claiming quality',()=>{
    const f=outlineFixture();for(const episode of f.output.episodes){episode.cliffhanger.type='choice';episode.emotionIntensity=5;}
    f.output.episodes[0]!.openingHook.estimatedSecond=4;f.output.episodes[0]!.stakes.estimatedSecond=11;
    const report=reviewOutlineCraft(f.context,f.output);expect(report.issues.map(issue=>issue.code)).toEqual(['LATE_OPENING_HOOK','LATE_STAKES','REPEATED_CLIFFHANGER','LOW_EMOTION','ABLATION_REVIEW']);
    expect(reviewOutlineCraft(f.context,f.output,{repeatedCliffhangerWindow:4,lowEmotionWindow:4,lowEmotionBelow:5,openingHookBySecond:4,stakesBySecond:11}).issues.map(issue=>issue.code)).toEqual(['ABLATION_REVIEW']);
  });
  type Fixture=ReturnType<typeof outlineFixture>;
  const invalidReferences:readonly [string,(f:Fixture)=>void][]=[
    ['duplicate source',f=>{f.context.sourceRefIds.push(f.context.sourceRefIds[0]!);}],
    ['duplicate paid selection',f=>{f.context.paidEpisodeNumbers.push(3);}],
    ['foreign paid episode',f=>{f.context.paidEpisodeNumbers=[4];}],
    ['duplicate auxiliary',f=>{f.context.auxiliaryGenres.push('suspense');}],
    ['main repeated as auxiliary',f=>{f.context.auxiliaryGenres=['rebirth-revenge'];}],
    ['gapped episode sequence',f=>{f.output.episodes[1]!.number=3;}],
    ['mismatched main genre',f=>{f.output.recipe.mainGenre='sweet-romance';}],
    ['mismatched auxiliary genre',f=>{f.output.recipe.auxiliaryGenres=[];}],
    ['duplicate ablation',f=>{f.output.recipe.ablations.push(f.output.recipe.ablations[0]!);}],
    ['unselected ablation',f=>{f.output.recipe.ablations[0]!.genre='sweet-romance';}],
    ['duplicate beats',f=>{f.output.beats[1]!.id='b1';}],
    ['duplicate assets',f=>{f.output.assets.push(f.output.assets[0]!);}],
    ['duplicate units',f=>{f.output.plotUnits.push(f.output.plotUnits[0]!);}],
    ['duplicate decisions',f=>{f.output.adaptation.decisions.push(f.output.adaptation.decisions[0]!);}],
    ['duplicate signature scenes',f=>{f.output.recipe.signatureScenes.push(f.output.recipe.signatureScenes[0]!);}],
    ['unknown source in decision',f=>{f.output.adaptation.decisions[0]!.sourceRefIds=['foreign'];}],
    ['duplicated citation',f=>{f.output.adaptation.decisions[0]!.sourceRefIds=['source:clock','source:clock'];}],
    ['unattributed adapted character',f=>{f.output.characters[0]!.origin.sourceRefIds=[];}],
    ['invention claiming source',f=>{f.output.beats[0]!.origin.kind='invented';}],
    ['invention decision claiming source',f=>{f.output.adaptation.decisions[0]!.action='invent';}],
    ['foreign beat episode',f=>{f.output.beats[0]!.episodeNumber=4;}],
    ['duplicate beat character',f=>{f.output.beats[0]!.characterIds=['hero','hero'];}],
    ['gapped beat order',f=>{f.output.beats[0]!.order=2;}],
    ['episode missing its own beat',f=>{f.output.episodes[1]!.beatIds=['b1'];}],
    ['stakes foreign to episode',f=>{f.output.episodes[0]!.stakes.beatId='b2';}],
    ['cliff foreign to episode',f=>{f.output.episodes[0]!.cliffhanger.beatId='b2';}],
    ['hook past runtime',f=>{f.output.episodes[0]!.openingHook.estimatedSecond=91;}],
    ['stakes past runtime',f=>{f.output.episodes[0]!.stakes.estimatedSecond=91;}],
    ['unknown signature beat',f=>{f.output.recipe.signatureScenes[0]!.beatIds=['missing'];}],
    ['unknown ablation beat',f=>{f.output.recipe.ablations[0]!.affectedBeatIds=['missing'];}],
    ['unknown asset beat',f=>{f.output.assets[0]!.beatIds=['missing'];}],
    ['unknown asset character',f=>{f.output.assets[0]!.characterId='missing';}],
    ['character asset without character',f=>{f.output.assets[0]!.kind='character';}],
    ['appearance without character',f=>{f.output.assets[0]!.kind='appearance';}],
    ['non-prop with state ledger',f=>{f.output.assets[0]!.kind='location';}],
    ['state absent from asset appearances',f=>{f.output.assets[0]!.beatIds=['b2'];}],
    ['duplicate prop state beat',f=>{f.output.assets[0]!.propStates.push(f.output.assets[0]!.propStates[0]!);}],
    ['prop state time reversal',f=>{f.output.assets[0]!.propStates=[{...f.output.assets[0]!.propStates[0]!,beatId:'b3'},{...f.output.assets[0]!.propStates[0]!,beatId:'b1'}];}],
    ['duplicate unit episode',f=>{f.output.plotUnits[0]!.episodeNumbers=[1,1,3];}],
    ['gapped unit episodes',f=>{f.output.plotUnits[0]!.episodeNumbers=[1,3];}],
    ['foreign unit episode',f=>{f.output.plotUnits[0]!.episodeNumbers=[4];}],
    ['foreign unit beat',f=>{f.output.plotUnits[0]!.beatIds=['missing'];}],
    ['unit beat outside covered episodes',f=>{f.output.plotUnits[0]!.episodeNumbers=[1,2];}],
    ['unit missing covered beat',f=>{f.output.plotUnits[0]!.beatIds=['b1','b2'];}],
    ['uncovered episode',f=>{f.output.plotUnits[0]!.episodeNumbers=[1,2];f.output.plotUnits[0]!.beatIds=['b1','b2'];}],
    ['foreign season character',f=>{f.output.seasonEngine.characterIds=['missing'];}],
    ['foreign season unit',f=>{f.output.seasonEngine.plotUnitIds=['missing'];}],
  ];
  it.each(invalidReferences)('rejects %s with a located domain error',(_name,change)=>{
    const f=outlineFixture();change(f);
    try{validateOutline(f.context,f.output);throw new Error('expected rejection');}
    catch(error){expect(error).toBeInstanceOf(OutlineError);expect(error).toMatchObject({code:'INVALID_REFERENCE',path:expect.any(String)});}
  });
  it('requires an ablation for every selected auxiliary and at least one beat for every episode',()=>{
    const f=outlineFixture();f.output.recipe.ablations=[];expect(()=>validateOutline(f.context,f.output)).toThrow('INCOMPLETE');
    const g=outlineFixture();g.output.beats.splice(1,1);expect(()=>validateOutline(g.context,g.output)).toThrow('INCOMPLETE');
  });
  it('requires a narrative prop state entry, including an explicitly unchanged state for static props',()=>{
    const f=outlineFixture();f.output.assets[0]!.propStates=[];expect(()=>validateOutline(f.context,f.output)).toThrow('INCOMPLETE');
    const g=outlineFixture();g.output.assets[0]!.propStates[0]!.after=g.output.assets[0]!.propStates[0]!.before;
    expect(validateOutline(g.context,g.output).assets[0]!.propStates[0]!.after).toBe('完整');
  });
  it.each(['absent','unlinked','unused'] as const)('requires a participating season-engine protagonist (%s)',kind=>{
    const f=outlineFixture();const antagonist={...structuredClone(f.output.characters[0]!),id:'opponent',function:'antagonist' as const};
    if(kind==='absent')f.output.characters[0]!.function='antagonist';
    else{f.output.characters.push(antagonist);if(kind==='unlinked')f.output.seasonEngine.characterIds=['opponent'];else for(const beat of f.output.beats)beat.characterIds=['opponent'];}
    expect(()=>validateOutline(f.context,f.output)).toThrow('INCOMPLETE');
  });
  it('supports one-episode planning, explicitly invented content and separate local namespaces',()=>{
    const f=outlineFixture();f.context.episodeCount=1;f.context.auxiliaryGenres=[];f.context.paidEpisodeNumbers=[];
    f.output.recipe.auxiliaryGenres=[];f.output.recipe.ablations=[];f.output.recipe.signatureScenes[0]!.beatIds=['b1'];
    f.output.adaptation.decisions[0]={id:'hero',action:'invent',reason:'新增一个钟塔入口。',sourceRefIds:[]};
    f.output.characters[0]!.origin={kind:'invented',sourceRefIds:[]};f.output.beats=f.output.beats.slice(0,1);
    f.output.episodes=f.output.episodes.slice(0,1);f.output.episodes[0]!.paidBreakpoint=false;
    f.output.assets[0]!.beatIds=['b1'];f.output.plotUnits[0]!.episodeNumbers=[1];f.output.plotUnits[0]!.beatIds=['b1'];
    expect(reviewOutlineCraft(f.context,f.output).issues).toEqual([]);
    f.output.assets[0]!.kind='character';f.output.assets[0]!.characterId='hero';f.output.assets[0]!.propStates=[];
    expect(validateOutline(f.context,f.output).assets[0]!.characterId).toBe('hero');
  });
  it('keeps multiple ordered beats, consecutive multi-episode units and overlapping rule windows',()=>{
    const f=outlineFixture();f.output.beats.splice(1,0,{...structuredClone(f.output.beats[0]!),id:'b1a',order:2});f.output.episodes[0]!.beatIds.push('b1a');
    const unit=f.output.plotUnits[0]!;f.output.plotUnits=[{...unit,episodeNumbers:[1],beatIds:['b1','b1a']},{...unit,id:'u2',episodeNumbers:[2,3],beatIds:['b2','b3']}];
    f.output.seasonEngine.plotUnitIds=['u1','u2'];for(const episode of f.output.episodes){episode.cliffhanger.type='choice';episode.emotionIntensity=0;}
    const report=reviewOutlineCraft(f.context,f.output,{repeatedCliffhangerWindow:2,lowEmotionWindow:2,lowEmotionBelow:1,openingHookBySecond:3,stakesBySecond:10});
    expect(report.issues.filter(issue=>issue.code==='REPEATED_CLIFFHANGER').map(issue=>issue.episodeNumbers)).toEqual([[1,2],[2,3]]);
    expect(report.issues.filter(issue=>issue.code==='LOW_EMOTION')).toHaveLength(2);
    f.output.recipe.ablations[0]!.affectedBeatIds=['b1','b1a','b3'];expect(reviewOutlineCraft(f.context,f.output).issues.at(-1)!.episodeNumbers).toEqual([1,3]);
  });
  it('refuses media-ready claims, unknown output fields, non-finite values and oversized plans without truncation',()=>{
    const f=outlineFixture();expect(()=>validateOutline(f.context,{...f.output,qualityScore:5})).toThrow('INVALID_INPUT');
    expect(()=>validateOutline(f.context,{...f.output,assets:[{...f.output.assets[0],status:'ready',uri:'https://example.invalid/image'}]})).toThrow('INVALID_INPUT');
    f.output.episodes[0]!.emotionIntensity=NaN;expect(()=>validateOutline(f.context,f.output)).toThrow('INVALID_INPUT');
    const g=outlineFixture();g.output.adaptation.logline='x'.repeat(OUTLINE_BYTES);expect(()=>validateOutline(g.context,g.output)).toThrow('INPUT_LIMIT');
    expect(()=>validateOutline({...g.context,sourceRefIds:[]},g.output)).toThrow('INVALID_INPUT');
  });
  it('captures the source context and rejects accessor/proxy exceptions without invoking getters or leaking content',()=>{
    const f=outlineFixture();const captured=captureOutlineContext(f.context);f.context.sourceRefIds.push('new');expect(captured.sourceRefIds).toHaveLength(2);expect(Object.isFrozen(captured.sourceRefIds)).toBe(true);
    let invoked=false;const value=Object.defineProperty(f.output,'episodes',{enumerable:true,get(){invoked=true;throw new Error('secret');}});
    expect(()=>validateOutline(f.context,value)).toThrow('INVALID_INPUT');expect(invoked).toBe(false);
    expect(()=>validateOutline(f.context,new Proxy({},{ownKeys(){throw new Error('secret');}}))).not.toThrow('secret');
    expect(()=>validateOutline(f.context,null)).toThrow('INVALID_INPUT');
  });
});
