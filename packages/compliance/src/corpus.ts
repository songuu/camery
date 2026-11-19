import {ScreenplayDraftSchema,SCREENPLAY_DRAFT_BYTES} from '@camery/script/screenplay/contracts';
import {capture,captureCorpus} from './boundary.js';
import {z} from 'zod';
import {SpeakerNameSchema,ComplianceError} from './contracts.js';
import type {Segment,Field,Corpus} from './contracts.js';
/** Paths address the rendered screenplay view {...draft,speakers}; the Node reader proves actual source/name authority. */
export function projectScreenplayCorpus(input:unknown,speakersInput:unknown=[]):Corpus{
  const draft=capture(ScreenplayDraftSchema,input,'screenplay precheck input',SCREENPLAY_DRAFT_BYTES),segments:Segment[]=[];
  const add=(field:Field,path:string,text:string,meta:Partial<Pick<Segment,'sceneId'|'beatId'|'lineId'|'voice'|'speakerId'>>={})=>segments.push({id:'text-'+(segments.length+1),path,field,text,sceneId:null,beatId:null,lineId:null,voice:null,speakerId:null,...meta});
  add('episode_title','/title',draft.title);
  for(const [si,scene]of draft.scenes.entries()){
    const path=`/scenes/${si}`,sm={sceneId:scene.id};add('scene_title',path+'/title',scene.title,sm);add('scene_start',path+'/startState',scene.startState,sm);
    for(const [bi,beat]of scene.beats.entries()){
      const bp=path+`/beats/${bi}`,bm={...sm,beatId:beat.id};add('beat',bp+'/summary',beat.summary,bm);if(beat.origin.reason!==null)add('origin',bp+'/origin/reason',beat.origin.reason,bm);
      for(const [ci,citation]of beat.origin.citations.entries())if(citation.quote!==null)add('citation',bp+`/origin/citations/${ci}/quote`,citation.quote,bm);
      for(const [li,line]of beat.lines.entries()){const lp=bp+`/lines/${li}`,lm={...bm,lineId:line.id,voice:line.kind,speakerId:line.speakerId};add('line',lp+'/text',line.text,lm);add('delivery',lp+'/delivery',line.delivery,lm);}
    }
    add('scene_end',path+'/endState',scene.endState,sm);
  }
  if(draft.openingHook!==null)add('hook','/openingHook/reason',draft.openingHook.reason);if(draft.closingHook!==null)add('hook','/closingHook/reason',draft.closingHook.reason);
  for(const [i,event]of draft.continuity.entries()){
    const p=`/continuity/${i}`;if(event.op==='assert_fact')add('continuity',p+'/text',event.text);if(event.op==='set_character')add('continuity',p+'/value/summary',event.value.summary);if(event.op==='plant')add('continuity',p+'/summary',event.summary);add('continuity',p+'/evidence/quote',event.evidence.quote);
  }
  const speakers=capture(z.array(SpeakerNameSchema).max(8192),speakersInput,'rendered screenplay speakers',4194304),actual=new Set(draft.scenes.flatMap(scene=>scene.beats.flatMap(beat=>beat.lines.map(line=>line.speakerId))));if(new Set(speakers.map(row=>row.id)).size!==speakers.length||speakers.some(row=>!actual.has(row.id)))throw new ComplianceError('INVALID_REFERENCE','rendered screenplay speakers','speakers');
  for(const [i,speaker]of speakers.entries())add('speaker_name',`/speakers/${i}/name`,speaker.name,{speakerId:speaker.id});
  return captureCorpus({version:1,episodeId:draft.episodeId,segments});
}
