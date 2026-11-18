import {captureContinuity,freezeContinuity} from './boundary.js';
import {validateContinuityContext,validateContinuityDraft} from './context.js';
import {CONTINUITY_LEDGER_BYTES,ContinuityError,ContinuityLedgerSchema} from './contracts.js';
import type {ContinuityContext,ContinuityEvent,ContinuityIssue,ContinuityLedger,ContinuityReduction,LedgerEvidence} from './contracts.js';

type SourceEvent=ContinuityContext['events'][number];
type Fact=ContinuityLedger['facts'][number];
type Knowledge=ContinuityLedger['knowledge'][number];
type Position={episode:number;sequence:number;order:number};
const key=(characterId:string,factId:string)=>JSON.stringify([characterId,factId]);
const eventKey=(event:{kind:string;id:string})=>event.kind+':'+event.id;
const less=(a:Position,b:Position)=>a.episode<b.episode||(a.episode===b.episode&&(a.sequence<b.sequence||(a.sequence===b.sequence&&a.order<b.order)));
function fail(path:string,code:'INVALID_REFERENCE'|'CONFLICT'|'INCOMPLETE'='INVALID_REFERENCE'):never{throw new ContinuityError(code,'ledger continuation',path);}

/** A validated previous ledger is still only domain data; adoption authority belongs to the host. */
export function reduceEpisodeContinuity(contextInput:unknown,draftInput:unknown,previousInput:unknown=null):ContinuityReduction{
  const context=validateContinuityContext(contextInput),draft=validateContinuityDraft(context,draftInput);
  const episodeIndex=context.episodes.findIndex(value=>value.id===draft.episodeId),episode=context.episodes[episodeIndex]!;
  const episodeNumbers=new Map(context.episodes.map(value=>[value.id,value.number])),sourceEvents=new Map(context.events.map(value=>[eventKey(value.ref),value]));
  const position=(event:SourceEvent,order=0):Position=>({episode:episodeNumbers.get(event.episodeId)!,sequence:event.sequence,order});
  const source=(record:LedgerEvidence,path:string,previous=false):SourceEvent=>{
    const event=sourceEvents.get(eventKey(record.evidence.event));
    if(!event||event.ref.version!==record.evidence.event.version||event.episodeId!==record.episodeId||!event.text.includes(record.evidence.quote))fail(path);
    if(previous&&episodeNumbers.get(event.episodeId)!>=episode.number)fail(path);
    return event;
  };
  const recordPosition=(record:LedgerEvidence)=>position(source(record,'ledger evidence'),record.order);
  const provenance=(event:ContinuityEvent,index:number):LedgerEvidence=>({episodeId:draft.episodeId,eventId:event.id,order:index+1,evidence:structuredClone(event.evidence)});
  let ledger:ContinuityLedger={version:1,projectId:context.projectId,packageId:context.packageId,episodeId:draft.episodeId,snapshotRevision:context.snapshotRevision,facts:[],knowledge:[],characters:[],threads:[]};
  if(episodeIndex===0){if(previousInput!==null)fail('previous','CONFLICT');}
  else{
    if(previousInput===null)fail('previous','INCOMPLETE');
    ledger=captureContinuity(ContinuityLedgerSchema,previousInput,'previous ledger',CONTINUITY_LEDGER_BYTES);
    if(ledger.projectId!==context.projectId||ledger.packageId!==context.packageId||ledger.episodeId!==context.episodes[episodeIndex-1]!.id||ledger.snapshotRevision>context.snapshotRevision)fail('previous','CONFLICT');
  }
  const facts=new Map<string,Fact>(),knowledge=new Map<string,Knowledge>(),characters=new Map<string,ContinuityLedger['characters'][number]>(),threads=new Map<string,ContinuityLedger['threads'][number]>();
  const unique=<T>(map:Map<string,T>,id:string,value:T,path:string)=>{if(map.has(id))fail(path);map.set(id,value);};
  const priorEventIds=new Set<string>(),priorOrders=new Map<string,{order:number;sequence:number;path:string}[]>();
  const priorSource=(record:LedgerEvidence,path:string)=>{
    const event=source(record,path,true),id=key(record.episodeId,record.eventId);if(priorEventIds.has(id))fail(path);priorEventIds.add(id);
    const orders=priorOrders.get(record.episodeId)??[];if(orders.some(value=>value.order===record.order))fail(path+'.order');orders.push({order:record.order,sequence:event.sequence,path});priorOrders.set(record.episodeId,orders);return event;
  };
  for(const [index,fact] of ledger.facts.entries()){
    const path=`previous.facts.${index}`;unique(facts,fact.id,fact,path);const introduced=priorSource(fact.introduced,path+'.introduced');
    if(fact.retired){priorSource(fact.retired,path+'.retired');if(less(recordPosition(fact.retired),position(introduced,fact.introduced.order)))fail(path+'.retired');}
  }
  const activeAt=(fact:Fact,event:SourceEvent,order:number)=>{
    const at=position(event,order),introduced=recordPosition(fact.introduced);
    return !less(at,introduced)&&(fact.retired===null||less(at,recordPosition(fact.retired)));
  };
  const knewBefore=(characterId:string,factId:string,event:SourceEvent,order:number)=>{
    const known=knowledge.get(key(characterId,factId)),fact=facts.get(factId);
    return !!known&&!!fact&&activeAt(fact,event,order)&&less(position(source(known.learned,'knowledge.learned')),position(event));
  };
  const characterEvidence=(event:SourceEvent,characterId:string)=>event.characterIds.includes(characterId)&&event.lineKind!=='narration'&&(event.lineKind!=='inner_monologue'||event.speakerId===characterId);
  const validLearning=(value:Pick<Knowledge,'characterId'|'factId'|'source'>,event:SourceEvent,order:number)=>{
    if(!characterEvidence(event,value.characterId))return false;
    if(value.source.kind==='witness')return true;
    if(value.source.kind==='told')return event.ref.kind==='line'&&(event.lineKind==='on_screen'||event.lineKind==='off_screen')&&event.speakerId===value.source.fromCharacterId&&value.source.fromCharacterId!==value.characterId&&knewBefore(value.source.fromCharacterId,value.factId,event,order);
    const ids=value.source.factIds;
    return new Set(ids).size===ids.length&&!ids.includes(value.factId)&&ids.every(id=>knewBefore(value.characterId,id,event,order));
  };
  for(const [index,value] of ledger.knowledge.entries()){
    const path=`previous.knowledge.${index}`;unique(knowledge,key(value.characterId,value.factId),value,path);const event=priorSource(value.learned,path+'.learned'),fact=facts.get(value.factId);
    if(!fact||!activeAt(fact,event,value.learned.order))fail(path+'.factId');
  }
  // Check after collecting every prior record: ledger array order is not temporal proof.
  for(const [index,value] of ledger.knowledge.entries())if(!validLearning(value,source(value.learned,`previous.knowledge.${index}.learned`),value.learned.order))fail(`previous.knowledge.${index}.source`);
  const characterRefs=new Set(context.characters.map(value=>value.id)),appearances=new Map(context.appearances.map(value=>[value.id,value])),props=new Map(context.props.map(value=>[value.id,value.version])),spots=new Map(context.spots.map(value=>[value.id,value.location]));
  for(const [index,value] of ledger.characters.entries()){
    const path=`previous.characters.${index}`;unique(characters,value.value.characterId,value,path);const event=priorSource(value.changed,path+'.changed'),state=value.value;
    if(!characterRefs.has(state.characterId)||!event.characterIds.includes(state.characterId))fail(path+'.value.characterId');
    if(state.appearance){const appearance=appearances.get(state.appearance.id);if(!appearance||appearance.characterId!==state.characterId||appearance.version!==state.appearance.version)fail(path+'.value.appearance');}
    if(state.spot){const location=spots.get(state.spot.id);if(!location||location.id!==state.spot.location.id||location.version!==state.spot.location.version)fail(path+'.value.spot');}
    if(new Set(state.holding.map(value=>value.id)).size!==state.holding.length||state.holding.some(value=>props.get(value.id)!==value.version))fail(path+'.value.holding');
  }
  for(const [index,value] of ledger.threads.entries()){
    const path=`previous.threads.${index}`;unique(threads,value.id,value,path);const planted=priorSource(value.planted,path+'.planted');
    const payoffNumber=value.payoffEpisodeId===null?undefined:episodeNumbers.get(value.payoffEpisodeId);
    if(value.payoffEpisodeId!==null&&(payoffNumber===undefined||payoffNumber<position(planted).episode))fail(path+'.payoffEpisodeId');
    if(value.paidOff){const paid=priorSource(value.paidOff,path+'.paidOff');if(less(recordPosition(value.paidOff),position(planted,value.planted.order))||(payoffNumber!==undefined&&payoffNumber!==position(paid).episode))fail(path+'.paidOff');}
  }
  for(const orders of priorOrders.values()){orders.sort((a,b)=>a.order-b.order);for(let i=1;i<orders.length;i++)if(orders[i]!.sequence<orders[i-1]!.sequence)fail(orders[i]!.path+'.order');}
  const issues:ContinuityIssue[]=[];
  const issue=(code:ContinuityIssue['code'],index:number,event:ContinuityEvent,message:string)=>issues.push({code,severity:'error',path:`events.${index}`,eventId:event.id,message});
  for(const [index,event] of draft.events.entries()){
    const at=sourceEvents.get(eventKey(event.evidence.event))!,record=provenance(event,index);
    if(event.op==='assert_fact'){
      const existing=facts.get(event.factId);
      if(existing){if(existing.text!==event.text||existing.kind!==event.kind||existing.retired!==null)issue('FACT_CONFLICT',index,event,'Fact identity already describes different or retired content');}
      else facts.set(event.factId,{id:event.factId,kind:event.kind,text:event.text,introduced:record,retired:null});
    }else if(event.op==='retire_fact'){
      const fact=facts.get(event.factId);
      if(!fact)issue('UNKNOWN_FACT',index,event,'Cannot retire an unknown fact');else if(fact.retired)issue('RETIRED_FACT',index,event,'Fact is already retired');else fact.retired=record;
    }else if(event.op==='learn'||event.op==='use_fact'){
      const fact=facts.get(event.factId);
      if(!fact){issue('UNKNOWN_FACT',index,event,'Knowledge refers to an unknown fact');continue;}
      if(fact.retired){issue('RETIRED_FACT',index,event,'Knowledge refers to a retired fact');continue;}
      const known=knowledge.get(key(event.characterId,event.factId));
      if(event.op==='use_fact'){if(!characterEvidence(at,event.characterId))issue('KNOWLEDGE_SOURCE',index,event,'Narration or another character\'s private monologue cannot evidence this character using knowledge');else if(!known)issue('KNOWLEDGE_REQUIRED',index,event,'Character uses a fact without an earlier learning declaration');}
      else if(!validLearning(event,at,index+1))issue('KNOWLEDGE_SOURCE',index,event,'Learning source lacks an earlier known fact, valid speaker or independent premises');
      else if(!known)knowledge.set(key(event.characterId,event.factId),{characterId:event.characterId,factId:event.factId,source:structuredClone(event.source),learned:record});
    }else if(event.op==='set_character')characters.set(event.value.characterId,{value:structuredClone(event.value),changed:record});
    else if(event.op==='plant'){
      if(threads.has(event.threadId))issue('THREAD_CONFLICT',index,event,'Thread identity has already been planted');
      else threads.set(event.threadId,{id:event.threadId,summary:event.summary,payoffEpisodeId:event.payoffEpisodeId,planted:record,paidOff:null});
    }else{
      const thread=threads.get(event.threadId);
      if(!thread)issue('UNKNOWN_THREAD',index,event,'Cannot pay off a thread that has not been planted');
      else if(thread.paidOff!==null||less(position(at,index+1),recordPosition(thread.planted))||(thread.payoffEpisodeId!==null&&thread.payoffEpisodeId!==draft.episodeId))issue('PAYOFF_ORDER',index,event,'Thread payoff is repeated, premature or outside its declared episode');
      else thread.paidOff=record;
    }
  }
  for(const [index,value] of [...threads.values()].entries())if(value.paidOff===null&&value.payoffEpisodeId!==null&&episodeNumbers.get(value.payoffEpisodeId)!<=episode.number)issues.push({code:'OVERDUE_THREAD',severity:'warning',path:`ledger.threads.${index}`,eventId:value.planted.eventId,message:'Declared payoff episode has ended without a matching payoff'});
  ledger=captureContinuity(ContinuityLedgerSchema,{version:1,projectId:context.projectId,packageId:context.packageId,episodeId:draft.episodeId,snapshotRevision:context.snapshotRevision,facts:[...facts.values()],knowledge:[...knowledge.values()],characters:[...characters.values()],threads:[...threads.values()]},'derived ledger',CONTINUITY_LEDGER_BYTES);
  return freezeContinuity({ledger,issues});
}
