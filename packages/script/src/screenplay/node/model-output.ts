import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {ScreenplayDraftSchema,SCREENPLAY_DRAFT_BYTES,ScreenplayError} from '../contracts.js';
import type {ScreenplayDraft} from '../contracts.js';
import {ScreenplayModelOutputSchema,SCREENPLAY_MODEL_OUTPUT_BYTES} from './model-contracts.js';

function invalid(path:string):never{throw new ScreenplayError('INVALID_REFERENCE','model screenplay normalization',path);}
/** Provider-specific empty values are checked, never guessed; the original proposal remains separate from human review. */
export function normalizeScreenplayModelOutput(input:unknown):ScreenplayDraft{
  const output=captureScreenplay(ScreenplayModelOutputSchema,input,'model screenplay proposal',SCREENPLAY_MODEL_OUTPUT_BYTES),groups=output.continuity;
  if(Object.values(groups).reduce((total,rows)=>total+rows.length,0)>2048)throw new ScreenplayError('INPUT_LIMIT','model screenplay declarations','/continuity');
  const ordered:{order:number;path:string;event:ScreenplayDraft['continuity'][number]}[]=[];
  const add=(group:string,index:number,order:number,event:ScreenplayDraft['continuity'][number])=>ordered.push({order,path:`/continuity/${group}/${index}`,event});
  for(const [i,row] of groups.assertFacts.entries())add('assertFacts',i,row.order,{id:row.id,op:'assert_fact',factId:row.factId,kind:row.kind,text:row.text,evidence:row.evidence});
  for(const [i,row] of groups.retireFacts.entries())add('retireFacts',i,row.order,{id:row.id,op:'retire_fact',factId:row.factId,evidence:row.evidence});
  for(const [i,row] of groups.learnFacts.entries()){
    const source=row.source,path=`/continuity/learnFacts/${i}/source`;
    if(source.kind==='witness'){
      if(source.fromCharacterId!==null||source.factIds.length)invalid(path);
      add('learnFacts',i,row.order,{id:row.id,op:'learn',characterId:row.characterId,factId:row.factId,source:{kind:'witness'},evidence:row.evidence});
    }else if(source.kind==='told'){
      if(source.fromCharacterId===null||source.factIds.length)invalid(path);
      add('learnFacts',i,row.order,{id:row.id,op:'learn',characterId:row.characterId,factId:row.factId,source:{kind:'told',fromCharacterId:source.fromCharacterId},evidence:row.evidence});
    }else{
      if(source.fromCharacterId!==null||!source.factIds.length||new Set(source.factIds).size!==source.factIds.length)invalid(path);
      add('learnFacts',i,row.order,{id:row.id,op:'learn',characterId:row.characterId,factId:row.factId,source:{kind:'deduced',factIds:source.factIds},evidence:row.evidence});
    }
  }
  for(const [i,row] of groups.useFacts.entries())add('useFacts',i,row.order,{id:row.id,op:'use_fact',characterId:row.characterId,factId:row.factId,evidence:row.evidence});
  for(const [i,row] of groups.setCharacters.entries()){
    const {appearance,spot}=row,path=`/continuity/setCharacters/${i}`;
    if((appearance.id===null)!==(appearance.version===0))invalid(path+'/appearance');
    if(spot.id===null?spot.locationId!==null||spot.locationVersion!==0:spot.locationId===null||spot.locationVersion===0)invalid(path+'/spot');
    add('setCharacters',i,row.order,{id:row.id,op:'set_character',value:{characterId:row.characterId,summary:row.summary,appearance:appearance.id===null?null:{id:appearance.id,version:appearance.version},spot:spot.id===null?null:{id:spot.id,location:{id:spot.locationId!,version:spot.locationVersion}},holding:row.holding},evidence:row.evidence});
  }
  for(const [i,row] of groups.plantThreads.entries())add('plantThreads',i,row.order,{id:row.id,op:'plant',threadId:row.threadId,summary:row.summary,payoffEpisodeId:row.payoffEpisodeId,evidence:row.evidence});
  for(const [i,row] of groups.payoffThreads.entries())add('payoffThreads',i,row.order,{id:row.id,op:'payoff',threadId:row.threadId,evidence:row.evidence});
  const ids=new Set<string>();for(const row of ordered){if(ids.has(row.event.id))invalid(row.path+'/id');ids.add(row.event.id);}
  ordered.sort((a,b)=>a.order-b.order);for(const [i,row] of ordered.entries())if(row.order!==i+1)invalid(row.path+'/order');
  const {continuity:_proposal,...script}=output;
  return freezeScreenplay(captureScreenplay(ScreenplayDraftSchema,{...script,continuity:ordered.map(row=>row.event)},'normalized screenplay draft',SCREENPLAY_DRAFT_BYTES));
}
