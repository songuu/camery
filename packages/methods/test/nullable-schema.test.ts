import { describe,expect,it } from 'vitest';
import { chapterPack,MethodRegistry,outputValidator,prepareStructuredGenerationRequest } from '../src/index.js';
import type { MethodPack,OutputContract } from '../src/index.js';

const nullable=():OutputContract=>({type:['string','null'],minLength:2,maxLength:4});
const object=(field:OutputContract):OutputContract=>({type:'object',properties:{characterId:field},required:['characterId'],additionalProperties:false});

describe('bounded nullable string method schemas',()=>{
  it('accepts explicit null while preserving the non-null string constraints',()=>{
    const validate=outputValidator(nullable());
    for(const value of [null,'ab','abcd'])expect(validate.safeParse(value).success).toBe(true);
    for(const value of ['', 'a','abcde',0,false,{},[]])expect(validate.safeParse(value).success).toBe(false);
  });
  it('preserves required fields and nested array/object checks',()=>{
    const validate=outputValidator({type:'array',items:object(nullable()),minItems:1,maxItems:2});
    expect(validate.safeParse([{characterId:null},{characterId:'hero'}]).success).toBe(true);
    for(const value of [[],[{}],[{characterId:undefined}],[{characterId:4}],[{characterId:null,unknown:true}],[{characterId:'hero'},{characterId:null},{characterId:'hero'}]])expect(validate.safeParse(value).success).toBe(false);
  });
  it('intersects enum values with nullable type and range instead of replacing their constraints',()=>{
    const validate=outputValidator({...nullable(),enum:[null,'ab','a','abcde',2]});
    expect(validate.safeParse(null).success).toBe(true);expect(validate.safeParse('ab').success).toBe(true);
    for(const value of ['a','abcde','abcd',2])expect(validate.safeParse(value).success).toBe(false);
    const withoutNull=outputValidator({...nullable(),enum:['ab']});expect(withoutNull.safeParse(null).success).toBe(false);
    const nested=outputValidator(object({...nullable(),enum:[null,'ab']}));
    expect(nested.safeParse({characterId:null}).success).toBe(true);expect(nested.safeParse({characterId:'abcd'}).success).toBe(false);
  });
  it.each([
    ['null','string'],['string'],['null'],['string','string'],['string','null','string'],
    ['integer','null'],['number','null'],['object','null'],['array','null'],['boolean','null'],[],
  ].map(type=>({type})))('rejects unsupported or noncanonical type union %#',({type})=>{
    expect(()=>outputValidator({type})).toThrow('INVALID_SCHEMA');
  });
  it.each([
    {minimum:0},{maximum:10},{items:{type:'string'}},{minItems:0},{maxItems:1},
    {properties:{}},{required:[]},{additionalProperties:false},{minLength:4,maxLength:2},
    {nullable:true},{anyOf:[{type:'string'},{type:'null'}]},
  ])('rejects unrelated or contradictory nullable string keywords %#',keywords=>{
    expect(()=>outputValidator({...nullable(),...keywords})).toThrow('INVALID_SCHEMA');
  });
  it('keeps plain string and explicit-null schemas unchanged',()=>{
    const string=outputValidator({type:'string',minLength:2,maxLength:4});
    expect(string.safeParse(null).success).toBe(false);expect(string.safeParse('hero').success).toBe(true);
    const nil=outputValidator({type:'null'});expect(nil.safeParse(null).success).toBe(true);expect(nil.safeParse('null').success).toBe(false);
    expect(new MethodRegistry().register(chapterPack)).toEqual({id:'chapter-segmentation',version:'1.0.0',digest:'44f4c043900f43f0896497ade9cf4e8ba0784fcd6f3b6e7d6ad12a6deb9b29f0'});
  });
  it('registers and emits the standard nullable type without normalization or lossy conversion',()=>{
    const pack:MethodPack={...chapterPack,manifest:{...chapterPack.manifest,id:'nullable.fixture',tool:'method.generate',modelTier:'balanced',outputSchema:object(nullable())},rules:[],examples:[],cards:[],evals:[]};
    const registry=new MethodRegistry();const pin=registry.register(pack);const resolved=registry.resolve(pin);
    expect(resolved.manifest.outputSchema).toEqual(pack.manifest.outputSchema);
    const request=prepareStructuredGenerationRequest(pack,{note:'only source data'});
    expect(request.outputSchema.schema).toEqual(pack.manifest.outputSchema);
    expect(request.validate({characterId:null})).toBe(true);expect(request.validate({characterId:'hero'})).toBe(true);
    expect(request.validate({characterId:'x'})).toBe(false);expect(request.validate({})).toBe(false);
  });
});
