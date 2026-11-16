import { describe,expect,it } from 'vitest';
import { DevelopmentError,FOUNDATION_BYTES } from '../src/contracts.js';
import type { FoundationOutput } from '../src/contracts.js';
import { validateFoundation } from '../src/foundation.js';
import { foundationFixture } from './foundation-fixture.js';

function invalid(change:(value:FoundationOutput)=>void,code:DevelopmentError['code']) {
  const input=foundationFixture();change(input);expect(()=>validateFoundation(input)).toThrowError(expect.objectContaining({code}));
}
describe('original world, characters and mainline foundation',()=>{
  it('preserves complete story data, same-name identities and caller order in a frozen independent snapshot',()=>{
    const input=foundationFixture();input.title='  潮钟停在退潮前  ';input.characters.reverse();input.mainline.characterIds.reverse();
    const output=validateFoundation(input);expect(output).toEqual(input);expect(output).not.toBe(input);
    expect(output.characters.filter(character=>character.name==='林舟').map(character=>character.id)).toEqual(['older-lin','lin']);
    input.characters[0]!.name='改名';expect(output.characters[0]!.name).toBe('梅笙');
    expect(Object.isFrozen(output.world.rules[0])).toBe(true);expect(Object.isFrozen(output.characters)).toBe(true);expect(Object.isFrozen(output.mainline.characterIds)).toBe(true);
    expect(()=>{output.characters[0]!.name='修改';}).toThrow(TypeError);
  });
  it('permits independent ID namespaces and natural stories with no invented rules, relationships or unresolved questions',()=>{
    const input=foundationFixture();input.world.rules[0]!.id='lin';input.mainline.ruleIds=['lin','clock'];input.relationships[0]!.id='lin';input.openQuestions[0]!.id='lin';
    expect(validateFoundation(input)).toEqual(input);
    input.world.rules=[];input.mainline.ruleIds=[];input.relationships=[];input.openQuestions=[];input.characters=[input.characters[0]!];input.mainline.characterIds=['lin'];
    expect(validateFoundation(input)).toEqual(input);
  });
  it.each(['characters','rules','relationships','openQuestions'] as const)('rejects duplicate %s IDs',section=>{
    invalid(value=>{if(section==='rules')value.world.rules.push({...value.world.rules[0]!});else value[section].push({...value[section][0]!} as never);},'INVALID_REFERENCE');
  });
  it.each(['characterIds','ruleIds'] as const)('rejects duplicate and missing mainline %s',field=>{
    invalid(value=>{value.mainline[field].push(value.mainline[field][0]!);},'INVALID_REFERENCE');
    invalid(value=>{value.mainline[field]=['missing'];},'INVALID_REFERENCE');
  });
  it.each(['from','to'] as const)('rejects missing relationship %s',field=>{
    invalid(value=>{value.relationships[0]![field]='missing';},'INVALID_REFERENCE');
  });
  it('rejects self relationships, a missing protagonist and a mainline detached from all protagonists',()=>{
    invalid(value=>{value.relationships[0]!.to=value.relationships[0]!.from;},'INVALID_REFERENCE');
    invalid(value=>{value.characters.forEach(character=>{character.function='supporting';});},'INVALID_REFERENCE');
    invalid(value=>{value.mainline.characterIds=['older-lin','mei'];},'INVALID_REFERENCE');
    const ensemble=foundationFixture();ensemble.characters[1]!.function='protagonist';ensemble.mainline.characterIds=['older-lin'];expect(()=>validateFoundation(ensemble)).not.toThrow();
  });
  it.each([
    null,undefined,{},[],{...foundationFixture(),approved:true},
    {...foundationFixture(),world:{...foundationFixture().world,authorization:'human'}},
    {...foundationFixture(),title:' '},{...foundationFixture(),title:'broken\ud800'},
    {...foundationFixture(),title:'bad\0title'},
    {...foundationFixture(),characters:[]},
    {...foundationFixture(),characters:[{...foundationFixture().characters[0]!,id:'角色'}]},
    {...foundationFixture(),mainline:{...foundationFixture().mainline,characterIds:[]}},
    {...foundationFixture(),openQuestions:[{id:'q',text:'x'.repeat(501)}]},
  ])('rejects unknown fields, malformed structure and invalid text %#',value=>{
    expect(()=>validateFoundation(value)).toThrowError(expect.objectContaining({code:'INVALID_INPUT'}));
  });
  it('enforces the total UTF-8 JSON budget even when every field and list count is valid',()=>{
    const input=foundationFixture();input.characters=Array.from({length:32},(_,index)=>({...input.characters[0]!,id:`character-${index}`,arc:'潮'.repeat(1000)}));
    input.mainline.characterIds=['character-0'];input.relationships=[];
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(FOUNDATION_BYTES);
    expect(()=>validateFoundation(input)).toThrowError(expect.objectContaining({code:'INPUT_LIMIT'}));
    const oversized='x'.repeat(FOUNDATION_BYTES+1);expect(()=>validateFoundation(oversized)).toThrowError(expect.objectContaining({code:'INPUT_LIMIT'}));
  });
  it('does not execute source getters or preserve arbitrary Proxy exceptions',()=>{
    let called=false;const getter=Object.defineProperty(foundationFixture(),'title',{enumerable:true,get(){called=true;throw new Error('private');}});
    expect(()=>validateFoundation(getter)).toThrowError(expect.objectContaining({code:'INVALID_INPUT'}));expect(called).toBe(false);
    const proxy=new Proxy({},{ownKeys(){throw new DevelopmentError('CONFLICT','private');}});
    expect(()=>validateFoundation(proxy)).toThrowError(expect.objectContaining({code:'INVALID_INPUT'}));
    try{validateFoundation(proxy);}catch(error){expect(String(error)).not.toContain('private');}
  });
});
