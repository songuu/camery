import {expect,it} from 'vitest';
import {createScreenplayLineBook} from '../src/screenplay/line-book.js';
import {screenplayFixture} from './screenplay-support.js';

it('groups by speaker first appearance while keeping complete global line order and local scene/beat identities',()=>{
  const f=screenplayFixture(),scene=f.draft.scenes[0]!,beat=scene.beats.find(row=>row.kind==='dialogue')!,template=beat.lines[0]!,second=f.context.characters.find(row=>row.id!==f.speaker)!;
  scene.characterIds.push(second.id);beat.lines=[{...template,id:'second-speaks-first',speakerId:second.id,text:'  “先别走！”\n请等等。 ',delivery:'低声，随后停顿。'},{...template,id:'first-speaks-second',text:'我会等。'},{...template,id:'second-speaks-again',speakerId:second.id,text:'谢谢。'}];
  const next=structuredClone(scene);next.id='later-scene';for(const row of next.beats){row.id='later-'+row.id;row.lines=[];}const nextBeat=next.beats.find(row=>row.kind==='dialogue')!;nextBeat.lines=[{...template,id:'first-in-later-scene',kind:'off_screen',text:'我在门外。'}];f.draft.scenes.push(next);
  const before=JSON.stringify(f.draft),book=createScreenplayLineBook(f.context,f.draft);
  expect(book).toMatchObject({version:1,episodeId:f.draft.episodeId,title:f.draft.title,lineCount:4,order:['second-speaks-first','first-speaks-second','second-speaks-again','first-in-later-scene']});
  expect(book.speakers.map(row=>row.character.id)).toEqual([second.id,f.speaker]);expect(book.speakers[0]!.character).toEqual({id:second.id,version:second.version});expect(book.speakers[0]!.name).toBe(second.name);
  expect(book.speakers[0]!.lines.map(row=>row.sequence)).toEqual([1,3]);expect(book.speakers[1]!.lines.map(row=>row.sequence)).toEqual([2,4]);
  expect(book.speakers[0]!.lines[0]).toEqual({id:'second-speaks-first',sceneId:scene.id,beatId:beat.id,sequence:1,kind:'on_screen',text:'  “先别走！”\n请等等。 ',delivery:'低声，随后停顿。',lipSync:'eligible_if_visible'});
  expect(book.speakers[1]!.lines[1]).toMatchObject({sceneId:'later-scene',beatId:nextBeat.id,kind:'off_screen',lipSync:'never'});expect(JSON.stringify(f.draft)).toBe(before);expect(Object.isFrozen(book.speakers[0]!.lines[0])).toBe(true);
});

it('retains every voice kind and grants lip-sync eligibility only to on-screen speech',()=>{
  const f=screenplayFixture(),scene=f.draft.scenes[0]!,template=scene.beats.find(row=>row.kind==='dialogue')!,kinds=['on_screen','inner_monologue','off_screen','narration'] as const;
  scene.beats=kinds.map((kind,index)=>({...structuredClone(template),id:'voice-'+index,kind:kind==='narration'?'narration':'dialogue',lines:[{...template.lines[0]!,id:'voice-line-'+index,kind,text:'完整保留'+index,delivery:'独立演绎'+index}]}));
  const lines=createScreenplayLineBook(f.context,f.draft).speakers[0]!.lines;expect(lines.map(row=>row.kind)).toEqual(kinds);expect(lines.map(row=>row.lipSync)).toEqual(['eligible_if_visible','never','never','never']);expect(lines.map(row=>row.delivery)).toEqual(['独立演绎0','独立演绎1','独立演绎2','独立演绎3']);
});

it('keeps different actual characters separate even when their names are equal',()=>{
  const f=screenplayFixture(),other=f.context.characters.find(row=>row.id!==f.speaker)!,scene=f.draft.scenes[0]!,beat=scene.beats.find(row=>row.kind==='dialogue')!;other.name=f.context.characters.find(row=>row.id===f.speaker)!.name;scene.characterIds.push(other.id);beat.lines.push({...beat.lines[0]!,id:'same-name-other',speakerId:other.id});
  const book=createScreenplayLineBook(f.context,f.draft);expect(book.speakers).toHaveLength(2);expect(book.speakers.map(row=>row.name)).toEqual([other.name,other.name]);expect(book.speakers.map(row=>row.character.id)).toEqual([f.speaker,other.id]);
});

it('returns an empty line book for an action-only draft without inventing a speaker',()=>{
  const f=screenplayFixture();f.draft.scenes[0]!.beats=f.draft.scenes[0]!.beats.filter(row=>row.kind==='action');expect(createScreenplayLineBook(f.context,f.draft)).toEqual({version:1,episodeId:f.draft.episodeId,title:f.draft.title,lineCount:0,order:[],speakers:[]});
});

it('keeps all 8192 allowed lines and their final sequence without truncation',()=>{
  const f=screenplayFixture(),scene=f.draft.scenes[0]!,beat=scene.beats.find(row=>row.kind==='dialogue')!,line=beat.lines[0]!;scene.beats=[beat];beat.lines=Array.from({length:8192},(_,index)=>({...line,id:'l'+index,text:'字',delivery:'读'}));
  const book=createScreenplayLineBook(f.context,f.draft);expect(book.lineCount).toBe(8192);expect(book.order).toHaveLength(8192);expect(book.order.at(-1)).toBe('l8191');expect(book.speakers[0]!.lines.at(-1)).toMatchObject({id:'l8191',sequence:8192,text:'字',delivery:'读'});
});

it.each(['unknown-speaker','outside-scene','duplicate-line','inconsistent-voice'] as const)('rejects %s structural errors before publishing a line book',kind=>{
  const f=screenplayFixture(),scene=f.draft.scenes[0]!,beat=scene.beats.find(row=>row.kind==='dialogue')!,line=beat.lines[0]!;
  if(kind==='unknown-speaker')line.speakerId=f.id('unknown-line-book-speaker');else if(kind==='outside-scene')scene.characterIds=[];else if(kind==='duplicate-line')beat.lines.push({...line});else line.kind='narration';
  expect(()=>createScreenplayLineBook(f.context,f.draft)).toThrow('INVALID_REFERENCE');
});

it('does not evaluate draft getters or accept undeclared timing hints',()=>{
  const f=screenplayFixture(),line=f.draft.scenes[0]!.beats.find(row=>row.kind==='dialogue')!.lines[0]!;let touched=false;
  Object.defineProperty(line,'delivery',{enumerable:true,get(){touched=true;throw new Error('private delivery');}});expect(()=>createScreenplayLineBook(f.context,f.draft)).toThrow('INVALID_INPUT');expect(touched).toBe(false);
  const g=screenplayFixture();expect(()=>createScreenplayLineBook(g.context,{...g.draft,timing:{totalSeconds:1}})).toThrow('INVALID_INPUT');
});
