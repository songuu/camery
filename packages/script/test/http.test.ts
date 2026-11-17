import {expect,it,vi} from 'vitest';
import {DevelopmentBriefWriteSchema,DevelopmentStartSchema,DevelopmentFoundationConfirmSchema,DevelopmentRunListSchema,boundedDevelopmentSchema} from '../src/http.js';
import {episodeFixture} from './episode-fixture.js';
it('accepts only public brief/start fields and exact stage output contracts',()=>{
  const f=episodeFixture();const {briefId,idea,episodeCount,targetSeconds}=f.brief;const brief={briefId,expectedRevision:0,idea,episodeCount,targetSeconds};
  expect(DevelopmentBriefWriteSchema.parse(brief)).toEqual(brief);
  for(const field of ['tenantId','actorId','execution','methods','authorize'])expect(DevelopmentBriefWriteSchema.safeParse({...brief,[field]:'injected'}).success).toBe(false);
  const start={runId:'r',briefId,expectedRevision:1,expectedBriefDigest:f.brief.digest};expect(DevelopmentStartSchema.parse(start)).toEqual(start);
  expect(DevelopmentStartSchema.safeParse({...start,modelIdentity:'client'}).success).toBe(false);
  expect(DevelopmentFoundationConfirmSchema.safeParse({candidateDigest:'a'.repeat(64),output:f.output}).success).toBe(false);
});
it('bounds arbitrary transport data before schema parsing and never invokes getters',()=>{
  const getter=vi.fn(()=>{throw new Error('private');});const data={};Object.defineProperty(data,'items',{enumerable:true,get:getter});
  expect(boundedDevelopmentSchema(DevelopmentRunListSchema).safeParse(data).success).toBe(false);expect(getter).not.toHaveBeenCalled();
  expect(boundedDevelopmentSchema(DevelopmentRunListSchema).safeParse({items:[],nextCursor:null}).success).toBe(true);
  expect(boundedDevelopmentSchema(DevelopmentRunListSchema).safeParse({items:[],nextCursor:'x'.repeat(524289)}).success).toBe(false);
});
