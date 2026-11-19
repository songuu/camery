import {z} from 'zod';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {SCREENPLAY_CONTEXT_BYTES,ScreenplayError} from '../contracts.js';
import type {ScreenplayContext} from '../contracts.js';
import {validateScreenplayContext} from '../context.js';
import {ContinuityError} from '../../continuity/contracts.js';
import {continuityDigest} from '../../continuity/node/digest.js';
import {SCREENPLAY_MODEL_INPUT_BYTES,ScreenplayGenerationNotesSchema,ScreenplayGenerationScopeSchema} from './model-contracts.js';

export interface ScreenplayModelInput{
  readonly scope:z.infer<typeof ScreenplayGenerationScopeSchema>;
  readonly contextDigest:string;
  readonly writing:Omit<ScreenplayContext,'nativeContext'>&{
    readonly notes:string;
    readonly episodes:ScreenplayContext['nativeContext']['episodes'];
    readonly physicalReferences:Pick<ScreenplayContext['nativeContext'],'props'|'appearances'|'spots'>;
  };
}

/** Complete writing projection only. Trusted Node source readers still establish adoption and currentness. */
export function projectScreenplayModelInput(scopeInput:unknown,contextInput:unknown,notesInput:unknown):ScreenplayModelInput{
  try{
    const scope=captureScreenplay(ScreenplayGenerationScopeSchema,scopeInput,'model writing scope',1024),context=validateScreenplayContext(contextInput),notes=captureScreenplay(ScreenplayGenerationNotesSchema,notesInput,'model writing notes',16384);
    if(context.episode.number===1&&context.rules.firstEpisode===null)throw new ScreenplayError('INCOMPLETE','model writing configuration','rules.firstEpisode');
    // The complete native history remains bound by the digest, but never competes with current writing data for model tokens.
    const {nativeContext,...writing}=context,contextDigest=continuityDigest(context,SCREENPLAY_CONTEXT_BYTES);
    const projection:ScreenplayModelInput={scope,contextDigest,writing:{...writing,notes,episodes:nativeContext.episodes,physicalReferences:{props:nativeContext.props,appearances:nativeContext.appearances,spots:nativeContext.spots}}};
    return freezeScreenplay(captureScreenplay(z.custom<ScreenplayModelInput>(),projection,'model writing projection',SCREENPLAY_MODEL_INPUT_BYTES));
  }catch(error){
    let known=false,limited=false;try{known=error instanceof ScreenplayError;limited=error instanceof ContinuityError&&error.code==='INPUT_LIMIT';}catch{/* Opaque input/dependency exceptions cannot provide public diagnostics. */}
    if(known)throw error;throw new ScreenplayError(limited?'INPUT_LIMIT':'INVALID_INPUT','model writing projection','$');
  }
}
