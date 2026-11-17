import {expect,it} from 'vitest';
import {developmentRunDigest,validateDevelopmentRun,executionForDevelopment,executionForEpisodes,episodeExecutionFromFull,developmentCandidateOwner,developmentWorkflowVersion} from '../src/node/contracts.js';
import {workflowFixture} from './workflow-support.js';
import type {DevelopmentRun} from '../src/node/contracts.js';
import {hash} from '../src/data.js';
it('retains the byte-compatible v1 run identity and distinguishes a one-stage origin-bound v2 run',()=>{
  const f=workflowFixture();const old=hash({version:1,...f.key,brief:f.run.brief,methods:f.run.methods,execution:f.run.execution});expect(f.run.digest).toBe(old);expect(developmentWorkflowVersion(f.run)).toBe(1);
  const origin={version:1 as const,stage:'episodes' as const,sourceRunId:f.run.runId,sourceRunDigest:f.run.digest,actorId:'actor',foundation:{runId:f.run.runId,runDigest:f.run.digest,candidateDigest:'b'.repeat(64),reviewDigest:'c'.repeat(64),execution:f.run.execution}};
  const fields={...f.run,runId:'redo',execution:episodeExecutionFromFull(f.run.execution),origin};const run={...fields,digest:developmentRunDigest(fields)};
  expect(run.digest).not.toBe(old);expect(validateDevelopmentRun({...f.key,runId:'redo'},run)).toEqual(run);expect(developmentWorkflowVersion(run)).toBe(2);
  expect(developmentCandidateOwner(run,'foundation')).toEqual({key:f.key,execution:f.run.execution});expect(developmentCandidateOwner(run,'episodes')).toEqual({key:{...f.key,runId:'redo'},execution:run.execution});
});
it('derives exactly one trusted reservation and rejects a malformed or self-referencing branch',()=>{
  const f=workflowFixture();const single=episodeExecutionFromFull(f.run.execution);expect(single.limits).toEqual({steps:1,tokens:100,costMicros:0});expect(executionForEpisodes(single)).toEqual(single);expect(()=>executionForDevelopment(single)).toThrow();
  const origin={version:1 as const,stage:'episodes' as const,sourceRunId:f.run.runId,sourceRunDigest:f.run.digest,actorId:'actor',foundation:null};expect(()=>developmentRunDigest({...f.run,origin} as unknown as DevelopmentRun)).toThrow();
  const self={version:1 as const,stage:'foundation' as const,sourceRunId:f.run.runId,sourceRunDigest:f.run.digest,actorId:'actor',foundation:null};const fields={...f.run,origin:self};expect(()=>validateDevelopmentRun(f.key,{...fields,digest:developmentRunDigest(fields)})).toThrow();
});
