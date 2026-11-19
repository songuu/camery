import {captureScreenplay,freezeScreenplay} from './boundary.js';
import {SCREENPLAY_OUTPUT_BYTES,ScreenplayLineBookSchema,ScreenplayError} from './contracts.js';
import type {ScreenplayLineBook} from './contracts.js';
import {inspectScreenplayDraft} from './context.js';

/** Preserve authored text and delivery; character IDs, rather than potentially equal names, own each group. */
export function createScreenplayLineBook(contextInput:unknown,draftInput:unknown):ScreenplayLineBook{
  const {context,draft,issues}=inspectScreenplayDraft(contextInput,draftInput),error=issues.find(row=>row.severity==='error');
  if(error)throw new ScreenplayError('INVALID_REFERENCE','screenplay line book',error.path);
  const characters=new Map(context.characters.map(row=>[row.id,row])),groups=new Map<string,ScreenplayLineBook['speakers'][number]>(),order:string[]=[];let sequence=0;
  for(const scene of draft.scenes)for(const beat of scene.beats)for(const line of beat.lines){
    let group=groups.get(line.speakerId);
    if(!group){
      const character=characters.get(line.speakerId)!;
      group={character:{id:character.id,version:character.version},name:character.name,lines:[]};groups.set(character.id,group);
    }
    // Inspection caps the complete draft at 8192 lines, so the global sequence remains a safe integer.
    group.lines.push({id:line.id,sceneId:scene.id,beatId:beat.id,sequence:++sequence,kind:line.kind,text:line.text,delivery:line.delivery,lipSync:line.kind==='on_screen'?'eligible_if_visible':'never'});order.push(line.id);
  }
  return freezeScreenplay(captureScreenplay(ScreenplayLineBookSchema,{version:1,episodeId:draft.episodeId,title:draft.title,lineCount:sequence,order,speakers:[...groups.values()]},'screenplay line book',SCREENPLAY_OUTPUT_BYTES));
}
