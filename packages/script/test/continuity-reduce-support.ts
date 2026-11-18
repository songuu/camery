import {fixtureId as id} from '../../ir/test/fixtures.js';
import type {ContinuityContext,ContinuityDraft,ContinuityEvent,Evidence} from '../src/continuity/contracts.js';
export {id};
export const a=id('continuity-reduce-a'),b=id('continuity-reduce-b'),c=id('continuity-reduce-c');
export function continuityReduceFixture(){
  const episodes=Array.from({length:3},(_,index)=>({id:id('continuity-reduce-episode-'+index),version:1,number:index+1}));
  const context:ContinuityContext={version:1,projectId:id('continuity-reduce-project'),packageId:id('continuity-reduce-package'),snapshotRevision:10,episodes,
    characters:[a,b,c].map(id=>({id,version:1})),props:[{id:id('continuity-reduce-prop'),version:1}],
    appearances:[{id:id('continuity-reduce-appearance'),version:1,characterId:a}],spots:[{id:id('continuity-reduce-spot'),location:{id:id('continuity-reduce-location'),version:1}}],
    events:episodes.flatMap(episode=>[
      {ref:{kind:'beat' as const,id:id(episode.id+'-beat'),version:1},episodeId:episode.id,sequence:1,characterIds:[a,b,c],speakerId:null,lineKind:null,text:'门打开了，甲看见红信。'},
      {ref:{kind:'line' as const,id:id(episode.id+'-line-a'),version:1},episodeId:episode.id,sequence:2,characterIds:[a,b,c],speakerId:a,lineKind:'on_screen' as const,text:'信在门后，锁已打开。'},
      {ref:{kind:'line' as const,id:id(episode.id+'-line-b'),version:1},episodeId:episode.id,sequence:3,characterIds:[a,b,c],speakerId:b,lineKind:'on_screen' as const,text:'我知道信在门后。'},
      {ref:{kind:'beat' as const,id:id(episode.id+'-leave'),version:1},episodeId:episode.id,sequence:4,characterIds:[a,b,c],speakerId:null,lineKind:null,text:'两人离开房间。'},
      {ref:{kind:'line' as const,id:id(episode.id+'-line-c'),version:1},episodeId:episode.id,sequence:5,characterIds:[a,b,c],speakerId:c,lineKind:'on_screen' as const,text:'我看见了。'},
    ])};
  const evidence=(episode=0,sequence=1):Evidence=>{const event=context.events.find(event=>event.episodeId===episodes[episode]!.id&&event.sequence===sequence)!;return {event:{...event.ref},quote:event.text};};
  const draft=(episode=0,events:ContinuityEvent[]=[]):ContinuityDraft=>({version:1,episodeId:episodes[episode]!.id,events});
  const fact=(eventId='assert',factId='red-letter',episode=0,sequence=1):ContinuityEvent=>({id:eventId,op:'assert_fact',factId,kind:'fact',text:'门后有红信',evidence:evidence(episode,sequence)});
  const learn=(eventId='witness',characterId=a,factId='red-letter',episode=0,sequence=1):ContinuityEvent=>({id:eventId,op:'learn',characterId,factId,source:{kind:'witness'},evidence:evidence(episode,sequence)});
  return {context,episodes,evidence,draft,fact,learn};
}
