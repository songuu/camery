import type {DevelopmentExecution} from '../src/node/contracts.js';
import {createDefaultQualityPolicy} from '../src/quality/catalog.js';
import {readQualitySource} from '../src/quality/node/source.js';
import {qualityCycleMaterial,qualityInitialState,qualityReviewers,qualityRunRequest} from '../src/quality/node/state.js';
import type {QualityRun,StoredQualityCycle} from '../src/quality/node/state.js';
import {qualityDigest} from '../src/quality/node/data.js';
import {qualitySourceFixture} from './quality-source-support.js';

export const nodeQualityPhases=['story','continuity','production'] as const;
export function nodeQualityExecution():DevelopmentExecution{return {connectionId:'review',modeDigest:'f'.repeat(64),modelIdentity:'fixture/independent-review',evidence:'synthetic_replay',modelTier:'balanced',currency:'CNY',reservation:{tokens:100,costMicros:5},limits:{steps:6,tokens:600,costMicros:30}};}
export function rehashNodeQuality<T extends {digest:string}>(record:T):T{const {digest:_digest,...body}=record;record.digest=qualityDigest(body);return record;}
async function baseline(){
  const f=await qualitySourceFixture(),source=await readQualitySource(f.client,f.selection,f.readers,f.host),key={...source.scope,runId:'quality-node-state'},policy=createDefaultQualityPolicy(),execution=nodeQualityExecution(),reviewers=qualityReviewers({story:execution,continuity:execution,production:execution}),material=qualityCycleMaterial(key,source,policy),initialState=qualityInitialState(key,reviewers,material);
  const body={version:1 as const,key,policy,reviewers,sourceSelection:source.selection,initialSourceDigest:source.digest,initialPreparationDigest:material.preparation.digest,initialState,authorId:f.host.actor.id,createdAt:f.host.at,requestDigest:''};body.requestDigest=qualityDigest(qualityRunRequest(body));
  const run:QualityRun={...body,digest:qualityDigest(body)},cycleBody={version:1 as const,key,number:1 as const,runDigest:run.digest,sourceDigest:source.digest,preparationDigest:material.preparation.digest,manifests:material.manifests,actorId:run.authorId,at:run.createdAt},cycle:StoredQualityCycle={...cycleBody,digest:qualityDigest(cycleBody)};
  return {source,key,policy,reviewers,material,run,cycle};
}
let cached:ReturnType<typeof baseline>|undefined;
/** Actual pure Outline/model/source protocol; mutable run/cycle copies belong to each test. No PostgreSQL authority is established. */
export async function qualityNodeStateFixture(){const f=await(cached??=baseline());return {...f,key:{...f.key},policy:structuredClone(f.policy),run:structuredClone(f.run),cycle:structuredClone(f.cycle)};}
