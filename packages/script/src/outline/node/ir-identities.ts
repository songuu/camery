import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import {Hash,Id,Integer,LocalId} from '../../contracts.js';
import {capture,deepFreeze} from '../boundary.js';
import {OutlineError} from '../contracts.js';
import {OutlineIdentityPreparationSchema,OutlineFormalIdentitiesSchema,OutlineVersionKeySchema} from './formal-contracts.js';
import type {OutlineFormalIdentities} from './formal-contracts.js';
import {digestOutlineFormal,equalOutlineFormal} from './formal-data.js';
import {captureOutlineAdoptionProgress} from './formal-source.js';
import type {ReviewedOutlineProgress} from './formal-source.js';
import type {PostgresOutlineStore} from './store.js';
import {readIdentityEpisodeExtents} from '../../node/identity-extents.js';

const stable=OutlineVersionKeySchema.shape.projectId;
const projectKinds=['development_plan','episode','episode_plan','adaptation_plan','outline_episode_plan'] as const;
const sourceKinds=['outline_character','outline_beat','outline_asset','outline_plot_unit','outline_decision'] as const;
const newKinds=['adaptation_plan','outline_episode_plan',...sourceKinds];
const Kind=z.enum([...projectKinds,...sourceKinds]);type Kind=z.infer<typeof Kind>;
const RowSchema=z.strictObject({tenant_id:Id,project_id:Id,kind:Kind,owner_key:Id,owner_run_id:Id.nullable(),outline_owner_run_id:Id.nullable(),local_key:LocalId,ir_tenant_id:stable,ir_project_id:stable,stable_id:stable});
type Row=z.infer<typeof RowSchema>;
const ProofSchema=z.strictObject({tenant_id:Id,project_id:Id,run_id:Id,run_digest:Hash,review_digest:Hash,episode_count:Integer.min(1).max(100),ir_tenant_id:stable,ir_project_id:stable,registry_digest:Hash});
type Proof=z.infer<typeof ProofSchema>;
const fields='tenant_id,project_id,kind,owner_key,owner_run_id,outline_owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id';
const proofFields='tenant_id,project_id,run_id,run_digest,review_digest,episode_count,ir_tenant_id,ir_project_id,registry_digest';
const key=(kind:Kind,local:string)=>JSON.stringify([kind,local]);
function failed(operation:string):never{throw new OutlineError('STORAGE_FAILED',operation,'IR identities');}
const project=(kind:Kind)=>(projectKinds as readonly string[]).includes(kind);

/** Shared object metadata only. Source and ordinary-project authority still come from the trusted host and source transaction. */
export class PostgresOutlineIrIdentities{
  constructor(private readonly pool:Pool,private readonly source:Pick<PostgresOutlineStore,'readForAdoption'>,private readonly newId:()=>string){}
  async prepare(input:unknown):Promise<{identities:OutlineFormalIdentities;progress:ReviewedOutlineProgress}>{
    const command=deepFreeze(capture(OutlineIdentityPreparationSchema,input,'IR identity preparation',4096)),read=this.source.readForAdoption.bind(this.source),allocate=this.newId;
    if(typeof allocate!=='function')throw new OutlineError('INVALID_INPUT','IR identity allocator','allocator');
    let client:PoolClient;try{client=await this.pool.connect();}catch{return failed('IR identity connection');}
    let disconnected=false,destroy=false;const onError=()=>{disconnected=true;destroy=true;},connected=()=>{if(disconnected)failed('IR identity connection');};client.on('error',onError);
    try{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');connected();
      const progress=captureOutlineAdoptionProgress(command.source,await read(client,command.source));connected();
      const {run,review}=progress,scope=[run.tenantId,run.projectId];
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_script:ir-identities',...scope])]);connected();
      const bindings=new Map<string,Row>(),reserved=new Set([command.target.projectId]);
      const checked=(raw:unknown):Row=>{
        let row:Row;try{row=capture(RowSchema,raw,'stored IR identity',8192);}catch{return failed('stored IR identity');}
        if(row.tenant_id!==run.tenantId||row.project_id!==run.projectId)failed('stored IR identity scope');
        if(project(row.kind)?row.owner_key!=='project'||row.owner_run_id!==null||row.outline_owner_run_id!==null:row.owner_key!==run.runId||row.owner_run_id!==null||row.outline_owner_run_id!==run.runId)failed('stored IR identity owner');
        if(row.kind==='development_plan'||row.kind==='adaptation_plan'?row.local_key!=='plan':project(row.kind)&&!/^(?:[1-9]|[1-9][0-9]|100)$/.test(row.local_key))failed('stored IR identity slot');
        if(row.ir_tenant_id!==command.target.tenantId||row.ir_project_id!==command.target.projectId)throw new OutlineError('CONFLICT','IR identity target','target');return row;
      };
      const put=(raw:unknown)=>{const row=checked(raw),slot=key(row.kind,row.local_key);if(bindings.has(slot)||reserved.has(row.stable_id))failed('duplicate IR identity');bindings.set(slot,row);reserved.add(row.stable_id);return row;};
      const insert=async(kind:Kind,local:string)=>{
        const id=allocate();if(!stable.safeParse(id).success)throw new OutlineError('INVALID_INPUT','IR identity allocation','id');if(reserved.has(id))throw new OutlineError('CONFLICT','IR identity collision','id');
        const result=await client.query<Row>(`INSERT INTO camery_script.ir_identities(${fields}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${fields}`,[...scope,kind,project(kind)?'project':run.runId,null,project(kind)?null:run.runId,local,command.target.tenantId,command.target.projectId,id]);connected();
        if(result.rows.length!==1)failed('IR identity insertion');const row=checked(result.rows[0]);if(row.kind!==kind||row.local_key!==local||row.stable_id!==id)failed('IR identity insertion binding');return row;
      };
      const proofs=await client.query<Proof>(`SELECT ${proofFields} FROM camery_outline.identity_preparations WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3`,[...scope,run.runId]);connected();
      if(proofs.rows.length>1)failed('IR preparation cardinality');let proof:Proof|undefined;
      if(proofs.rows[0]){try{proof=capture(ProofSchema,proofs.rows[0],'stored IR preparation',4096);}catch{return failed('stored IR preparation');}}
      const anyPreparations=async()=>{const result=await client.query('SELECT 1 FROM camery_outline.identity_preparations WHERE tenant_id=$1 AND project_id=$2 LIMIT 1',scope);connected();if(result.rows.length>1)failed('IR preparation cardinality');return result.rows.length>0;};
      const anyRegistry=async(kinds?:readonly string[])=>{const result=await client.query(`SELECT 1 FROM camery_script.ir_identities WHERE tenant_id=$1 AND project_id=$2${kinds?' AND kind=ANY($3::text[])':''} LIMIT 1`,kinds?[...scope,kinds]:scope);connected();if(result.rows.length>1)failed('IR registry cardinality');return result.rows.length>0;};
      const anchor=await client.query<Row>(`SELECT ${fields} FROM camery_script.ir_identities WHERE tenant_id=$1 AND project_id=$2 AND kind=$3 AND owner_key=$4 AND local_key=$5`,[...scope,'development_plan','project','plan']);connected();
      if(anchor.rows.length>1)failed('IR project anchor cardinality');
      if(anchor.rows[0]){const row=checked(anchor.rows[0]);if(row.kind!=='development_plan'||row.local_key!=='plan')failed('IR project anchor binding');}
      else{if(proof||await anyRegistry()||await anyPreparations())failed('missing IR project anchor');await insert('development_plan','plan');}
      const projectRows=await client.query<Row>(`SELECT ${fields} FROM camery_script.ir_identities WHERE tenant_id=$1 AND project_id=$2 AND kind=ANY($3::text[]) ORDER BY kind,local_key COLLATE "C"`,[...scope,projectKinds]);connected();
      if(projectRows.rows.length>302)failed('IR project identity limit');for(const raw of projectRows.rows){const row=put(raw);if(!project(row.kind))failed('IR project identity selection');}
      const ownerRows=await client.query<Row>(`SELECT ${fields} FROM camery_script.ir_identities WHERE tenant_id=$1 AND project_id=$2 AND kind=ANY($3::text[]) AND owner_key=$4 ORDER BY kind,local_key COLLATE "C"`,[...scope,sourceKinds,run.runId]);connected();
      if(ownerRows.rows.length>1048)failed('IR source identity limit');for(const raw of ownerRows.rows){const row=put(raw);if(project(row.kind))failed('IR source identity selection');}
      const tail=(kind:Kind,paired?:Kind)=>{let last=0,gap=false;for(let n=1;n<=100;n++){const exists=bindings.has(key(kind,String(n)));if(paired&&exists!==bindings.has(key(paired,String(n)))||exists&&gap)failed('incomplete IR episode slots');if(exists)last=n;else gap=true;}return last;};
      const sharedTail=tail('episode','episode_plan'),outlineTail=tail('outline_episode_plan');
      const committed=await readIdentityEpisodeExtents(client,{tenantId:run.tenantId,projectId:run.projectId},command.target);connected();
      if(sharedTail<Math.max(committed.development,committed.outline)||outlineTail<committed.outline)failed('missing committed project IR tail');
      if(anchor.rows[0]&&!sharedTail||outlineTail>sharedTail)failed('missing committed IR episode slots');
      const plan=bindings.get(key('adaptation_plan','plan'));
      if(plan?!outlineTail:outlineTail>0||proof!==undefined||await anyRegistry(newKinds)||await anyPreparations())failed('incomplete IR outline anchor');
      const expected={outline_character:review.output.characters,outline_beat:review.output.beats,outline_asset:review.output.assets,outline_plot_unit:review.output.plotUnits,outline_decision:review.output.adaptation.decisions};
      const count=Object.values(expected).reduce((total,rows)=>total+rows.length,0);
      if(proof){
        if(ownerRows.rows.length!==count||Object.entries(expected).some(([kind,rows])=>rows.some(row=>!bindings.has(key(kind as Kind,row.id))))||sharedTail<run.brief.episodeCount||outlineTail<run.brief.episodeCount)failed('incomplete committed IR identities');
      }else if(ownerRows.rows.length)failed('missing committed IR preparation');
      const required=(kind:Kind,local:string)=>{const row=bindings.get(key(kind,local));if(!row)failed('missing IR identity');return row.stable_id;};
      const fingerprint=()=>digestOutlineFormal({version:1,source:command.source,target:command.target,developmentPlanId:required('development_plan','plan'),planId:required('adaptation_plan','plan'),
        bindings:Object.entries(expected).map(([kind,rows])=>({kind,rows:rows.map(row=>({localId:row.id,id:required(kind as Kind,row.id)}))})),
        episodes:Array.from({length:run.brief.episodeCount},(_,index)=>{const local=String(index+1);return {number:index+1,episodeId:required('episode',local),developmentPlanId:required('episode_plan',local),outlinePlanId:required('outline_episode_plan',local)};})});
      const expectedProof=():Proof=>({tenant_id:run.tenantId,project_id:run.projectId,run_id:run.runId,run_digest:run.digest,review_digest:review.digest,episode_count:run.brief.episodeCount,ir_tenant_id:command.target.tenantId,ir_project_id:command.target.projectId,registry_digest:fingerprint()});
      if(proof&&!equalOutlineFormal(proof,expectedProof()))failed('stored IR preparation binding');
      const ensure=async(kind:Kind,local:string)=>{let row=bindings.get(key(kind,local));if(!row)row=put(await insert(kind,local));return row.stable_id;};
      await ensure('adaptation_plan','plan');
      const localBindings=async(kind:typeof sourceKinds[number])=>{const rows=[];for(const row of expected[kind])rows.push({localId:row.id,id:await ensure(kind,row.id)});return rows;};
      const characters=await localBindings('outline_character'),beats=await localBindings('outline_beat'),assets=await localBindings('outline_asset'),plotUnits=await localBindings('outline_plot_unit'),decisions=await localBindings('outline_decision');
      for(let n=1;n<=run.brief.episodeCount;n++){await ensure('episode',String(n));await ensure('episode_plan',String(n));await ensure('outline_episode_plan',String(n));}
      const episodes=[];for(let n=1;n<=100;n++)if(bindings.has(key('outline_episode_plan',String(n))))episodes.push({number:n,episodeId:required('episode',String(n)),planId:required('outline_episode_plan',String(n))});
      const identities=capture(OutlineFormalIdentitiesSchema,{tenantId:run.tenantId,projectId:run.projectId,target:command.target,owner:{runId:run.runId,runDigest:run.digest},planId:required('adaptation_plan','plan'),characters,beats,assets,plotUnits,decisions,episodes},'IR identity result');
      if(!proof){const value=expectedProof(),result=await client.query<Proof>(`INSERT INTO camery_outline.identity_preparations(${proofFields}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${proofFields}`,[value.tenant_id,value.project_id,value.run_id,value.run_digest,value.review_digest,value.episode_count,value.ir_tenant_id,value.ir_project_id,value.registry_digest]);connected();if(result.rows.length!==1||!equalOutlineFormal(capture(ProofSchema,result.rows[0],'IR preparation insertion',4096),value))failed('IR preparation insertion binding');}
      connected();await client.query('COMMIT');connected();return deepFreeze({identities,progress});
    }catch(error){
      try{await client.query('ROLLBACK');}catch{destroy=true;return failed('IR identity rollback');}connected();if(error instanceof OutlineError)throw error;
      let code:unknown;try{if(error&&typeof error==='object'){const descriptor=Object.getOwnPropertyDescriptor(error,'code');if(descriptor&&'value' in descriptor)code=descriptor.value;}}catch{/* Untrusted driver errors remain redacted. */}
      if(code==='23505')throw new OutlineError('CONFLICT','IR identity allocation collision','id');return failed('IR identity transaction');
    // Unknown release outcomes must never expose credential-bearing driver errors.
    }finally{try{client.release(destroy);}catch{failed('IR identity release');}finally{client.off('error',onError);}}
  }
}
