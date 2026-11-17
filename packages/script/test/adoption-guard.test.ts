import {expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {DevelopmentError} from '../src/contracts.js';
import type {PostgresDevelopmentStore} from '../src/node/store.js';
import {createDevelopmentSourceGuard} from '../src/node/adoption-source.js';
import {workflowFixture} from './workflow-support.js';
const source={tenantId:'tenant',projectId:'project',runId:'source',runDigest:'a'.repeat(64),briefDigest:'b'.repeat(64),foundationReviewDigest:'c'.repeat(64),episodesReviewDigest:'d'.repeat(64)};
// Opaque connection token for adapter delegation only; reviewed-source SQL is tested separately against PostgreSQL.
const client=Object.create(null) as PoolClient;
it('captures immutable source references and the trusted reader before asynchronous adoption',async()=>{
  const read=vi.fn<PostgresDevelopmentStore['readForAdoption']>(async()=>workflowFixture().progress);const store={readForAdoption:read};const command={...source};const guard=createDevelopmentSourceGuard(store,command);command.runId='changed';store.readForAdoption=vi.fn(async()=>{throw new Error('substituted reader');});await guard(client);expect(read).toHaveBeenCalledWith(client,source);
});
it.each([['CONFLICT','ADOPTION_SOURCE_CHANGED'],['INCOMPLETE','ADOPTION_SOURCE_UNREVIEWED'],['NOT_FOUND','ADOPTION_SOURCE_MISSING']] as const)('maps %s to a safe explicit source refusal',async(code,expected)=>{
  const readForAdoption=vi.fn(async()=>{throw new DevelopmentError(code,'private source detail');});await expect(createDevelopmentSourceGuard({readForAdoption},source)(client)).rejects.toMatchObject({code:expected});
});
it.each([new DevelopmentError('STORAGE_FAILED','private DSN'),new DevelopmentError('INVALID_EVIDENCE','private output'),new Error('private driver token')])('keeps storage/integrity failures outside historical-refusal recovery',async failure=>{
  const guard=createDevelopmentSourceGuard({readForAdoption:async()=>{throw failure;}},source);await expect(guard(client)).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_UNAVAILABLE'});await expect(guard(client)).rejects.not.toThrow('private');
});
it('refuses malformed and accessor source input before resolving the reader',()=>{
  const readForAdoption=vi.fn();let invoked=false;const bad=Object.defineProperty({...source},'runDigest',{enumerable:true,get(){invoked=true;return 'a'.repeat(64);}});expect(()=>createDevelopmentSourceGuard({readForAdoption},bad)).toThrow('INVALID_INPUT');expect(invoked).toBe(false);expect(readForAdoption).not.toHaveBeenCalled();
});
