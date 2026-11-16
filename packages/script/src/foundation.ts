import { DevelopmentError,FOUNDATION_BYTES,FoundationOutputSchema } from './contracts.js';
import type { FoundationOutput } from './contracts.js';
import { copy,freeze,parse } from './data.js';

function identities(values:readonly {id:string}[],operation:string):Set<string> {
  const ids=new Set(values.map(value=>value.id));
  if(ids.size!==values.length)throw new DevelopmentError('INVALID_REFERENCE',operation);
  return ids;
}
function references(values:readonly string[],available:ReadonlySet<string>,operation:string):void {
  if(new Set(values).size!==values.length||values.some(value=>!available.has(value)))throw new DevelopmentError('INVALID_REFERENCE',operation);
}
/** Validate one complete proposal without merging same names or treating invented story data as source evidence. */
export function validateFoundation(input:unknown):FoundationOutput {
  const output=parse(FoundationOutputSchema,copy(input,FOUNDATION_BYTES),'foundation output');
  const characters=identities(output.characters,'foundation character identities');
  const rules=identities(output.world.rules,'foundation rule identities');
  identities(output.relationships,'foundation relationship identities');
  identities(output.openQuestions,'foundation question identities');
  references(output.mainline.characterIds,characters,'foundation mainline characters');
  references(output.mainline.ruleIds,rules,'foundation mainline rules');
  for(const relationship of output.relationships){
    if(relationship.from===relationship.to||!characters.has(relationship.from)||!characters.has(relationship.to))throw new DevelopmentError('INVALID_REFERENCE','foundation relationship characters');
  }
  // Ensemble casts may have several leads; at least one must actually drive this proposed mainline.
  if(!output.characters.some(character=>character.function==='protagonist'&&output.mainline.characterIds.includes(character.id)))throw new DevelopmentError('INVALID_REFERENCE','foundation mainline protagonist');
  return freeze(output);
}
