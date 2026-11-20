import {expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import * as screenplay from '../src/screenplay/node/index.js';
import {readScreenplayNativeIntent,readScreenplayNativeIntentForChange} from '../src/screenplay/node/intent.js';
import {SCREENPLAY_CANDIDATE_BYTES} from '../src/screenplay/contracts.js';
import type {ScreenplayNativeBinding} from '../src/screenplay/node/native-contracts.js';
import {screenplayNativeFixture} from './screenplay-native-support.js';
import {continuityDigest} from '../src/continuity/node/digest.js';

type Row=Record<string,unknown>;
function signed<T extends {digest:string}>(record:T):T{const {digest:_digest,...body}=record;return {...record,digest:continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)};}
/** SQL protocol fixture: reads the real native record parser, without claiming PostgreSQL persistence. */
async function fixture(){
  const f=await screenplayNativeFixture(),body={version:1 as const,key:f.key,mapping:f.mapping,ids:f.ids},binding={...body,digest:continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)};
  const row:Row={tenant_id:f.key.tenantId,project_id:f.key.projectId,candidate_id:f.key.candidateId,formal_tenant_id:f.target.tenantId,formal_project_id:f.target.projectId,
    change_id:f.mapping.request.id,source_revision:String(f.mapping.sourceRevision),mapping_digest:f.mapping.digest,review_digest:f.mapping.reviewDigest,digest:binding.digest,record:structuredClone(binding)};
  const pointer={formal_tenant_id:f.target.tenantId,formal_project_id:f.target.projectId,change_id:f.mapping.request.id},state={pointers:[pointer],bindings:[row]};
  const query=vi.fn(async(sql:string,_values:unknown[]=[])=>({rows:sql.startsWith('SELECT formal_tenant_id,formal_project_id,change_id FROM')?state.pointers:state.bindings})),release=vi.fn();
  return {...f,binding,state,query,release,client:{query,release} as unknown as PoolClient,input:{scope:f.scope,target:f.target,changeId:f.mapping.request.id}};
}

it('recovers the original complete fixed identities by candidate key without knowing the lost native ACK change id',async()=>{
  const f=await fixture();expect(await readScreenplayNativeIntent(f.client,f.key,f.host)).toEqual(f.binding);
  expect(f.query).toHaveBeenCalledWith(expect.stringContaining('WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3'),[f.key.tenantId,f.key.projectId,f.key.candidateId]);
});
it('returns null for a genuinely absent committed intention',async()=>{const f=await fixture();f.state.pointers=[];expect(await readScreenplayNativeIntent(f.client,f.key,f.host)).toBeNull();});
it.each(['grant','columns','key','missing','cardinality','opaque'] as const)('refuses candidate intention %s safely without owning caller lifecycle',async mode=>{
  const f=await fixture();if(mode==='grant')f.host.authorize=()=>false;if(mode==='columns')f.state.pointers=[{formal_tenant_id:'bad',formal_project_id:'bad',change_id:'bad'}];
  if(mode==='key'){const changed=signed({...f.binding,key:{...f.key,candidateId:'other'}});Object.assign(f.state.bindings[0]!,{candidate_id:'other',digest:changed.digest,record:changed});}
  if(mode==='missing')f.state.bindings=[];if(mode==='cardinality')f.state.pointers.push({...f.state.pointers[0]!});
  if(mode==='opaque')f.query.mockRejectedValue(new Proxy({},{getPrototypeOf(){throw new Error('private://trap');}}));
  await expect(readScreenplayNativeIntent(f.client,f.key,f.host)).rejects.toThrow();if(mode==='grant')expect(f.query).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
});

it('exports native mapping and identity schemas that parse actual domain fixtures',async()=>{
  const f=await fixture();expect(screenplay.ScreenplayNativeMappingSchema.safeParse(f.mapping)).toEqual({success:true,data:f.mapping});
  for(const identity of f.ids)expect(screenplay.ScreenplayNativeIdentitySchema.safeParse(identity)).toEqual({success:true,data:identity});
});
it('exports only the authorized native change lookup and returns the complete frozen committed binding',async()=>{
  const f=await fixture();expect(screenplay.readScreenplayNativeIntentForChange).toBe(readScreenplayNativeIntentForChange);expect(screenplay).not.toHaveProperty('readScreenplayNativeBinding');
  const authorize=vi.fn(()=>{expect(f.query).not.toHaveBeenCalled();return true;});f.host.authorize=authorize;
  const result=await readScreenplayNativeIntentForChange(f.client,f.input,f.host);expect(result).toEqual(f.binding);expect(Object.isFrozen(result!.mapping.request.ops)).toBe(true);
  expect(authorize).toHaveBeenCalledExactlyOnceWith({action:'screenplay:read',scope:f.scope});expect(f.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('WHERE formal_tenant_id=$1 AND formal_project_id=$2 AND change_id=$3'),[f.target.tenantId,f.target.projectId,f.input.changeId]);
  expect(f.release).not.toHaveBeenCalled();
});
it('returns null only when no committed native binding exists',async()=>{const f=await fixture();f.state.bindings=[];expect(await readScreenplayNativeIntentForChange(f.client,f.input,f.host)).toBeNull();expect(f.query).toHaveBeenCalledTimes(1);});

it.each(['denied','tenant','project','machine','promise','throw','accessor'] as const)('denies %s host authority before SQL',async mode=>{
  const f=await fixture();let host:unknown=f.host;
  if(mode==='denied')f.host.authorize=()=>false;if(mode==='tenant')f.host.scope={...f.scope,tenantId:'other-tenant'};if(mode==='project')f.host.scope={...f.scope,projectId:'other-project'};
  if(mode==='machine')host={...f.host,actor:{kind:'agent_run',id:'machine'}};if(mode==='promise')host={...f.host,authorize:()=>Promise.resolve(true)};if(mode==='throw')f.host.authorize=()=>{throw new Error('private://authority');};
  if(mode==='accessor')host=Object.defineProperty({...f.host},'authorize',{enumerable:true,get(){throw new Error('private://host-getter');}});
  await expect(readScreenplayNativeIntentForChange(f.client,f.input,host)).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.query).not.toHaveBeenCalled();
});

it.each(['outer-extra','scope-extra','target-extra','ordinary-id','target-tenant','target-project','change-id','newline-id','getter','opaque'] as const)('rejects strict %s input before authorization or SQL',async mode=>{
  const f=await fixture(),authorize=vi.fn(()=>true);f.host.authorize=authorize;let input:unknown=f.input;
  if(mode==='outer-extra')input={...f.input,extra:true};if(mode==='scope-extra')input={...f.input,scope:{...f.scope,extra:true}};if(mode==='target-extra')input={...f.input,target:{...f.target,extra:true}};
  if(mode==='ordinary-id')input={...f.input,scope:{...f.scope,tenantId:'invalid tenant'}};if(mode==='target-tenant')input={...f.input,target:{...f.target,tenantId:'ordinary-tenant'}};
  if(mode==='target-project')input={...f.input,target:{...f.target,projectId:f.target.projectId.toLowerCase()}};if(mode==='change-id')input={...f.input,changeId:'ordinary-change'};if(mode==='newline-id')input={...f.input,changeId:f.input.changeId+'\n'};
  let touched=false;if(mode==='getter')input=Object.defineProperty({},'scope',{enumerable:true,get(){touched=true;throw new Error('private://input-getter');}});if(mode==='opaque')input=new Proxy({},{getPrototypeOf(){throw new Error('private://input-prototype');}});
  await expect(readScreenplayNativeIntentForChange(f.client,input,f.host)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(authorize).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();expect(touched).toBe(false);
});

it('captures the complete lookup before invoking host authorization',async()=>{
  const f=await fixture(),input=structuredClone(f.input);f.host.authorize=()=>{input.scope.tenantId='changed';input.target.projectId=f.id('changed-after-capture');input.changeId=f.id('changed-after-capture-request');return true;};
  expect(await readScreenplayNativeIntentForChange(f.client,input,f.host)).toEqual(f.binding);expect(f.query.mock.calls[0]![1]).toEqual([f.target.tenantId,f.target.projectId,f.input.changeId]);
});

it.each(['tenant','project'] as const)('rejects self-consistent committed binding from another ordinary %s',async field=>{
  const f=await fixture(),changed=signed({...f.binding,key:{...f.key,[field==='tenant'?'tenantId':'projectId']:'other-ordinary-scope'}});
  Object.assign(f.state.bindings[0]!,{tenant_id:changed.key.tenantId,project_id:changed.key.projectId,digest:changed.digest,record:changed});
  await expect(readScreenplayNativeIntentForChange(f.client,f.input,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it.each(['tenant','project','change'] as const)('rejects another formal %s lookup receiving an existing foreign binding',async field=>{
  const f=await fixture(),input=structuredClone(f.input);if(field==='tenant')input.target.tenantId=f.id('foreign-formal-tenant');if(field==='project')input.target.projectId=f.id('foreign-formal-project');if(field==='change')input.changeId=f.id('foreign-native-change');
  await expect(readScreenplayNativeIntentForChange(f.client,input,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'binding columns'});
});
it.each(['tenant_id','project_id','candidate_id','formal_tenant_id','formal_project_id','change_id','source_revision','mapping_digest','review_digest','digest'] as const)('preserves real reader STORAGE_FAILED for corrupt %s scalar',async field=>{
  const f=await fixture();f.state.bindings[0]![field]=field==='source_revision'?f.mapping.sourceRevision+1:'corrupt';
  await expect(readScreenplayNativeIntentForChange(f.client,f.input,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'binding columns'});
});
it.each(['target','change','digest'] as const)('rejects corrupted nested binding %s through the real parser',async mode=>{
  const f=await fixture(),raw=f.state.bindings[0]!['record'] as ScreenplayNativeBinding;
  if(mode==='target')raw.mapping.target.projectId=f.id('foreign-body-project');if(mode==='change')raw.mapping.request.id=f.id('foreign-body-change');if(mode==='digest')raw.digest='0'.repeat(64);
  if(mode!=='digest'){raw.mapping=signed(raw.mapping);const changed=signed(raw);Object.assign(f.state.bindings[0]!,{mapping_digest:changed.mapping.digest,digest:changed.digest,record:changed});}
  await expect(readScreenplayNativeIntentForChange(f.client,f.input,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'binding columns'});
});
it('rejects multiple committed bindings instead of choosing one',async()=>{
  const f=await fixture();f.state.bindings.push(structuredClone(f.state.bindings[0]!));await expect(readScreenplayNativeIntentForChange(f.client,f.input,f.host)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'binding cardinality'});
});
it.each(['driver','opaque'] as const)('safely wraps %s storage failures without leaking diagnostics',async mode=>{
  const f=await fixture();f.query.mockRejectedValue(mode==='driver'?new Error('private://database-diagnostic'):new Proxy({},{getPrototypeOf(){throw new Error('private://prototype-trap');}}));
  const error:unknown=await readScreenplayNativeIntentForChange(f.client,f.input,f.host).catch((value:unknown)=>value);expect(error).toMatchObject({code:'STORAGE_FAILED'});expect(String(error)).not.toContain('private://');expect(f.release).not.toHaveBeenCalled();
});
