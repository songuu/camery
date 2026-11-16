import { DevelopmentError,EpisodeOutputSchema,EPISODE_BYTES } from './contracts.js';
import type { DevelopmentBrief,EpisodeOutput,FoundationOutput } from './contracts.js';
import { validateBrief } from './brief.js';
import { validateFoundation } from './foundation.js';
import { copy,freeze,parse } from './data.js';

/** Validate the complete requested season; never sort, truncate or invent missing episodes or upstream identities. */
export function validateEpisodes(brief:DevelopmentBrief,foundation:FoundationOutput,input:unknown):EpisodeOutput {
  const snapshot=copy(input,EPISODE_BYTES);
  const source=validateBrief(brief);const upstream=validateFoundation(foundation);
  const output=parse(EpisodeOutputSchema,snapshot,'episodes');
  if(output.episodes.length!==source.episodeCount)throw new DevelopmentError('INVALID_INPUT','episode count');
  const characters=new Set(upstream.characters.map(character=>character.id));
  const rules=new Set(upstream.world.rules.map(rule=>rule.id));
  const protagonists=new Set(upstream.characters.filter(character=>character.function==='protagonist').map(character=>character.id));
  let protagonistAppears=false;
  for(const [index,episode] of output.episodes.entries()){
    if(episode.number!==index+1)throw new DevelopmentError('INVALID_INPUT','episode order');
    if(new Set(episode.characterIds).size!==episode.characterIds.length||episode.characterIds.some(id=>!characters.has(id)))
      throw new DevelopmentError('INVALID_REFERENCE','episode characters');
    if(new Set(episode.ruleIds).size!==episode.ruleIds.length||episode.ruleIds.some(id=>!rules.has(id)))
      throw new DevelopmentError('INVALID_REFERENCE','episode world rules');
    protagonistAppears ||= episode.characterIds.some(id=>protagonists.has(id));
  }
  // This is only the minimum referential gate; protagonist presence does not establish narrative continuity or quality.
  if(!protagonistAppears)throw new DevelopmentError('INVALID_INPUT','season protagonist');
  return freeze(output);
}
