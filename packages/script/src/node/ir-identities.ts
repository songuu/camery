import type {Pool} from 'pg';
import {DevelopmentError,LocalId} from '../contracts.js';
import {copy,freeze,parse} from '../data.js';
import {validateReviewedFoundation,validateReviewedEpisodes} from '../reviewed.js';
import {validateDevelopmentRun} from './contracts.js';
import type {DevelopmentProgress} from './contracts.js';
import type {PostgresDevelopmentStore} from './store.js';
import {DevelopmentIdentityPreparationSchema,DevelopmentFormalIdentitiesSchema,FormalStableId} from './adoption-contracts.js';
import type {DevelopmentFormalIdentities} from './adoption-contracts.js';
import {readIdentityEpisodeExtents} from './identity-extents.js';

type Kind='development_plan'|'world'|'character'|'relationship'|'episode'|'episode_plan';
type Row={tenant_id:string;project_id:string;kind:Kind;owner_key:string;owner_run_id:string|null;local_key:string;ir_tenant_id:string;ir_project_id:string;stable_id:string};
const kinds:readonly Kind[]=['development_plan','world','character','relationship','episode','episode_plan'];
const projectKinds:readonly Kind[]=['development_plan','episode','episode_plan'];
const fields='tenant_id,project_id,kind,owner_key,owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id';
const rowKey=(kind:Kind,local:string)=>JSON.stringify([kind,local]);

/** Host-only local object registry. Ordinary tenant/project authority remains the shared projects registry. */
export class PostgresDevelopmentIrIdentities{
  constructor(private readonly pool:Pool,private readonly source:Pick<PostgresDevelopmentStore,'readForAdoption'>,private readonly newId:()=>string){}
  async prepare(input:unknown):Promise<{identities:DevelopmentFormalIdentities;progress:DevelopmentProgress}>{
    const command=freeze(parse(DevelopmentIdentityPreparationSchema,copy(input),'IR identity preparation'));const read=this.source.readForAdoption.bind(this.source);const allocate=this.newId;
    if(typeof allocate!=='function')throw new DevelopmentError('INVALID_INPUT','IR identity allocator');
    const client=await this.pool.connect().catch(()=>{throw new DevelopmentError('STORAGE_FAILED','IR identity connection');});let failed=false;let destroy=false;
    const onError=()=>{failed=true;destroy=true;};const connected=()=>{if(failed)throw new DevelopmentError('STORAGE_FAILED','IR identity connection');};client.on('error',onError);
    try{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');connected();
      // Reuse the owning transaction, including source brief/run locks, before acquiring the project mapping lock.
      const progress=copy(await read(client,command.source),524288);connected();const run=validateDevelopmentRun({tenantId:command.source.tenantId,projectId:command.source.projectId,runId:command.source.runId},progress.run);
      const foundation=validateReviewedFoundation(run.brief,progress.foundation.review);const episodes=validateReviewedEpisodes(run.brief,foundation,progress.episodes.review);
      if(run.digest!==command.source.runDigest||run.brief.digest!==command.source.briefDigest||foundation.digest!==command.source.foundationReviewDigest||episodes.digest!==command.source.episodesReviewDigest)throw new DevelopmentError('CONFLICT','IR identity source binding');
      const owner={runId:run.origin?.foundation?.runId??run.runId,runDigest:run.origin?.foundation?.runDigest??run.digest};const scope=[run.tenantId,run.projectId];
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_script:ir-identities',...scope])]);connected();
      const bindings=new Map<string,Row>();const reserved=new Set<string>([command.target.projectId]);
      const checked=(raw:Row):Row=>{
        if(raw.tenant_id!==run.tenantId||raw.project_id!==run.projectId||!kinds.includes(raw.kind)||!FormalStableId.safeParse(raw.stable_id).success||!FormalStableId.safeParse(raw.ir_tenant_id).success||!FormalStableId.safeParse(raw.ir_project_id).success||!LocalId.safeParse(raw.local_key).success)throw new DevelopmentError('STORAGE_FAILED','stored IR identity');
        if(projectKinds.includes(raw.kind)?raw.owner_key!=='project'||raw.owner_run_id!==null:raw.owner_key!==owner.runId||raw.owner_run_id!==owner.runId)throw new DevelopmentError('STORAGE_FAILED','stored IR identity owner');
        if(raw.kind==='development_plan'?raw.local_key!=='plan':raw.kind==='world'?raw.local_key!=='world':raw.kind==='episode'||raw.kind==='episode_plan'?!/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw.local_key):false)throw new DevelopmentError('STORAGE_FAILED','stored IR identity slot');
        if(raw.ir_tenant_id!==command.target.tenantId||raw.ir_project_id!==command.target.projectId)throw new DevelopmentError('CONFLICT','IR identity target');
        return raw;
      };
      const put=(raw:Row)=>{const row=checked(raw);const key=rowKey(row.kind,row.local_key);if(bindings.has(key)||reserved.has(row.stable_id))throw new DevelopmentError('STORAGE_FAILED','duplicate IR identity');bindings.set(key,row);reserved.add(row.stable_id);};
      const insert=async(kind:Kind,local:string):Promise<Row>=>{
        const stable=allocate();if(!FormalStableId.safeParse(stable).success)throw new DevelopmentError('INVALID_INPUT','IR identity allocation');if(reserved.has(stable))throw new DevelopmentError('CONFLICT','IR identity allocation collision');
        const project=projectKinds.includes(kind);const rows=await client.query<Row>(`INSERT INTO camery_script.ir_identities(${fields}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${fields}`,[...scope,kind,project?'project':owner.runId,project?null:owner.runId,local,command.target.tenantId,command.target.projectId,stable]);connected();
        if(rows.rows.length!==1)throw new DevelopmentError('STORAGE_FAILED','IR identity insertion');const row=checked(rows.rows[0]!);if(row.kind!==kind||row.local_key!==local||row.stable_id!==stable)throw new DevelopmentError('STORAGE_FAILED','IR identity insertion binding');return row;
      };
      // This stable project anchor is checked first, even when a new foundation owner introduces entirely new local identities.
      const anchor=await client.query<Row>(`SELECT ${fields} FROM camery_script.ir_identities WHERE tenant_id=$1 AND project_id=$2 AND kind=$3 AND owner_key=$4 AND local_key=$5`,[...scope,'development_plan','project','plan']);connected();
      if(anchor.rows.length>1)throw new DevelopmentError('STORAGE_FAILED','duplicate IR plan');
      if(anchor.rows[0])checked(anchor.rows[0]);else{
        const remaining=await client.query('SELECT 1 FROM camery_script.ir_identities WHERE tenant_id=$1 AND project_id=$2 LIMIT 1',scope);connected();
        if(remaining.rows.length)throw new DevelopmentError('STORAGE_FAILED','incomplete IR project anchor');await insert('development_plan','plan');
      }
      const existing=await client.query<Row>(`SELECT ${fields} FROM camery_script.ir_identities WHERE tenant_id=$1 AND project_id=$2 AND ((owner_key=$3 AND kind IN ('world','character','relationship')) OR (owner_key='project' AND kind IN ('development_plan','episode','episode_plan'))) ORDER BY kind,local_key COLLATE "C"`,[...scope,owner.runId]);connected();
      if(existing.rows.length>298)throw new DevelopmentError('STORAGE_FAILED','IR identity limit');for(const row of existing.rows)put(row);
      const characterIds=new Set(foundation.output.characters.map(row=>row.id));const relationshipIds=new Set(foundation.output.relationships.map(row=>row.id));
      for(const row of bindings.values())if(row.kind==='character'&&!characterIds.has(row.local_key)||row.kind==='relationship'&&!relationshipIds.has(row.local_key))throw new DevelopmentError('STORAGE_FAILED','stored IR identity source set');
      // Each owner group and episode pair was committed atomically. Missing members are corruption, not permission to assign replacement identities.
      const sourceRows=[...bindings.values()].filter(row=>!projectKinds.includes(row.kind));
      if(sourceRows.length&&(sourceRows.length!==1+characterIds.size+relationshipIds.size||!bindings.has(rowKey('world','world'))
        ||[...characterIds].some(key=>!bindings.has(rowKey('character',key)))||[...relationshipIds].some(key=>!bindings.has(rowKey('relationship',key)))))throw new DevelopmentError('STORAGE_FAILED','incomplete IR foundation identities');
      if(anchor.rows[0]&&!bindings.has(rowKey('episode','1')))throw new DevelopmentError('STORAGE_FAILED','missing committed IR episode identities');
      let episodeGap=false;let lastEpisode=0;for(let number=1;number<=100;number++){
        const hasEpisode=bindings.has(rowKey('episode',String(number)));const hasPlan=bindings.has(rowKey('episode_plan',String(number)));
        if(hasEpisode!==hasPlan||hasEpisode&&episodeGap)throw new DevelopmentError('STORAGE_FAILED','incomplete IR episode identities');if(hasEpisode)lastEpisode=number;else episodeGap=true;
      }
      if(sourceRows.length&&lastEpisode<run.brief.episodeCount)throw new DevelopmentError('STORAGE_FAILED','missing committed IR episode tail');
      const committed=await readIdentityEpisodeExtents(client,{tenantId:run.tenantId,projectId:run.projectId},command.target);connected();
      if(lastEpisode<Math.max(committed.development,committed.outline))throw new DevelopmentError('STORAGE_FAILED','missing project IR episode tail');
      const ensure=async(kind:Kind,local:string)=>{const key=rowKey(kind,local);let row=bindings.get(key);if(!row){row=await insert(kind,local);put(row);}return row.stable_id;};
      const planId=bindings.get(rowKey('development_plan','plan'))?.stable_id;if(!planId)throw new DevelopmentError('STORAGE_FAILED','missing IR plan anchor');
      const worldId=await ensure('world','world');const characters=[];for(const row of foundation.output.characters)characters.push({localId:row.id,id:await ensure('character',row.id)});const relationships=[];for(const row of foundation.output.relationships)relationships.push({localId:row.id,id:await ensure('relationship',row.id)});
      for(let number=1;number<=run.brief.episodeCount;number++){await ensure('episode',String(number));await ensure('episode_plan',String(number));}
      const mappedEpisodes=[];for(let number=1;number<=100;number++){const episode=bindings.get(rowKey('episode',String(number)));const plan=bindings.get(rowKey('episode_plan',String(number)));if(!!episode!==!!plan)throw new DevelopmentError('STORAGE_FAILED','incomplete IR episode slot');if(episode&&plan)mappedEpisodes.push({number,episodeId:episode.stable_id,planId:plan.stable_id});}
      const identities=parse(DevelopmentFormalIdentitiesSchema,{tenantId:run.tenantId,projectId:run.projectId,target:command.target,foundationOwner:owner,planId,worldId,characters,relationships,episodes:mappedEpisodes},'IR identity result');
      connected();await client.query('COMMIT');connected();return freeze({identities,progress});
    }catch(error){
      try{await client.query('ROLLBACK');}catch{destroy=true;throw new DevelopmentError('STORAGE_FAILED','IR identity rollback');}connected();
      if(error instanceof DevelopmentError)throw error;
      let code:unknown;try{if(error&&typeof error==='object'){const descriptor=Object.getOwnPropertyDescriptor(error,'code');if(descriptor&&'value' in descriptor)code=descriptor.value;}}catch{/* Unknown errors, including proxy traps, remain storage failures. */}
      if(code==='23505')throw new DevelopmentError('CONFLICT','IR identity allocation collision');throw new DevelopmentError('STORAGE_FAILED','IR identity transaction');
    // oxlint-disable-next-line eslint/no-unsafe-finally -- A release failure is unknown storage outcome, never a credential-bearing driver exception.
    }finally{try{client.release(destroy);}catch{throw new DevelopmentError('STORAGE_FAILED','IR identity release');}finally{client.off('error',onError);}}
  }
}
