import {expect,it,vi} from 'vitest';
import {ApiClient} from '../src/api.js';
import type {WorkbenchSnapshot,WorkbenchObjectHistory} from '@camery/ir/workbench';
const id='01ARZ3NDEKTSV4RRFFQ69G5FAV';const other='01ARZ3NDEKTSV4RRFFQ69G5FAW';
const snapshot:WorkbenchSnapshot={contractVersion:1,projectKey:'project',projectId:id,schemaVersion:'0.6.0-draft',snapshotRevision:8,writeVersion:12,scope:{kind:'episode',id:other},renditionId:null,nextCursor:null,counts:[],capabilities:{canWrite:false,canReview:false,canReadMedia:false},rows:[{ref:{collection:'episodes',id:other,version:2},role:'owned',value:{id:other,version:2,title:'夜航'}}],relations:[],lineage:[],locks:[]};
const history:WorkbenchObjectHistory={contractVersion:1,projectKey:'project',projectId:id,collection:'episodes',objectId:other,snapshotRevision:8,writeVersion:12,nextCursor:null,items:[{ref:{collection:'episodes',id:other,version:2},parentVersion:1,snapshotRevision:8,changeId:id,deleted:false,value:{id:other,version:2,title:'夜航'}}]};
it('encodes explicit snapshot/history scopes and sends the same-origin credential only to authenticated paths',async()=>{
  const transport=vi.fn<typeof fetch>(async(input)=>Response.json({data:typeof input==='string'&&input.includes('/history')?history:snapshot,requestId:'receipt'}));const api=new ApiClient(`cmry_${'a'.repeat(43)}`,transport);
  expect(await api.readWorkbenchSnapshot('project',{episodeId:other,collection:'episodes',expectedRevision:8,cursor:'a /?'})).toEqual(snapshot);
  expect(transport.mock.calls[0]?.[0]).toBe(`/api/v1/projects/project/workbench?episodeId=${other}&collection=episodes&expectedRevision=8&cursor=a%20%2F%3F`);
  expect(await api.readWorkbenchObjectHistory('project','episodes',other,{expectedRevision:8})).toEqual(history);
  expect(transport.mock.calls[1]?.[0]).toBe(`/api/v1/projects/project/workbench/objects/episodes/${other}/history?expectedRevision=8`);
  expect(transport.mock.calls[0]?.[1]).toMatchObject({credentials:'omit',mode:'same-origin',redirect:'error'});expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get('authorization')).toContain('Bearer cmry_');
  expect(()=>api.readWorkbenchSnapshot('project',{episodeId:'../escape'})).toThrow();expect(()=>api.readWorkbenchObjectHistory('project','unknown' as never,other,{})).toThrow();
  expect(()=>api.readWorkbenchSnapshot('project',{canReadMedia:true} as never)).toThrow();
  expect(()=>api.checkWorkbenchReadyAsset('project',id,0)).toThrow();
});
it('rejects cross-project, mismatched range/version and historical object responses before the UI can display them',async()=>{
  for(const response of [{...snapshot,projectKey:'other'},{...snapshot,scope:{kind:'scene',id:other}},{...snapshot,snapshotRevision:9},{...snapshot,capabilities:{...snapshot.capabilities,canReadMedia:true}},{...snapshot,rows:[{...snapshot.rows[0],ref:{collection:'episodes',id:other,version:3}}]}]){
    const api=new ApiClient(`cmry_${'a'.repeat(43)}`,async()=>Response.json({data:response,requestId:'receipt'}));await expect(api.readWorkbenchSnapshot('project',{episodeId:other,expectedRevision:8})).rejects.toMatchObject({code:'BAD_RESPONSE'});
  }
  for(const response of [{...history,objectId:id},{...history,items:[{...history.items[0],ref:{collection:'scenes',id:other,version:2}}]}]){
    const api=new ApiClient(`cmry_${'a'.repeat(43)}`,async()=>Response.json({data:response,requestId:'receipt'}));await expect(api.readWorkbenchObjectHistory('project','episodes',other,{})).rejects.toMatchObject({code:'BAD_RESPONSE'});
  }
});
it('reports media as unavailable and refuses fake successful media payloads',async()=>{
  const api=new ApiClient(`cmry_${'a'.repeat(43)}`,async()=>Response.json({code:'ASSET_NOT_READY',requestId:'receipt'},{status:409}));await expect(api.checkWorkbenchReadyAsset('project',id,2,8)).rejects.toMatchObject({code:'ASSET_NOT_READY'});
  const fake=new ApiClient(`cmry_${'a'.repeat(43)}`,async()=>Response.json({data:{url:'file:///secret.png'},requestId:'receipt'}));await expect(fake.checkWorkbenchReadyAsset('project',id,2)).rejects.toMatchObject({code:'BAD_RESPONSE'});
});
