import {expect,it} from 'vitest';
import {reduceEpisodeContinuity} from '../src/continuity/reduce.js';
import type {ContinuityEvent,ContinuityLedger} from '../src/continuity/contracts.js';
import {captureContinuityContext} from '../src/continuity/context.js';
import {makePackage} from '../../ir/test/fixtures.js';
import {a,b,c,continuityReduceFixture,id} from './continuity-reduce-support.js';

it('derives all four ledgers in declared evidence order and preserves immutable source records',()=>{
  const f=continuityReduceFixture(),events=[f.fact(),f.learn(),
    {id:'tell',op:'learn' as const,characterId:b,factId:'red-letter',source:{kind:'told' as const,fromCharacterId:a},evidence:f.evidence(0,2)},
    {id:'state',op:'set_character' as const,value:{characterId:a,summary:'保管红信',appearance:{id:f.context.appearances[0]!.id,version:1},spot:f.context.spots[0]!,holding:f.context.props},evidence:f.evidence(0,2)},
    {id:'plant',op:'plant' as const,threadId:'letter-origin',summary:'红信的主人',payoffEpisodeId:f.episodes[1]!.id,evidence:f.evidence(0,3)}];
  const result=reduceEpisodeContinuity(f.context,f.draft(0,events));
  expect(result.issues).toEqual([]);expect(result.ledger.facts).toHaveLength(1);expect(result.ledger.knowledge.map(value=>value.characterId)).toEqual([a,b]);expect(result.ledger.characters).toHaveLength(1);expect(result.ledger.threads).toHaveLength(1);expect(Object.isFrozen(result.ledger.facts[0])).toBe(true);
  events[0]!.evidence.quote='changed';expect(result.ledger.facts[0]!.introduced.evidence.quote).toBe('门打开了，甲看见红信。');
});
it('continues only the immediately previous episode and carries every ledger into the next episode',()=>{
  const f=continuityReduceFixture(),first=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn(),{id:'plant',op:'plant',threadId:'thread',summary:'红信',payoffEpisodeId:f.episodes[1]!.id,evidence:f.evidence()}])).ledger;
  const next=reduceEpisodeContinuity(f.context,f.draft(1,[{id:'use',op:'use_fact',characterId:a,factId:'red-letter',evidence:f.evidence(1)},{id:'pay',op:'payoff',threadId:'thread',evidence:f.evidence(1,2)}]),first);
  expect(next.issues).toEqual([]);expect(next.ledger.facts).toEqual(first.facts);expect(next.ledger.knowledge).toEqual(first.knowledge);expect(next.ledger.threads[0]!.paidOff?.episodeId).toBe(f.episodes[1]!.id);
  expect(()=>reduceEpisodeContinuity(f.context,f.draft(2),first)).toThrow('CONFLICT');expect(()=>reduceEpisodeContinuity(f.context,f.draft(1))).toThrow('INCOMPLETE');expect(()=>reduceEpisodeContinuity(f.context,f.draft(),first)).toThrow('CONFLICT');
});
it('does not invent knowledge for an unsourced speaker or same-line relay',()=>{
  const f=continuityReduceFixture(),result=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),
    {id:'bad',op:'learn',characterId:b,factId:'red-letter',source:{kind:'told',fromCharacterId:a},evidence:f.evidence(0,2)},
    {id:'use',op:'use_fact',characterId:b,factId:'red-letter',evidence:f.evidence(0,3)}]));
  expect(result.ledger.knowledge).toEqual([]);expect(result.issues.map(value=>value.code)).toEqual(['KNOWLEDGE_SOURCE','KNOWLEDGE_REQUIRED']);expect(result.issues[0]).toMatchObject({path:'events.1',eventId:'bad',severity:'error'});
  const same=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn('late',a,'red-letter',0,2),{id:'tell',op:'learn',characterId:b,factId:'red-letter',source:{kind:'told',fromCharacterId:a},evidence:f.evidence(0,2)}]));expect(same.issues[0]!.code).toBe('KNOWLEDGE_SOURCE');
});
it('rejects stale, forged and foreign previous ledger records before continuing',()=>{
  const f=continuityReduceFixture(),first=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn()])).ledger;
  for(const edit of [(value:typeof first)=>{value.projectId=id('other');},(value:typeof first)=>{value.packageId=id('other');},(value:typeof first)=>{value.snapshotRevision=11;},(value:typeof first)=>{value.facts[0]!.introduced.evidence.event.version++;},(value:typeof first)=>{value.knowledge[0]!.learned.evidence.quote='伪造';}]){const changed=structuredClone(first);edit(changed);expect(()=>reduceEpisodeContinuity(f.context,f.draft(1),changed)).toThrow();}
});
it('retains overdue threads with a locating warning instead of silently dropping them',()=>{
  const f=continuityReduceFixture(),result=reduceEpisodeContinuity(f.context,f.draft(0,[{id:'plant',op:'plant',threadId:'missed',summary:'当集应回收',payoffEpisodeId:f.episodes[0]!.id,evidence:f.evidence()}]));
  expect(result.ledger.threads).toHaveLength(1);expect(result.ledger.threads[0]!.paidOff).toBeNull();expect(result.issues).toEqual([expect.objectContaining({code:'OVERDUE_THREAD',severity:'warning',eventId:'plant'})]);
});
it('preserves same-beat declaration order across assert, learn and retirement',()=>{
  const f=continuityReduceFixture(),first=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn(),{id:'retire',op:'retire_fact',factId:'red-letter',evidence:f.evidence()}]));
  expect(first.issues).toEqual([]);expect(first.ledger.facts[0]!.introduced.order).toBe(1);expect(first.ledger.knowledge[0]!.learned.order).toBe(2);expect(first.ledger.facts[0]!.retired?.order).toBe(3);
  const next=reduceEpisodeContinuity(f.context,f.draft(1,[{id:'use',op:'use_fact',factId:'red-letter',characterId:a,evidence:f.evidence(1)}]),first.ledger);expect(next.issues[0]!.code).toBe('RETIRED_FACT');expect(next.ledger.knowledge).toEqual(first.ledger.knowledge);
});
it('keeps first fact and learning evidence when repeated assertions and learning agree',()=>{
  const f=continuityReduceFixture(),result=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn(),f.fact('assert-again'),f.learn('learn-again',a,'red-letter',0,2)]));
  expect(result.issues).toEqual([]);expect(result.ledger.facts[0]!.introduced.eventId).toBe('assert');expect(result.ledger.knowledge[0]!.learned.eventId).toBe('witness');expect(result.ledger.facts).toHaveLength(1);expect(result.ledger.knowledge).toHaveLength(1);
});
it('reports conflicting facts, unknown retirement and repeated retirement without changing established facts',()=>{
  const f=continuityReduceFixture(),original=f.fact(),conflicting=f.fact('conflict');if(conflicting.op!=='assert_fact')throw new Error('fixture');conflicting.text='另一种事实';
  const result=reduceEpisodeContinuity(f.context,f.draft(0,[original,conflicting,{id:'unknown-retire',op:'retire_fact',factId:'missing',evidence:f.evidence()},
    {id:'retire',op:'retire_fact',factId:'red-letter',evidence:f.evidence()},{id:'twice',op:'retire_fact',factId:'red-letter',evidence:f.evidence()},f.fact('resurrect')]));
  expect(result.issues.map(value=>value.code)).toEqual(['FACT_CONFLICT','UNKNOWN_FACT','RETIRED_FACT','FACT_CONFLICT']);expect(result.ledger.facts[0]!.text).toBe('门后有红信');expect(result.ledger.facts[0]!.retired?.eventId).toBe('retire');
});
it('does not overwrite fact kind even when repeated text agrees',()=>{
  const f=continuityReduceFixture(),other=f.fact('other-kind');if(other.op!=='assert_fact')throw new Error('fixture');other.kind='world_rule';
  expect(reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),other])).issues[0]!.code).toBe('FACT_CONFLICT');
});
it('distinguishes unknown, retired and not-yet-learned knowledge',()=>{
  const f=continuityReduceFixture(),result=reduceEpisodeContinuity(f.context,f.draft(0,[f.learn('unknown',b,'missing'),{id:'unknown-use',op:'use_fact',characterId:c,factId:'missing',evidence:f.evidence()},f.fact(),
    {id:'unlearned',op:'use_fact',characterId:c,factId:'red-letter',evidence:f.evidence()},{id:'retire',op:'retire_fact',factId:'red-letter',evidence:f.evidence()},f.learn('retired',b)]));
  expect(result.issues.map(value=>value.code)).toEqual(['UNKNOWN_FACT','UNKNOWN_FACT','KNOWLEDGE_REQUIRED','RETIRED_FACT']);expect(result.ledger.knowledge).toEqual([]);
});
it('deduces only from independent facts already known at an earlier native event',()=>{
  const f=continuityReduceFixture(),conclusion=f.fact('conclusion','sender',0,2),result=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn(),conclusion,
    {id:'deduce',op:'learn',characterId:a,factId:'sender',source:{kind:'deduced',factIds:['red-letter']},evidence:f.evidence(0,3)},
    {id:'use',op:'use_fact',characterId:a,factId:'sender',evidence:f.evidence(0,4)}]));
  expect(result.issues).toEqual([]);expect(result.ledger.knowledge[1]!.source).toEqual({kind:'deduced',factIds:['red-letter']});
  expect(reduceEpisodeContinuity(f.context,f.draft(1),result.ledger).ledger.knowledge).toEqual(result.ledger.knowledge);
});
it.each([
  ['self',['sender']],['unknown',['unknown']],['unlearned',['other']],
] as const)('rejects %s deduction premises',(_label,ids)=>{
  const f=continuityReduceFixture(),result=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn(),f.fact('other','other'),f.fact('conclusion','sender',0,2),
    {id:'deduce',op:'learn',characterId:a,factId:'sender',source:{kind:'deduced',factIds:[...ids]},evidence:f.evidence(0,3)}]));
  expect(result.issues).toEqual([expect.objectContaining({code:'KNOWLEDGE_SOURCE',eventId:'deduce'})]);expect(result.ledger.knowledge).toHaveLength(1);
});
it('rejects duplicate deduction references at the strict draft boundary',()=>{
  const f=continuityReduceFixture();expect(()=>reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn(),f.fact('conclusion','sender',0,2),{id:'deduce',op:'learn',characterId:a,factId:'sender',source:{kind:'deduced',factIds:['red-letter','red-letter']},evidence:f.evidence(0,3)}]))).toThrow('INVALID_REFERENCE');
});
it('rejects same-event and retired deduction premises',()=>{
  const f=continuityReduceFixture(),same=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn(),f.fact('conclusion','sender'),{id:'deduce',op:'learn',characterId:a,factId:'sender',source:{kind:'deduced',factIds:['red-letter']},evidence:f.evidence()}]));expect(same.issues[0]!.code).toBe('KNOWLEDGE_SOURCE');
  const retired=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn(),{id:'retire',op:'retire_fact',factId:'red-letter',evidence:f.evidence(0,2)},f.fact('conclusion','sender',0,2),{id:'deduce',op:'learn',characterId:a,factId:'sender',source:{kind:'deduced',factIds:['red-letter']},evidence:f.evidence(0,3)}]));expect(retired.issues[0]!.code).toBe('KNOWLEDGE_SOURCE');
});
it.each([
  ['beat',1,a],['wrong-speaker',2,b],['self',2,a],
] as const)('rejects told sources from %s',(_label,sequence,fromCharacterId)=>{
  const f=continuityReduceFixture(),receiver=_label==='self'?a:b,result=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn(),{id:'tell',op:'learn',characterId:receiver,factId:'red-letter',source:{kind:'told',fromCharacterId},evidence:f.evidence(0,sequence)}]));expect(result.issues[0]!.code).toBe('KNOWLEDGE_SOURCE');
});
it('updates one character without dropping other characters or prior physical-state evidence',()=>{
  const f=continuityReduceFixture(),state=(eventId:string,characterId:string,episode=0,summary='等待'):ContinuityEvent=>({id:eventId,op:'set_character',value:{characterId,summary,appearance:null,spot:null,holding:[]},evidence:f.evidence(episode)});
  const first=reduceEpisodeContinuity(f.context,f.draft(0,[state('a',a),state('b',b)])).ledger,next=reduceEpisodeContinuity(f.context,f.draft(1,[state('a-new',a,1,'离开')]),first);
  expect(next.ledger.characters.map(value=>value.value.characterId)).toEqual([a,b]);expect(next.ledger.characters[0]!.value.summary).toBe('离开');expect(next.ledger.characters[1]).toEqual(first.characters[1]);
});
it('reports unknown, repeated and mistimed payoffs while keeping the planted thread',()=>{
  const f=continuityReduceFixture(),result=reduceEpisodeContinuity(f.context,f.draft(0,[{id:'unknown',op:'payoff',threadId:'missing',evidence:f.evidence()},
    {id:'plant',op:'plant',threadId:'later',summary:'后集回收',payoffEpisodeId:f.episodes[1]!.id,evidence:f.evidence()},
    {id:'duplicate',op:'plant',threadId:'later',summary:'不能覆盖',payoffEpisodeId:null,evidence:f.evidence()},
    {id:'early',op:'payoff',threadId:'later',evidence:f.evidence(0,2)},
    {id:'open',op:'plant',threadId:'free',summary:'未指定回收集',payoffEpisodeId:null,evidence:f.evidence(0,2)},
    {id:'pay',op:'payoff',threadId:'free',evidence:f.evidence(0,3)},{id:'twice',op:'payoff',threadId:'free',evidence:f.evidence(0,4)}]));
  expect(result.issues.map(value=>value.code)).toEqual(['UNKNOWN_THREAD','THREAD_CONFLICT','PAYOFF_ORDER','PAYOFF_ORDER']);expect(result.ledger.threads[0]!.paidOff).toBeNull();expect(result.ledger.threads[1]!.paidOff?.eventId).toBe('pay');
});
it('carries an overdue inherited thread across multiple episodes and keeps its original planted evidence',()=>{
  const f=continuityReduceFixture(),first=reduceEpisodeContinuity(f.context,f.draft(0,[{id:'plant',op:'plant',threadId:'overdue',summary:'该回收',payoffEpisodeId:f.episodes[0]!.id,evidence:f.evidence()}])).ledger;
  const second=reduceEpisodeContinuity(f.context,f.draft(1),first),third=reduceEpisodeContinuity(f.context,f.draft(2),second.ledger);expect(second.issues[0]!.code).toBe('OVERDUE_THREAD');expect(third.issues[0]!.code).toBe('OVERDUE_THREAD');expect(third.ledger.threads).toEqual(first.threads);
});

function previousFixture(){
  const f=continuityReduceFixture();
  const ledger=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn(),{id:'state',op:'set_character',value:{characterId:a,summary:'等待',appearance:{id:f.context.appearances[0]!.id,version:1},spot:f.context.spots[0]!,holding:f.context.props},evidence:f.evidence(0,2)},
    {id:'plant',op:'plant',threadId:'thread',summary:'未指定回收集',payoffEpisodeId:null,evidence:f.evidence(0,3)},{id:'pay',op:'payoff',threadId:'thread',evidence:f.evidence(0,4)}])).ledger;
  return {...f,ledger};
}
const previousMutations:Array<[string,(ledger:ContinuityLedger)=>void]>=[
  ['duplicate fact',v=>{v.facts.push(structuredClone(v.facts[0]!));}],
  ['duplicate knowledge',v=>{v.knowledge.push(structuredClone(v.knowledge[0]!));}],
  ['duplicate character',v=>{v.characters.push(structuredClone(v.characters[0]!));}],
  ['duplicate thread',v=>{v.threads.push(structuredClone(v.threads[0]!));}],
  ['unknown knowledge fact',v=>{v.knowledge[0]!.factId='missing';}],
  ['unsourced knowledge',v=>{v.knowledge[0]!.source={kind:'told',fromCharacterId:b};}],
  ['unknown character',v=>{v.characters[0]!.value.characterId=id('missing');}],
  ['unknown appearance',v=>{v.characters[0]!.value.appearance!.id=id('missing');}],
  ['stale appearance',v=>{v.characters[0]!.value.appearance!.version++;}],
  ['wrong appearance owner',v=>{v.characters[0]!.value.characterId=b;}],
  ['unknown spot',v=>{v.characters[0]!.value.spot!.id=id('missing');}],
  ['wrong location',v=>{v.characters[0]!.value.spot!.location.id=id('missing');}],
  ['stale location',v=>{v.characters[0]!.value.spot!.location.version++;}],
  ['unknown holding',v=>{v.characters[0]!.value.holding[0]!.id=id('missing');}],
  ['stale holding',v=>{v.characters[0]!.value.holding[0]!.version++;}],
  ['duplicate holding',v=>{v.characters[0]!.value.holding.push(structuredClone(v.characters[0]!.value.holding[0]!));}],
  ['unknown planned episode',v=>{v.threads[0]!.payoffEpisodeId=id('missing');}],
  ['wrong payoff episode',v=>{v.threads[0]!.payoffEpisodeId=v.episodeId.replace(/.$/,'A');}],
  ['duplicate declaration id',v=>{v.knowledge[0]!.learned.eventId=v.facts[0]!.introduced.eventId;}],
  ['duplicate declaration order',v=>{v.knowledge[0]!.learned.order=v.facts[0]!.introduced.order;}],
  ['zero declaration order',v=>{v.facts[0]!.introduced.order=0;}],
  ['unbounded declaration order',v=>{v.facts[0]!.introduced.order=2049;}],
  ['contradictory declaration order',v=>{v.characters[0]!.changed.order=8;}],
  ['mismatched evidence episode',v=>{v.facts[0]!.introduced.episodeId=id('missing');}],
  ['unknown native event',v=>{v.facts[0]!.introduced.evidence.event.id=id('missing');}],
  ['wrong native event kind',v=>{v.facts[0]!.introduced.evidence.event.kind='line';}],
];
it.each(previousMutations)('rejects previous %s without rewriting it',(_name,edit)=>{
  const f=previousFixture(),changed=structuredClone(f.ledger);edit(changed);expect(()=>reduceEpisodeContinuity(f.context,f.draft(1),changed)).toThrow();expect(f.ledger.facts[0]!.introduced.order).toBe(1);
});
it('rejects previous knowledge that was introduced only after learning and retirement before introduction',()=>{
  const f=previousFixture(),laterFact=structuredClone(f.ledger);laterFact.facts[0]!.introduced.order=8;expect(()=>reduceEpisodeContinuity(f.context,f.draft(1),laterFact)).toThrow('INVALID_REFERENCE');
  const retired=structuredClone(f.ledger);retired.facts[0]!.retired={episodeId:retired.episodeId,eventId:'retired',order:1,evidence:f.evidence()};retired.facts[0]!.introduced.order=2;retired.knowledge=[];expect(()=>reduceEpisodeContinuity(f.context,f.draft(1),retired)).toThrow('INVALID_REFERENCE');
});
it('rejects previous payoff evidence before its plant or with a different declared episode',()=>{
  const f=previousFixture(),early=structuredClone(f.ledger);early.threads[0]!.paidOff!.evidence=f.evidence();expect(()=>reduceEpisodeContinuity(f.context,f.draft(1),early)).toThrow('INVALID_REFERENCE');
  const mismatch=structuredClone(f.ledger);mismatch.threads[0]!.payoffEpisodeId=f.episodes[1]!.id;expect(()=>reduceEpisodeContinuity(f.context,f.draft(1),mismatch)).toThrow('INVALID_REFERENCE');
});
it('rejects future previous evidence even when it is an actual current native event',()=>{
  const f=previousFixture(),future=structuredClone(f.ledger);future.facts[0]!.introduced={episodeId:f.episodes[1]!.id,eventId:'future',order:1,evidence:f.evidence(1)};expect(()=>reduceEpisodeContinuity(f.context,f.draft(1),future)).toThrow('INVALID_REFERENCE');
});
it('does not execute hostile input accessors or leak dependency details',()=>{
  const f=continuityReduceFixture();let calls=0;const hostile={get version(){calls++;throw new Error('private-credential');}};expect(()=>reduceEpisodeContinuity(f.context,f.draft(1),hostile)).toThrow('INVALID_INPUT');expect(calls).toBe(0);
});
it('fails on aggregate ledger capacity without truncating earlier records',()=>{
  const f=continuityReduceFixture(),first=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact()])).ledger,large=structuredClone(first);
  large.facts=Array.from({length:2048},(_,index)=>({...structuredClone(first.facts[0]!),id:'fact-'+index,text:'汉'.repeat(1000),introduced:{...structuredClone(first.facts[0]!.introduced),eventId:'intro-'+index,order:index+1}}));
  expect(()=>reduceEpisodeContinuity(f.context,f.draft(1),large)).toThrow('INPUT_LIMIT');expect(large.facts).toHaveLength(2048);expect(first.facts).toHaveLength(1);
});
it.each(['inner_monologue','narration'] as const)('does not teach another character through an actual native %s line',kind=>{
  const pkg=structuredClone(makePackage()),line=pkg.lines.find(value=>value.id===id(kind==='narration'?'n_open':'l_say'))!;line.kind=kind;
  const context=captureContinuityContext(pkg),event=context.events.find(value=>value.ref.id===line.id)!,beat=context.events.find(value=>value.ref.kind==='beat'&&value.episodeId===event.episodeId)!,characterId=id('char_he');
  const result=reduceEpisodeContinuity(context,{version:1,episodeId:event.episodeId,events:[
    {id:'assert',op:'assert_fact',factId:'note',kind:'fact',text:'便签的内容',evidence:{event:beat.ref,quote:beat.text}},
    {id:'learn',op:'learn',characterId,factId:'note',source:{kind:'witness'},evidence:{event:event.ref,quote:event.text}},
  ]});expect(result.issues).toEqual([expect.objectContaining({code:'KNOWLEDGE_SOURCE',eventId:'learn'})]);expect(result.ledger.knowledge).toEqual([]);
});
it('accepts explicit self-monologue learning and deduction, without making either knowledge public',()=>{
  const f=continuityReduceFixture();f.context.events.find(value=>value.episodeId===f.episodes[0]!.id&&value.sequence===2)!.lineKind='inner_monologue';
  const result=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn('known',a),f.fact('deduced-fact','sender',0,2),
    {id:'self-witness',op:'learn',characterId:a,factId:'sender',source:{kind:'witness'},evidence:f.evidence(0,2)},
    {id:'self-deduce',op:'learn',characterId:a,factId:'sender',source:{kind:'deduced',factIds:['red-letter']},evidence:f.evidence(0,2)},
    {id:'others-deduce',op:'learn',characterId:b,factId:'sender',source:{kind:'deduced',factIds:['red-letter']},evidence:f.evidence(0,2)},
    {id:'self-use',op:'use_fact',characterId:a,factId:'sender',evidence:f.evidence(0,2)}]));
  expect(result.issues.map(value=>[value.code,value.eventId])).toEqual([['KNOWLEDGE_SOURCE','others-deduce']]);expect(result.ledger.knowledge.map(value=>value.characterId)).toEqual([a,a]);
  expect(reduceEpisodeContinuity(f.context,f.draft(1),result.ledger).ledger.knowledge).toEqual(result.ledger.knowledge);
});
it.each(['inner_monologue','narration'] as const)('refuses telling through %s even when the speaker already knows',kind=>{
  const f=continuityReduceFixture();f.context.events.find(value=>value.episodeId===f.episodes[0]!.id&&value.sequence===2)!.lineKind=kind;
  const result=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn(),{id:'private-tell',op:'learn',characterId:b,factId:'red-letter',source:{kind:'told',fromCharacterId:a},evidence:f.evidence(0,2)}]));
  expect(result.issues).toEqual([expect.objectContaining({code:'KNOWLEDGE_SOURCE',eventId:'private-tell'})]);expect(result.ledger.knowledge.map(value=>value.characterId)).toEqual([a]);
});
it('accepts real off-screen dialogue as an explicit telling source',()=>{
  const pkg=structuredClone(makePackage()),line=pkg.lines.find(value=>value.id===id('l_say'))!;line.kind='off_screen';
  const context=captureContinuityContext(pkg),event=context.events.find(value=>value.ref.id===line.id)!,beat=context.events.find(value=>value.ref.kind==='beat'&&value.episodeId===event.episodeId)!,speakerId=line.speaker_id;
  const result=reduceEpisodeContinuity(context,{version:1,episodeId:event.episodeId,events:[
    {id:'assert',op:'assert_fact',factId:'note',kind:'fact',text:'便签的内容',evidence:{event:beat.ref,quote:beat.text}},
    {id:'witness',op:'learn',characterId:speakerId,factId:'note',source:{kind:'witness'},evidence:{event:beat.ref,quote:beat.text}},
    {id:'tell',op:'learn',characterId:id('char_he'),factId:'note',source:{kind:'told',fromCharacterId:speakerId},evidence:{event:event.ref,quote:event.text}},
  ]});expect(result.issues).toEqual([]);expect(result.ledger.knowledge.map(value=>value.characterId)).toEqual([speakerId,id('char_he')]);
});
it('accepts an explicitly declared own learning from an actual native inner monologue',()=>{
  const pkg=structuredClone(makePackage()),line=pkg.lines.find(value=>value.id===id('l_say'))!;line.kind='inner_monologue';
  const context=captureContinuityContext(pkg),event=context.events.find(value=>value.ref.id===line.id)!,beat=context.events.find(value=>value.ref.kind==='beat'&&value.episodeId===event.episodeId)!;
  const result=reduceEpisodeContinuity(context,{version:1,episodeId:event.episodeId,events:[
    {id:'assert',op:'assert_fact',factId:'note',kind:'fact',text:'便签的内容',evidence:{event:beat.ref,quote:beat.text}},
    {id:'self',op:'learn',characterId:line.speaker_id,factId:'note',source:{kind:'witness'},evidence:{event:event.ref,quote:event.text}},
  ]});expect(result.issues).toEqual([]);expect(result.ledger.knowledge.map(value=>value.characterId)).toEqual([line.speaker_id]);
});
it.each(['inner_monologue','narration'] as const)('reports private %s use even when another character already knows the fact',kind=>{
  const f=continuityReduceFixture();f.context.events.find(value=>value.episodeId===f.episodes[0]!.id&&value.sequence===2)!.lineKind=kind;
  const result=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn('known-other',b),{id:'private-use',op:'use_fact',characterId:b,factId:'red-letter',evidence:f.evidence(0,2)}]));
  expect(result.issues).toEqual([expect.objectContaining({code:'KNOWLEDGE_SOURCE',eventId:'private-use'})]);expect(result.ledger.knowledge[0]!.characterId).toBe(b);
});
it('does not turn narrator knowledge or inference into a character mental event',()=>{
  const f=continuityReduceFixture();f.context.events.find(value=>value.episodeId===f.episodes[0]!.id&&value.sequence===2)!.lineKind='narration';
  const result=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn('premise',a),f.fact('conclusion','sender',0,2),
    {id:'narrator-witness',op:'learn',characterId:a,factId:'sender',source:{kind:'witness'},evidence:f.evidence(0,2)},
    {id:'narrator-deduce',op:'learn',characterId:a,factId:'sender',source:{kind:'deduced',factIds:['red-letter']},evidence:f.evidence(0,2)},
    {id:'narrator-use',op:'use_fact',characterId:a,factId:'red-letter',evidence:f.evidence(0,2)},
    {id:'physical-description',op:'set_character',value:{characterId:b,summary:'旁白明确描述其站立等候',appearance:null,spot:null,holding:[]},evidence:f.evidence(0,2)}]));
  expect(result.issues.map(value=>[value.code,value.eventId])).toEqual([['KNOWLEDGE_SOURCE','narrator-witness'],['KNOWLEDGE_SOURCE','narrator-deduce'],['KNOWLEDGE_SOURCE','narrator-use']]);expect(result.ledger.characters[0]!.value.characterId).toBe(b);expect(result.ledger.knowledge).toHaveLength(1);
});
it('rejects inherited knowledge whose current native voice evidence is now private to another character',()=>{
  const f=continuityReduceFixture(),first=reduceEpisodeContinuity(f.context,f.draft(0,[f.fact(),f.learn(),{id:'tell',op:'learn',characterId:b,factId:'red-letter',source:{kind:'told',fromCharacterId:a},evidence:f.evidence(0,2)}])).ledger;
  f.context.events.find(value=>value.episodeId===f.episodes[0]!.id&&value.sequence===2)!.lineKind='inner_monologue';expect(()=>reduceEpisodeContinuity(f.context,f.draft(1),first)).toThrow('INVALID_REFERENCE');
});
