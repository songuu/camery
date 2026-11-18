import {EventEmitter} from 'node:events';
import type {Pool,PoolClient} from 'pg';
import {expect,it,vi} from 'vitest';
import {PostgresDevelopmentIrIdentities} from '../src/node/ir-identities.js';
import {generateFoundation,generateEpisodes} from '../src/development.js';
import {developmentStageCallId} from '../src/node/contracts.js';
import {workflowFixture} from './workflow-support.js';
import {fixtureId as id} from '../../ir/test/fixtures';
import {DevelopmentError} from '../src/contracts.js';
import type {DevelopmentBrief} from '../src/contracts.js';
import {memoryDatabase} from './store-memory.js';
import {identityPgFixture} from './ir-identities-pg-support.js';

type Row={tenant_id:string;project_id:string;kind:string;owner_key:string;owner_run_id:string|null;local_key:string;ir_tenant_id:string;ir_project_id:string;stable_id:string};
async function fixture(){
  const f=workflowFixture();const foundation=await generateFoundation({...f,method:f.foundationMethod,context:f.context(developmentStageCallId(f.key,'foundation'))});await f.store.saveCandidate(f.key,foundation);const accepted=await f.store.review(f.key,'foundation',{candidateDigest:foundation.digest,output:foundation.output},f.host);
  const episodes=await generateEpisodes({...f,foundation:accepted as Parameters<typeof generateEpisodes>[0]['foundation'],method:f.episodeMethod,context:f.context(developmentStageCallId(f.key,'episodes'))});await f.store.saveCandidate(f.key,episodes);const reviewed=await f.store.review(f.key,'episodes',{candidateDigest:episodes.digest,output:episodes.output},f.host);
  const input={source:{...f.key,runDigest:f.run.digest,briefDigest:f.brief.digest,foundationReviewDigest:accepted.digest,episodesReviewDigest:reviewed.digest},target:{tenantId:id('identity-tenant'),projectId:id('identity-project')}};
  const rows:Row[]=[];const events:string[]=[];const options:{fail?:string;release?:boolean;disconnect?:boolean;corrupt?:(row:Row)=>Row}={};let snapshot:Row[]=[];let ordinal=0;const emitter=new EventEmitter();
  const sourceBriefs=new Map<string,DevelopmentBrief>(),sourceKey=(tenantId:string,projectId:string,owner:string)=>JSON.stringify([tenantId,projectId,owner]);
  const query=vi.fn(async(sql:string,values:unknown[]=[]):Promise<{rows:Record<string,unknown>[]}>=>{
    events.push(sql);if(options.fail&&sql.startsWith(options.fail))throw new Error('private-driver');if(sql.startsWith('BEGIN'))snapshot=structuredClone(rows);
    if(sql==='ROLLBACK')rows.splice(0,rows.length,...snapshot);
    if(sql.includes(' AS installed'))return {rows:[{installed:false}]};
    if(sql.startsWith('SELECT i.owner_run_id')){
      const sourceRows=rows.filter(row=>row.tenant_id===values[0]&&row.project_id===values[1]&&['world','character','relationship'].includes(row.kind)&&row.owner_run_id!==null&&row.owner_run_id>String(values[2]));
      const owners=[...new Map(sourceRows.map(row=>[JSON.stringify([row.owner_run_id,row.ir_tenant_id,row.ir_project_id]),row])).values()].toSorted((a,b)=>a.owner_run_id!<b.owner_run_id!?-1:a.owner_run_id!>b.owner_run_id!?1:0).slice(0,64);
      return {rows:owners.map(row=>{const brief=sourceBriefs.get(sourceKey(row.tenant_id,row.project_id,row.owner_run_id!));return {owner_run_id:row.owner_run_id,ir_tenant_id:row.ir_tenant_id,ir_project_id:row.ir_project_id,brief_id:brief?.briefId??null,brief_revision:brief?.revision??null,brief_digest:brief?.digest??null,tenant_id:brief?.tenantId??null,project_id:brief?.projectId??null,stored_brief_id:brief?.briefId??null,stored_revision:brief?.revision??null,digest:brief?.digest??null,record:brief??null};})};
    }
    if(sql.startsWith('SELECT')&&sql.includes('camery_script.ir_identities')){
      if(sql.includes('LIMIT 1'))return {rows:rows.filter(row=>row.tenant_id===values[0]&&row.project_id===values[1]).slice(0,1)};
      const selected=rows.filter(row=>row.tenant_id===values[0]&&row.project_id===values[1]&&(sql.includes('kind=$3')?row.kind===values[2]&&row.owner_key===values[3]&&row.local_key===values[4]:row.owner_key===values[2]&&['world','character','relationship'].includes(row.kind)||row.owner_key==='project'&&['development_plan','episode','episode_plan'].includes(row.kind)));
      return {rows:selected.map(row=>options.corrupt?options.corrupt(structuredClone(row)):structuredClone(row))};
    }
    if(sql.startsWith('INSERT INTO camery_script.ir_identities')){
      const [tenant_id,project_id,kind,owner_key,owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id]=values as [string,string,string,string,string|null,string,string,string,string];
      if(rows.some(row=>row.stable_id===stable_id))throw Object.assign(new Error('private-unique'),{code:'23505'});const row={tenant_id,project_id,kind,owner_key,owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id};rows.push(row);if(options.disconnect)emitter.emit('error',new Error('private-disconnection'));return {rows:[row]};
    }
    return {rows:[]};
  });
  const release=vi.fn((_destroy?:boolean)=>{if(options.release)throw new Error('private-release');});const client=Object.assign(emitter,{query,release});const connect=vi.fn(async()=>client);const pool={connect} as unknown as Pool;
  const source={readForAdoption:vi.fn(async(supplied:PoolClient,_command?:unknown)=>{expect(supplied).toBe(client);events.push('SOURCE');return f.progress;})};const newId=vi.fn(()=>id('persistent-'+ordinal++));
  const storedSource={async readForAdoption(supplied:PoolClient,command:unknown){const progress=await source.readForAdoption(supplied,command),owner=progress.run.origin?.foundation?.runId??progress.run.runId;sourceBriefs.set(sourceKey(progress.run.tenantId,progress.run.projectId,owner),structuredClone(progress.run.brief));return progress;}};
  const store=new PostgresDevelopmentIrIdentities(pool,storedSource,newId);
  return {...f,input,rows,events,options,query,release,client,connect,source,newId,identities:store};
}
it('persists every source identity once after source locks and returns stable frozen identities on retry',async()=>{
  const f=await fixture();const prepared=await f.identities.prepare(f.input);expect(prepared.progress).toEqual(f.progress);expect(prepared.identities).toMatchObject({tenantId:f.key.tenantId,projectId:f.key.projectId,target:f.input.target,foundationOwner:{runId:f.run.runId,runDigest:f.run.digest}});
  expect(prepared.identities.characters.map(row=>row.localId)).toEqual(f.progress.foundation.review!.status==='reviewed'?f.progress.foundation.review!.output.characters.map(row=>row.id):[]);expect(prepared.identities.episodes).toHaveLength(10);expect(Object.isFrozen(prepared.identities.characters)).toBe(true);
  expect(f.events[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');expect(f.events.indexOf('SOURCE')).toBeLessThan(f.events.findIndex(sql=>sql.startsWith('SELECT pg_advisory')));expect(f.events.at(-1)).toBe('COMMIT');expect(f.release).toHaveBeenCalledWith(false);expect(f.client.listenerCount('error')).toBe(0);
  const allocated=f.newId.mock.calls.length;expect((await f.identities.prepare(f.input)).identities).toEqual(prepared.identities);expect(f.newId).toHaveBeenCalledTimes(allocated);
});
it('binds the existing project plan anchor before accepting a different target',async()=>{
  const f=await fixture();await f.identities.prepare(f.input);const before=structuredClone(f.rows);await expect(f.identities.prepare({...f.input,target:{...f.input.target,projectId:id('other-target')}})).rejects.toMatchObject({code:'CONFLICT'});expect(f.rows).toEqual(before);
});
it('captures source/target before awaiting connection and never evaluates accessors',async()=>{
  const f=await fixture();const command=structuredClone(f.input);const pending=f.identities.prepare(command);command.target.projectId=id('mutated');command.source.runId='mutated';expect((await pending).identities.target).toEqual(f.input.target);expect(f.source.readForAdoption).toHaveBeenCalledWith(f.client,f.input.source);
  const invoked=vi.fn(()=>{throw new Error('must not invoke');});const unsafe=Object.defineProperty({...f.input},'source',{enumerable:true,get:invoked});f.connect.mockClear();await expect(f.identities.prepare(unsafe)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(invoked).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();
});
it('does not allocate or commit when current reviewed source reconstruction refuses',async()=>{
  const f=await fixture();f.source.readForAdoption.mockRejectedValueOnce(Object.assign(new Error('source changed'),{code:'CONFLICT'}));await expect(f.identities.prepare(f.input)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.newId).not.toHaveBeenCalled();expect(f.rows).toEqual([]);expect(f.events.at(-1)).toBe('ROLLBACK');
});
it('preserves an explicit domain refusal and redacts a failed checkout without releasing an unowned connection',async()=>{
  const f=await fixture();f.source.readForAdoption.mockRejectedValueOnce(new DevelopmentError('CONFLICT','latest brief'));await expect(f.identities.prepare(f.input)).rejects.toMatchObject({code:'CONFLICT'});expect(f.newId).not.toHaveBeenCalled();
  f.release.mockClear();f.connect.mockRejectedValueOnce(new Error('private-login'));await expect(f.identities.prepare(f.input)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.release).not.toHaveBeenCalled();
});
it('redacts arbitrary rejected error objects without evaluating a code accessor',async()=>{
  const f=await fixture();const getter=vi.fn(()=>{throw new Error('private-error-getter');});f.source.readForAdoption.mockRejectedValueOnce(Object.defineProperty({},'code',{get:getter}));await expect(f.identities.prepare(f.input)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(getter).not.toHaveBeenCalled();
});
it('checks the full returned source and expected review digests before allocating',async()=>{
  const f=await fixture();await expect(f.identities.prepare({...f.input,source:{...f.input.source,episodesReviewDigest:'d'.repeat(64)}})).rejects.toMatchObject({code:'CONFLICT'});expect(f.newId).not.toHaveBeenCalled();
  const other=await fixture();Object.assign(other.progress,{run:{...other.run,runId:'unbound'}});await expect(other.identities.prepare(other.input)).rejects.toMatchObject({code:'CONFLICT'});expect(other.newId).not.toHaveBeenCalled();
});
it.each(['invalid','duplicate'] as const)('rolls back the entire identity bundle on %s allocator output',async mode=>{
  const f=await fixture();f.newId.mockImplementation(()=>mode==='invalid'?'bad':id('duplicate'));await expect(f.identities.prepare(f.input)).rejects.toMatchObject({code:mode==='invalid'?'INVALID_INPUT':'CONFLICT'});expect(f.rows).toEqual([]);expect(f.events.at(-1)).toBe('ROLLBACK');
});
it.each(['scope','owner','id','local'] as const)('fails closed on a corrupt stored %s binding',async mode=>{
  const f=await fixture();await f.identities.prepare(f.input);f.options.corrupt=row=>({...row,...(mode==='scope'?{project_id:'other'}:mode==='owner'?{owner_key:'wrong'}:mode==='id'?{stable_id:'invalid'}:{local_key:'not-the-plan'})});await expect(f.identities.prepare(f.input)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it.each(['owner','slot','kind','duplicate','source-set'] as const)('rejects corrupt foundation or episode %s rows after the valid plan anchor',async mode=>{
  const f=await fixture();await f.identities.prepare(f.input);const world=f.rows.find(row=>row.kind==='world')!;
  if(mode==='owner')world.owner_run_id=null;if(mode==='slot')world.local_key='unexpected';if(mode==='kind')f.options.corrupt=row=>row.kind==='world'?{...row,kind:'invalid'}:row;if(mode==='duplicate'){const character=f.rows.find(row=>row.kind==='character')!;world.stable_id=character.stable_id;}if(mode==='source-set')f.rows.push({...world,kind:'character',local_key:'unreviewed-character',stable_id:id('unexpected-character')});
  await expect(f.identities.prepare(f.input)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it.each(['episode_plan','episode','world','character','relationship','anchor','all-project','episode-gap','episodes-all','episode-tail'] as const)('never reallocates missing %s identities from an already committed atomic bundle',async mode=>{
  const f=await fixture();await f.identities.prepare(f.input);const originalCount=f.rows.length;
  if(mode==='anchor')f.rows.splice(f.rows.findIndex(row=>row.kind==='development_plan'),1);
  else if(mode==='all-project'){for(let at=f.rows.length-1;at>=0;at--)if(f.rows[at]!.owner_key==='project')f.rows.splice(at,1);}
  else if(mode==='episode-gap'){for(let at=f.rows.length-1;at>=0;at--)if(['episode','episode_plan'].includes(f.rows[at]!.kind)&&f.rows[at]!.local_key==='5')f.rows.splice(at,1);}
  else if(mode==='episodes-all'){for(let at=f.rows.length-1;at>=0;at--)if(['episode','episode_plan'].includes(f.rows[at]!.kind))f.rows.splice(at,1);}
  else if(mode==='episode-tail'){for(let at=f.rows.length-1;at>=0;at--)if(['episode','episode_plan'].includes(f.rows[at]!.kind)&&f.rows[at]!.local_key==='10')f.rows.splice(at,1);}
  else f.rows.splice(f.rows.findIndex(row=>row.kind===mode),1);
  expect(f.rows.length).toBeLessThan(originalCount);const before=structuredClone(f.rows);f.newId.mockClear();f.query.mockClear();await expect(f.identities.prepare(f.input)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.newId).not.toHaveBeenCalled();expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);expect(f.rows).toEqual(before);
});
it('allows a new reviewed foundation owner and complete contiguous episode expansion while preserving all old project slots',async()=>{
  // The source store uses the existing typed memory protocol; no PostgreSQL connection is started by this fixture helper.
  const sourceDb=memoryDatabase();const source=await identityPgFixture(sourceDb.pool,[]);const f=await fixture();f.source.readForAdoption.mockResolvedValueOnce(await source.store.read({...source.scope,runId:source.run.runId}));
  const first=await f.identities.prepare({source:source.source,target:source.target});const saved=await source.store.putBrief({...source.put,expectedRevision:1,episodeCount:12});const newer=await source.start('expanded-owner',saved.brief);f.source.readForAdoption.mockResolvedValueOnce(await source.store.read({...source.scope,runId:newer.run.runId}));f.newId.mockClear();
  const expanded=await f.identities.prepare({source:newer.source,target:source.target});expect(expanded.identities.planId).toBe(first.identities.planId);expect(expanded.identities.episodes.slice(0,10)).toEqual(first.identities.episodes);expect(expanded.identities.episodes.map(row=>row.number)).toEqual(Array.from({length:12},(_,i)=>i+1));expect(expanded.identities.worldId).not.toBe(first.identities.worldId);
  expect(f.newId.mock.calls.length).toBe(1+expanded.identities.characters.length+expanded.identities.relationships.length+4);
});
it.each(['query','commit','rollback','release','disconnect'] as const)('redacts %s failures and never reports a partial bundle as successful',async mode=>{
  const f=await fixture();if(mode==='query')f.options.fail='INSERT';if(mode==='commit')f.options.fail='COMMIT';if(mode==='rollback'){f.options.fail='ROLLBACK';f.newId.mockImplementation(()=>{throw new Error('private-generator');});}if(mode==='release')f.options.release=true;if(mode==='disconnect')f.options.disconnect=true;
  await expect(f.identities.prepare(f.input)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.release).toHaveBeenCalledOnce();expect(f.client.listenerCount('error')).toBe(0);if(mode==='rollback'||mode==='disconnect')expect(f.release).toHaveBeenCalledWith(true);
});
