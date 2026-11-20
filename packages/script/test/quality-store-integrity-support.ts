import {digest} from '@camery/methods';
import {qualityStoreFixture} from './quality-store-support.js';
import type {QualityMemoryRow} from './quality-store-memory.js';
import {qualityDigest} from '../src/quality/node/data.js';
import {qualityCycleMaterial,qualityInitialState} from '../src/quality/node/state.js';
import type {QualityRun,StoredQualityCycle,QualityControl,QualityStageCompletion} from '../src/quality/node/state.js';
import type {QualitySource} from '../src/quality/node/source.js';
import {completeQualityStage} from '../src/quality/state.js';
import type {QualityReview,QualityStageProof} from '../src/quality/state.js';

type Level='started'|'batch'|'staged'|'waived'|'reviewed';
type Fixture=Awaited<ReturnType<typeof qualityStoreFixture>>;
const templates=new Map<Level,Promise<Fixture['data']>>();
async function template(level:Level){const f=await qualityStoreFixture();await f.store.start(f.command,f.host);if(level==='batch')await f.saveModel(undefined,true);if(level==='staged'||level==='reviewed')await f.stages();if(level==='waived'||level==='reviewed')await f.waiveFree();if(level==='reviewed'){const progress=await f.store.read(f.key,f.host);await f.store.resolveCycle(f.key,1,progress.state.digest,f.host);}return structuredClone(f.data);}
/** Seeded rows came from real pure/store/Methods constructors; every test gets isolated rows and source/shared protocols, never actual DB authority. */
export async function qualityIntegrityFixture(level:Level='started'){let seed=templates.get(level);if(!seed){seed=template(level);templates.set(level,seed);}const data=await seed,f=await qualityStoreFixture();Object.assign(f.data,structuredClone(data));return f;}
export function integrityRecord<T>(row:QualityMemoryRow):T{return row['record'] as T;}
export function integrityRehash<T extends {digest:string}>(record:T):T{const {digest:_digest,...body}=record;return {...record,digest:qualityDigest(body)};}
export function integrityReplace<T extends {digest:string}>(row:QualityMemoryRow,record:T){row['record']=record;row['digest']=record.digest;}
/** Re-derive every own digest, preparation and manifest, leaving the actual Outline repository deliberately unchanged. */
export function forgeIntegritySource(f:Fixture){
  const cycleRow=f.data.cycles[0]!,runRow=f.data.runs[0]!,old=integrityRecord<QualityRun>(runRow),source=structuredClone(cycleRow['source']) as QualitySource;if(source.subject.kind!=='outline')throw new Error('Integrity source fixture expects Outline');source.subject.output.adaptation.logline+=' 未写入实际来源的伪造文本。';const forged=integrityRehash(source),material=qualityCycleMaterial(f.key,forged,old.policy),initialState=qualityInitialState(f.key,old.reviewers,material),run=integrityRehash({...old,initialSourceDigest:forged.digest,initialPreparationDigest:material.preparation.digest,initialState});
  integrityReplace(runRow,run);runRow['request_digest']=run.requestDigest;const cycle=integrityRehash({...integrityRecord<StoredQualityCycle>(cycleRow),runDigest:run.digest,sourceDigest:forged.digest,preparationDigest:material.preparation.digest,manifests:material.manifests});integrityReplace(cycleRow,cycle);cycleRow['source']=forged;cycleRow['preparation']=material.preparation;cycleRow['source_digest']=forged.digest;cycleRow['preparation_digest']=material.preparation.digest;
}
/** Pure proof/control rebuilding cannot manufacture the actual batch receipts used by the repository's stage replay. */
export function forgeIntegrityStage(f:Fixture,change:(proof:QualityStageProof)=>void){
  const row=f.data.stages.find(row=>row['phase']==='story')!,record=structuredClone(integrityRecord<QualityStageCompletion>(row));change(record.proof);const {digest:_digest,...proof}=record.proof;record.proof={...proof,digest:digest(proof)};integrityReplace(row,integrityRehash(record));let state=integrityRecord<QualityRun>(f.data.runs[0]!).initialState;
  for(const controlRow of f.data.controls){const control=integrityRecord<QualityControl>(controlRow),original=(control.state as QualityReview).events.at(-1);if(original?.kind!=='stage')throw new Error('Integrity stage template expects stage-only controls');const next=completeQualityStage(state,original.proof.phase==='story'?record.proof:original.proof,state.digest),event=next.events.at(-1)!;integrityReplace(controlRow,integrityRehash({...control,state:next,requestDigest:qualityDigest({previous:state.digest,event,actorId:control.actorId})}));state=next;}
}
