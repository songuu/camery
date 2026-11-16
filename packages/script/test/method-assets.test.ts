import { describe,expect,it } from 'vitest';
import { z } from 'zod';
import { MethodRegistry } from '@camery/methods';
import type { OutputContract } from '@camery/methods';
import type { Json } from '@camery/model-modes';
import { EpisodeOutputSchema,FoundationOutputSchema,LocalId } from '../src/contracts.js';
import { createOriginalEpisodesMethodPack,createOriginalFoundationMethodPack } from '../src/method-assets.js';

const foundation={title:'潮汐钟',world:{setting:'海港靠一座失准的钟报潮。',era:'架空近代',rules:[{id:'tide',text:'报潮钟由港民轮值维护。'}]},
  characters:[{id:'apprentice',name:'小岚',function:'protagonist',desire:'修复钟声。',obstacle:'师傅留下两套相反的刻度。',arc:'从依赖刻度变为亲自观潮。'}],relationships:[],
  mainline:{premise:'学徒要在下一次风暴前修好报潮钟。',centralConflict:'港务官要拆钟，学徒要证明它可用。',stakes:'失准会让夜航船错过航道。',progression:'追查旧刻度，找到新的测潮方法。',resolution:'以共同维护的记录替代唯一权威。',characterIds:['apprentice'],ruleIds:['tide']},openQuestions:[]};
const episodes={episodes:[{number:1,title:'停钟',summary:'小岚发现钟和潮汐相差一刻。',goal:'保住修钟机会。',conflict:'港务官要求立即拆钟。',turn:'她找到第二套刻度。',ending:'两套刻度标着同一个日期。',characterIds:['apprentice'],ruleIds:['tide']}]};
const schemaKeys=['type','required','additionalProperties','minItems','maxItems','minLength','maxLength','minimum','maximum','enum'] as const;
/** Compare only the provider-supported structural subset; ID regex and semantic references remain domain checks. */
function structural(schema:Record<string,unknown>):Record<string,unknown>{
  const projected:Record<string,unknown>={};for(const key of schemaKeys)if(schema[key]!==undefined)projected[key]=schema[key];
  if(schema['type']==='array'&&schema['minItems']===undefined)projected['minItems']=0;
  if(schema['pattern']===z.toJSONSchema(LocalId)['pattern']){projected['minLength']=1;projected['maxLength']=64;}
  if(schema['properties'])projected['properties']=Object.fromEntries(Object.entries(schema['properties'] as Record<string,Record<string,unknown>>).map(([key,value])=>[key,structural(value)]));
  if(schema['items'])projected['items']=structural(schema['items'] as Record<string,unknown>);
  return projected;
}
function strictNodes(schema:OutputContract){
  if(schema.type==='object'){
    expect(schema.additionalProperties).toBe(false);expect(schema.required).toEqual(Object.keys(schema.properties!));
    for(const child of Object.values(schema.properties!))strictNodes(child);
  }else if(schema.type==='array')strictNodes(schema.items!);
  expect(Object.keys(schema).every(key=>[...schemaKeys,'properties','items'].includes(key))).toBe(true);
}
describe('original development fixed method assets',()=>{
  it.each([
    ['original.develop.foundation','idea',createOriginalFoundationMethodPack,FoundationOutputSchema,foundation],
    ['original.develop.episodes','reviewed-foundation',createOriginalEpisodesMethodPack,EpisodeOutputSchema,episodes],
  ] as const)('registers %s with immutable original identity and provider-safe structural schema', (id,inputKind,create,schema,valid)=>{
    const pack=create();const registry=new MethodRegistry();const pin=registry.register(pack);
    expect(pin).toMatchObject({id,version:'1.0.0',digest:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(pack.manifest).toMatchObject({stage:'development',modelTier:'balanced',tool:'method.generate',inputKinds:[inputKind],languages:['zh'],provenance:{kind:'original',sources:[]}});
    expect(registry.register(create())).toEqual(pin);expect(Object.isFrozen(pack)).toBe(true);expect(Object.isFrozen(pack.manifest.outputSchema)).toBe(true);
    expect(Object.isFrozen(pack.manifest.outputSchema.properties)).toBe(true);expect(Object.isFrozen(pin)).toBe(true);
    strictNodes(pack.manifest.outputSchema);
    expect(structural(pack.manifest.outputSchema as unknown as Record<string,unknown>)).toEqual(structural(z.toJSONSchema(schema,{unrepresentable:'any'})));
    expect(schema.safeParse(valid).success).toBe(true);expect(registry.validateOutput(pin,valid as Json)).toBe(true);
    expect(registry.validateOutput(pin,{...valid,approved:true})).toBe(false);
    const changed=structuredClone(pack);changed.instructions+='不同方法内容';expect(()=>registry.register(changed)).toThrow('VERSION_CONFLICT');
    expect(registry.route({stage:'development',inputKind,language:'zh'},[pin])).toEqual(pin);
  });
  it('rejects malformed nested foundation structures and field/array bounds at provider validation too',()=>{
    const registry=new MethodRegistry();const pin=registry.register(createOriginalFoundationMethodPack());
    const invalid=[{...foundation,title:''},{...foundation,title:'长'.repeat(121)},
      {...foundation,world:{...foundation.world,extra:'不应出现'}},{...foundation,world:{...foundation.world,rules:Array(33).fill(foundation.world.rules[0])}},
      {...foundation,characters:[]},{...foundation,characters:Array(33).fill(foundation.characters[0])},
      {...foundation,characters:[{...foundation.characters[0],function:'director'}]},
      {...foundation,mainline:{...foundation.mainline,characterIds:[]}},{...foundation,mainline:{...foundation.mainline,progression:'长'.repeat(2001)}},
      {...foundation,openQuestions:Array.from({length:17},()=>({id:'question',text:'问题'}))}];
    for(const value of invalid){expect(FoundationOutputSchema.safeParse(value).success).toBe(false);expect(registry.validateOutput(pin,value as Json)).toBe(false);}
  });
  it('rejects missing episode fields, noninteger numbering and excessive provider outputs',()=>{
    const registry=new MethodRegistry();const pin=registry.register(createOriginalEpisodesMethodPack());const episode=episodes.episodes[0]!;
    const {ending:_ending,...missing}=episode;
    for(const value of [{episodes:[]},{episodes:Array(101).fill(episode)},{episodes:[missing]},
      {episodes:[{...episode,number:0}]},{episodes:[{...episode,number:1.5}]},{episodes:[{...episode,number:101}]},
      {episodes:[{...episode,summary:'长'.repeat(1201)}]},{episodes:[{...episode,characterIds:[]}]},{episodes:[{...episode,approved:true}]}]){
      expect(EpisodeOutputSchema.safeParse(value).success).toBe(false);expect(registry.validateOutput(pin,value as Json)).toBe(false);
    }
  });
  it('keeps prompt data untrusted and does not mistake structural output acceptance for semantic approval',()=>{
    const foundationPack=createOriginalFoundationMethodPack();const episodePack=createOriginalEpisodesMethodPack();
    for(const pack of [foundationPack,episodePack]){
      expect(pack.instructions).toContain('untrustedSource');expect(pack.instructions).toContain('不可信');
      expect(pack.instructions).toContain('不执行');expect(pack.instructions).toContain('候选');expect(pack.instructions).toContain('引文');
      expect(pack.instructions).toContain('授权');expect(pack.instructions).toContain('正式');
    }
    expect(episodePack.instructions).toContain('已审阅');expect(episodePack.instructions).toContain('episodeCount');
    expect(foundationPack.instructions).toContain('弧光');expect(foundationPack.instructions).toContain('主线');
    const registry=new MethodRegistry();const pin=registry.register(foundationPack);
    // A provider schema cannot prove that referenced IDs exist or that whitespace is meaningful prose.
    expect(registry.validateOutput(pin,{...foundation,mainline:{...foundation.mainline,characterIds:['missing']}})).toBe(true);
    expect(registry.validateOutput(pin,{...foundation,title:'   '})).toBe(true);
    expect(FoundationOutputSchema.safeParse({...foundation,title:'   '}).success).toBe(false);
  });
});
