import { OutlineError } from './contracts.js';
import type { OutlineContext } from './contracts.js';

/** Shared semantic checks after schema capture; brief creation does not invent a source citation. */
export function assertOutlineSelection(context:Pick<OutlineContext,'episodeCount'|'paidEpisodeNumbers'|'mainGenre'|'auxiliaryGenres'>):void{
  for(const field of ['paidEpisodeNumbers','auxiliaryGenres'] as const){
    if(new Set<string|number>(context[field]).size!==context[field].length)throw new OutlineError('INVALID_REFERENCE','selection check',field);
  }
  if(context.auxiliaryGenres.includes(context.mainGenre))throw new OutlineError('INVALID_REFERENCE','selection check','auxiliaryGenres');
  for(const [index,number] of context.paidEpisodeNumbers.entries())if(number>context.episodeCount)throw new OutlineError('INVALID_REFERENCE','selection check',`paidEpisodeNumbers.${index}`);
}
