import {qualityStoreFixture} from './quality-store-support.js';
import {qualityFreeFindings} from '../src/quality/node/preparation.js';
import type {QualityPreparation} from '../src/quality/node/preparation.js';
import type {QualitySourceSelection} from '../src/quality/node/source.js';
import {QualitySourceSelectionSchema} from '../src/quality/node/source.js';

export type RecoveryFixture=Awaited<ReturnType<typeof qualityStoreFixture>>;
export type RecoveryKind='started'|'staged'|'ready'|'waived'|'resolved'|'revised'|'reviewed';
export const publicationPrefix='SELECT r.tenant_id,r.project_id,r.run_id,r.digest,';
export const runPrefix='SELECT tenant_id,project_id,run_id,initial_cycle';
export const controlPrefix='SELECT tenant_id,project_id,run_id,sequence,digest,record';
export const qualityLock='camery_quality:run';
const cached=new Map<RecoveryKind,Promise<{data:RecoveryFixture['data'];outline:RecoveryFixture['outline']['data'];selection:QualitySourceSelection|null}>>();

/** Captured valid store-produced rows only. Snapshot injection below models driver observations, never PostgreSQL isolation or locks. */
async function snapshot(kind:RecoveryKind){
  let value=cached.get(kind);if(!value){value=(async()=>{const f=await qualityStoreFixture();await f.store.start(f.command,f.host);let selection:QualitySourceSelection|null=null;
    if(kind==='staged'){await f.saveModel();await f.store.completeStage(f.key,1,'story',f.host);}
    if(['ready','resolved','revised','reviewed'].includes(kind)){const progress=await f.stages();if(kind==='reviewed')await f.waiveFree();if(['resolved','revised','reviewed'].includes(kind))await f.store.resolveCycle(f.key,1,progress.state.digest,f.host);}
    if(kind==='waived'){const decision=freeDecision(f);await f.store.waive(f.key,{...decision,findings:decision.findings.slice(0,1)},f.host);}
    if(kind==='revised'){selection=QualitySourceSelectionSchema.parse(await f.reviseOutline());const progress=await f.store.read(f.key,f.host);await f.store.revise(f.key,{source:selection,expectedStateDigest:progress.state.digest},f.host);}
    return {data:structuredClone(f.data),outline:structuredClone(f.outline.data),selection};})();cached.set(kind,value);}return value;
}
export async function recoveryFixture(kind:RecoveryKind='started'){const f=await qualityStoreFixture(),saved=await snapshot(kind);Object.assign(f.data,structuredClone(saved.data));Object.assign(f.outline.data,structuredClone(saved.outline));f.query.mockClear();f.connect.mockClear();f.release.mockClear();f.exchange.mockClear();return f;}
export async function recoverySnapshot(kind:RecoveryKind){const saved=await snapshot(kind);return {data:structuredClone(saved.data),outline:structuredClone(saved.outline),selection:saved.selection?structuredClone(saved.selection):null};}
export function publishRows(f:RecoveryFixture,saved:Awaited<ReturnType<typeof recoverySnapshot>>){Object.assign(f.data,structuredClone(saved.data));Object.assign(f.outline.data,structuredClone(saved.outline));}
export function freeDecision(f:RecoveryFixture){const preparation=f.data.cycles[0]!['preparation'] as QualityPreparation;return {cycle:1 as const,target:{kind:'free' as const},resultDigest:preparation.digest,findings:qualityFreeFindings(preparation).filter(row=>row.waivable).map(row=>({id:row.id,reason:'明确的人类保留理由，协议夹具不证明真人质量。'}))};}
export function beforeQualityLock(f:RecoveryFixture,effect:()=>void){const original=f.query.getMockImplementation()!;let fired=false;f.query.mockImplementation(async(sql,values=[])=>{const result=await original(sql,values);if(!fired&&sql.startsWith('SELECT pg_catalog.pg_advisory_xact_lock')&&typeof values[0]==='string'&&values[0].includes(qualityLock)){fired=true;effect();}return result;});return ()=>fired;}
