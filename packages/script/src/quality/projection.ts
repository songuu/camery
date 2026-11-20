import {z} from 'zod';
import {Id,Text} from '../contracts.js';
import {QualityScopeSchema,QualitySubjectSchema,QualityCatalogInputSchema,QUALITY_MATERIAL_BYTES,QualityError} from './contracts.js';
import type {QualityCatalogInput,QualityNameSchema,QualityTextSchema} from './contracts.js';
import {captureQuality,freezeQuality} from './boundary.js';
const SpeakerMetadata=z.array(z.strictObject({id:Id,name:Text(120),principal:z.boolean()})).max(16384);
/** Literal scoring uses target story text. Full context, citations and writing guidance remain in the separate immutable review material. */
export function projectQualityCatalogInput(scopeInput:unknown,subjectInput:unknown,speakerMetadataInput?:unknown):QualityCatalogInput{
  const scope=captureQuality(QualityScopeSchema,scopeInput,'catalog scope',2048),subject=captureQuality(QualitySubjectSchema,subjectInput,'quality subject',QUALITY_MATERIAL_BYTES),texts:z.infer<typeof QualityTextSchema>[]=[],names:z.infer<typeof QualityNameSchema>[]=[];
  const add=(path:string,text:string,episodeNumber:number|null)=>texts.push({id:'text-'+(texts.length+1),path,text,episodeNumber});
  if(subject.kind==='outline'){
    if(speakerMetadataInput!==undefined)throw new QualityError('INVALID_INPUT','outline naming metadata','names');const output=subject.output,base='/output';
    for(const key of ['title','logline','promise','centralConflict'] as const)add(`${base}/adaptation/${key}`,output.adaptation[key],null);
    add(base+'/recipe/collision',output.recipe.collision,null);for(const [i,item]of output.recipe.signatureScenes.entries())add(`${base}/recipe/signatureScenes/${i}/description`,item.description,null);
    for(const [i,character]of output.characters.entries()){names.push({id:character.id,path:`${base}/characters/${i}/name`,name:character.name,principal:character.function!=='supporting',episodeNumber:null});for(const key of ['desire','obstacle','arc'] as const)add(`${base}/characters/${i}/${key}`,character[key],null);}
    for(const [i,beat]of output.beats.entries())for(const key of ['goal','conflict','turn','consequence'] as const)add(`${base}/beats/${i}/${key}`,beat[key],beat.episodeNumber);
    for(const [i,episode]of output.episodes.entries()){for(const key of ['title','synopsis'] as const)add(`${base}/episodes/${i}/${key}`,episode[key],episode.number);for(const key of ['openingHook','stakes','cliffhanger'] as const)add(`${base}/episodes/${i}/${key}/text`,episode[key].text,episode.number);}
    for(const [i,asset]of output.assets.entries()){for(const key of ['name','description','narrativeRole'] as const)add(`${base}/assets/${i}/${key}`,asset[key],null);for(const [j,state]of asset.propStates.entries())for(const key of ['before','after','reason'] as const)add(`${base}/assets/${i}/propStates/${j}/${key}`,state[key],output.beats.find(row=>row.id===state.beatId)?.episodeNumber??null);}
    for(const [i,unit]of output.plotUnits.entries())for(const key of ['pressure','escalation','reversal','release','nextCrisis'] as const)add(`${base}/plotUnits/${i}/${key}`,unit[key],null);
    for(const key of ['centralQuestion','protagonistGoal','opposition','repeatablePressure','escalation','endState'] as const)add(`${base}/seasonEngine/${key}`,output.seasonEngine[key],null);
  }else{
    const {draft,context}=subject,number=context.episode.number,metadata=captureQuality(SpeakerMetadata,speakerMetadataInput,'actual rendered name metadata',4194304),byId=new Map(metadata.map(row=>[row.id,row])),participants=new Set(draft.scenes.flatMap(scene=>[...scene.characterIds,...scene.beats.flatMap(beat=>beat.lines.map(line=>line.speakerId))]));
    if(byId.size!==metadata.length||metadata.length!==participants.size||metadata.some(row=>!participants.has(row.id)))throw new QualityError('INVALID_REFERENCE','complete scene character names','names');
    for(const [i,character]of context.characters.entries())if(participants.has(character.id)){const actual=byId.get(character.id);if(!actual||actual.name!==character.name)throw new QualityError('CONFLICT','rendered name binding','names');names.push({id:character.id,path:`/context/characters/${i}/name`,name:character.name,principal:actual.principal,episodeNumber:number});}
    if(names.length!==participants.size)throw new QualityError('INVALID_REFERENCE','actual screenplay participants','names');
    // Principal roles are supplied only by the trusted native reader, never inferred from free-form role prose.
    add('/draft/title',draft.title,number);
    for(const [i,scene]of draft.scenes.entries()){for(const key of ['title','startState','endState'] as const)add(`/draft/scenes/${i}/${key}`,scene[key],number);for(const [j,beat]of scene.beats.entries()){add(`/draft/scenes/${i}/beats/${j}/summary`,beat.summary,number);for(const [k,line]of beat.lines.entries())for(const key of ['text','delivery'] as const)add(`/draft/scenes/${i}/beats/${j}/lines/${k}/${key}`,line[key],number);}}
  }
  return freezeQuality(captureQuality(QualityCatalogInputSchema,{scope,texts,names},'quality catalog projection',QUALITY_MATERIAL_BYTES));
}
