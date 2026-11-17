import {expect,it,vi} from 'vitest';
import {createVersionState,submitChangeSet,adoptChangeSet} from '@camery/versioning';
import {upgradeV05Package} from '@camery/ir';
import type {ChangeSet} from '@camery/ir';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';
import {ProjectApplication} from '../src/projects/application.js';
import {ProjectApplicationError} from '../src/projects/intent-contracts.js';
import {ProjectIdentityError} from '../src/projects/contracts.js';
import type {ProjectApplicationOptions} from '../src/projects/options.js';
import type {ProjectReadStore} from '../src/projects/read-store.js';

const target={tenantId:id('read-tenant'),projectId:id('prj_demo')};const actor={kind:'user' as const,id:id('user_1')};
const subject=(role:'admin'|'viewer'='viewer')=>({tenantId:'tenant',userId:'user',sessionId:'session',grants:[{projectId:'project',role}]});
function fixture(){
  let state=createVersionState(upgradeV05Package(makePackage()));let writeVersion=1;
  const identities={resolveProject:vi.fn(async()=>({tenantId:'tenant',projectId:'project',versionKey:target})),resolvePrincipal:vi.fn(async()=>({tenantId:'tenant',kind:'user',key:'user',principal:actor})),resolve:vi.fn()};
  const reads={head:vi.fn(async()=>structuredClone({head:state.head,writeVersion,pendingCount:state.changes.filter(row=>row.status==='candidate').length})),history:vi.fn<ProjectReadStore['history']>(async input=>{if(input.expectedRevision!==state.head.revision.number)throw new ProjectApplicationError('SNAPSHOT_STALE','memory history');return structuredClone({snapshotRevision:state.head.revision.number,writeVersion,items:state.revisions.filter(row=>row.object_id===input.objectId&&row.collection===input.collection&&row.snapshot_revision<=input.expectedRevision&&(input.beforeVersion===undefined||row.version<input.beforeVersion)).sort((a,b)=>b.version-a.version).slice(0,input.limit)});})};
  const versions={read:vi.fn(),submitWithReceipt:vi.fn(),adoptGuarded:vi.fn(),rejectWithReceipt:vi.fn()};const newId=vi.fn();const application=new ProjectApplication({tenantId:'tenant',identities,reads,versions,newId} as unknown as ProjectApplicationOptions);
  const adopt=(request:ChangeSet)=>{const submitted=submitChangeSet(state,request);const result=adoptChangeSet(submitted.state,request.id,{actor,scope:{kind:'project',id:target.projectId},at:'2026-11-17T09:00:00.000Z',authorize:()=>true});expect(result.status,result.issues.map(issue=>issue.message).join(',')).toBe('adopted');state=result.state;writeVersion+=2;};
  return {application,identities,reads,versions,newId,getState:()=>state,adopt};
}
it('reads adopted content and capabilities without full version state, writes, IDs or model work',async()=>{
  const f=fixture();const result=await f.application.readSnapshot({subject:subject(),projectId:'project',command:{limit:2}});expect(result.rows).toHaveLength(2);expect(result.projectKey).toBe('project');expect(result.snapshotRevision).toBe(5);expect(result.capabilities).toEqual({canWrite:false,canReview:false,canReadMedia:false});expect(f.versions.read).not.toHaveBeenCalled();expect(f.newId).not.toHaveBeenCalled();
  expect((await f.application.state({subject:subject(),projectId:'project'})).nativePending).toBe(0);expect(f.versions.read).not.toHaveBeenCalled();
});
it('rejects denied tenant and project access before resolving mappings or reading data',async()=>{
  const f=fixture();for(const input of [{subject:{...subject(),tenantId:'other'},projectId:'project'},{subject:subject(),projectId:'other'}]){
    await expect(f.application.readSnapshot({...input,command:{}})).rejects.toMatchObject({code:'FORBIDDEN'});await expect(f.application.readObjectHistory({...input,collection:'shots',objectId:id('sh_1'),command:{}})).rejects.toMatchObject({code:'FORBIDDEN'});await expect(f.application.readReadyAsset({...input,assetId:id('asset'),version:1,command:{}})).rejects.toMatchObject({code:'FORBIDDEN'});
  }expect(f.identities.resolveProject).not.toHaveBeenCalled();expect(f.reads.head).not.toHaveBeenCalled();
});
it('returns a typed missing snapshot or binding fault and permits read-only unmapped viewers',async()=>{
  const f=fixture();f.reads.head.mockResolvedValueOnce(null as never);await expect(f.application.readSnapshot({subject:subject(),projectId:'project',command:{}})).rejects.toMatchObject({code:'NOT_FOUND'});
  f.identities.resolvePrincipal.mockRejectedValueOnce(new ProjectIdentityError('PRINCIPAL_BINDING_MISSING','test'));expect((await f.application.readSnapshot({subject:subject('admin'),projectId:'project',command:{}})).capabilities.canWrite).toBe(false);
  f.identities.resolveProject.mockResolvedValueOnce({tenantId:'tenant',projectId:'project',versionKey:{...target,projectId:id('other-project')}});await expect(f.application.readSnapshot({subject:subject(),projectId:'project',command:{}})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('pins every snapshot page and rejects old cursors after a formal adoption',async()=>{
  const f=fixture();const first=await f.application.readSnapshot({subject:subject(),projectId:'project',command:{limit:1}});expect(first.nextCursor).toBeTypeOf('string');
  f.adopt(changeSet([{op:'update',op_id:id('read-op'),collection:'shots',target:id('sh_1'),set:{action:'已正式更新'}}],{schema_version:'0.6.0-draft',base_revisions:[{id:id('sh_1'),version:1}]}));
  await expect(f.application.readSnapshot({subject:subject(),projectId:'project',command:{cursor:first.nextCursor,limit:1}})).rejects.toMatchObject({code:'SNAPSHOT_STALE'});expect((await f.application.readSnapshot({subject:subject(),projectId:'project',command:{}})).snapshotRevision).toBe(6);
});
it('paginates actual object history and binds the cursor to subject, collection, object and snapshot',async()=>{
  const f=fixture();f.adopt(changeSet([{op:'update',op_id:id('history-op'),collection:'shots',target:id('sh_1'),set:{action:'新动作'}}],{schema_version:'0.6.0-draft',base_revisions:[{id:id('sh_1'),version:1}]}));const input={subject:subject(),projectId:'project',collection:'shots',objectId:id('sh_1')};
  const first=await f.application.readObjectHistory({...input,command:{limit:1}});expect(first.items[0]).toMatchObject({ref:{version:2},snapshotRevision:6,deleted:false,value:{action:'新动作'}});expect(first.nextCursor).toBeTypeOf('string');
  const second=await f.application.readObjectHistory({...input,command:{limit:1,cursor:first.nextCursor,expectedRevision:6}});expect(second.items[0]).toMatchObject({ref:{version:1},snapshotRevision:5});expect(second.nextCursor).toBeNull();
  for(const changed of [{objectId:id('other')},{collection:'lines'},{subject:{...subject(),userId:'other'}}])await expect(f.application.readObjectHistory({...input,...changed,command:{cursor:first.nextCursor}})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.application.readObjectHistory({...input,command:{cursor:first.nextCursor,expectedRevision:5}})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
it('does not fabricate an object history or a successful media handle from a ready metadata row',async()=>{
  const f=fixture();await expect(f.application.readObjectHistory({subject:subject(),projectId:'project',collection:'shots',objectId:id('absent'),command:{}})).rejects.toMatchObject({code:'NOT_FOUND'});
  const asset=f.getState().head.assets[0]!;expect(asset).toBeDefined();await expect(f.application.readReadyAsset({subject:subject(),projectId:'project',assetId:asset.id,version:asset.version,command:{expectedRevision:5}})).rejects.toMatchObject({code:'ASSET_NOT_READY'});
  const history=await f.application.readObjectHistory({subject:subject(),projectId:'project',collection:'assets',objectId:asset.id,command:{}});expect(JSON.stringify(history)).not.toContain('"path"');
  await expect(f.application.readReadyAsset({subject:subject(),projectId:'project',assetId:asset.id,version:asset.version+1,command:{}})).rejects.toMatchObject({code:'NOT_FOUND'});await expect(f.application.readReadyAsset({subject:subject(),projectId:'project',assetId:asset.id,version:asset.version,command:{expectedRevision:4}})).rejects.toMatchObject({code:'SNAPSHOT_STALE'});
});
it('captures history route and query before an asynchronous identity lookup yields',async()=>{
  const f=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.identities.resolveProject.mockImplementation(async()=>{await gate;return {tenantId:'tenant',projectId:'project',versionKey:target};});
  const input={subject:subject(),projectId:'project',collection:'shots',objectId:id('sh_1'),command:{expectedRevision:5,limit:1}};const operation=f.application.readObjectHistory(input);input.objectId=id('mutated');input.projectId='other';input.command.expectedRevision=99;release();
  await expect(operation).resolves.toMatchObject({projectKey:'project',objectId:id('sh_1'),snapshotRevision:5});expect(f.reads.history).toHaveBeenCalledWith(expect.objectContaining({objectId:id('sh_1'),expectedRevision:5}));
});
it('preserves complete history values while shrinking by response bytes and rejects an individually oversized version',async()=>{
  const f=fixture();const shot=f.getState().head.shots.find(row=>row.id===id('sh_1'))!;const record=(version:number,size:number)=>({collection:'shots',object_id:shot.id,version,parent_version:version===1?null:version-1,snapshot_revision:5,change_set_id:version===1?null:id('large-history'),value:{...shot,version,action:'a'.repeat(size)}});
  f.reads.history.mockResolvedValueOnce({snapshotRevision:5,writeVersion:1,items:[record(2,600000),record(1,600000)]});const page=await f.application.readObjectHistory({subject:subject(),projectId:'project',collection:'shots',objectId:shot.id,command:{limit:2,expectedRevision:5}});expect(page.items).toHaveLength(1);expect(page.items[0]!.value?.['action']).toHaveLength(600000);expect(page.nextCursor).not.toBeNull();
  f.reads.history.mockResolvedValueOnce({snapshotRevision:5,writeVersion:1,items:[record(2,1000000)]});await expect(f.application.readObjectHistory({subject:subject(),projectId:'project',collection:'shots',objectId:shot.id,command:{expectedRevision:5}})).rejects.toMatchObject({code:'INPUT_LIMIT'});
});
it('handles missing or changed history headers and validates the actual asset record before reporting unavailability',async()=>{
  const f=fixture();const input={subject:subject(),projectId:'project',collection:'shots',objectId:id('sh_1'),command:{expectedRevision:5}};f.reads.history.mockResolvedValueOnce(null);await expect(f.application.readObjectHistory(input)).rejects.toMatchObject({code:'NOT_FOUND'});
  f.reads.history.mockResolvedValueOnce({snapshotRevision:6,writeVersion:2,items:[]});await expect(f.application.readObjectHistory(input)).rejects.toMatchObject({code:'SNAPSHOT_STALE'});
  const asset=f.getState().head.assets[0]!;const assetInput={subject:subject(),projectId:'project',assetId:asset.id,version:1,command:{}};const row={collection:'assets',object_id:asset.id,version:1,parent_version:null,snapshot_revision:5,change_set_id:null,value:{...asset,version:1}};
  f.reads.history.mockResolvedValueOnce({snapshotRevision:5,writeVersion:1,items:[{...row,value:{...row.value,media_type:'invalid'}}]});await expect(f.application.readReadyAsset(assetInput)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  f.reads.history.mockResolvedValueOnce({snapshotRevision:5,writeVersion:1,items:[{...row,value:null}]});await expect(f.application.readReadyAsset(assetInput)).rejects.toMatchObject({code:'NOT_FOUND'});
  f.reads.history.mockResolvedValueOnce({snapshotRevision:5,writeVersion:1,items:[{...row,version:Number.MAX_SAFE_INTEGER,value:{...asset,version:Number.MAX_SAFE_INTEGER}}]});await expect(f.application.readReadyAsset({...assetInput,version:Number.MAX_SAFE_INTEGER})).rejects.toMatchObject({code:'ASSET_NOT_READY'});expect(f.reads.history.mock.calls.at(-1)![0]).not.toHaveProperty('beforeVersion');
});
