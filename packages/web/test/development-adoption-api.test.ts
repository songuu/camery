import {expect,it,vi} from 'vitest';
import {ApiClient} from '../src/api.js';
import type {WorkbenchCandidateDetail} from '@camery/ir/workbench';
function requestUrl(input:RequestInfo|URL){return typeof input==='string'?input:input instanceof URL?input.href:input.url;}
function requestBody(init:RequestInit|undefined){if(typeof init?.body!=='string')throw new Error('Expected JSON body');return init.body;}
const project='01ARZ3NDEKTSV4RRFFQ69G5FAV';
const candidate='01ARZ3NDEKTSV4RRFFQ69G5FAW';
const state={contractVersion:1,projectId:project,projectKey:project,schemaVersion:'0.6.0-draft',snapshotRevision:2,writeVersion:3,actorId:null,canWrite:false,canReview:false,nativePending:0,counts:[]};
const command={applicationId:'request-one',expectedSnapshotRevision:2,expectedWriteVersion:3,runDigest:'a'.repeat(64),briefDigest:'b'.repeat(64),foundationReviewDigest:'c'.repeat(64),episodesReviewDigest:'d'.repeat(64)};
const detail:WorkbenchCandidateDetail={contractVersion:1,projectKey:project,candidateId:candidate,applicationId:command.applicationId,managed:true,status:'candidate',authorId:project,authorKey:'human',createdAt:null,baseRevision:2,baseWriteVersion:3,source:{kind:'development',runId:'run',state:'current'},snapshotRevision:2,writeVersion:4,scope:{kind:'project',id:project},differences:[],issues:[],warnings:[],canAdopt:true,canReject:true,blockingReasons:[],preparation:null};
it('reads strict authenticated envelopes, scopes the candidate list, and rejects an unrelated project response',async()=>{
  const transport=vi.fn<typeof fetch>(async(input)=>Response.json({data:requestUrl(input).includes('/candidates')?{contractVersion:1,items:[],nextCursor:null}:state,requestId:'receipt'}));
  const api=new ApiClient(`cmry_${'a'.repeat(43)}`,transport);
  expect(await api.getWorkbenchState(project)).toEqual(state);
  await api.listWorkbenchCandidates(project,'run-one','cursor here');
  expect(transport.mock.calls[1]?.[0]).toBe(`/api/v1/projects/${project}/workbench/candidates?runId=run-one&cursor=cursor%20here`);
  await api.listWorkbenchCandidates(project);
  expect(transport.mock.calls[2]?.[0]).toBe(`/api/v1/projects/${project}/workbench/candidates`);
  expect(transport.mock.calls[0]?.[1]).toMatchObject({credentials:'omit',mode:'same-origin'});
  expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get('authorization')).toContain('Bearer cmry_');
  const wrong=new ApiClient(`cmry_${'a'.repeat(43)}`,async()=>Response.json({data:{...state,projectKey:candidate},requestId:'receipt'}));
  await expect(wrong.getWorkbenchState(project)).rejects.toMatchObject({code:'BAD_RESPONSE'});
});
it('validates prepared and decision responses, keeps separate stable decision identities, and never invents authority',async()=>{
  const receipt={version:1,changeId:candidate,status:'adopted',snapshotRevision:3,writeVersion:5,issues:[],warnings:[],adoption:null,rejection:null};
  const transport=vi.fn<typeof fetch>(async(input)=>Response.json({data:requestUrl(input).endsWith('/adopt')||requestUrl(input).endsWith('/reject')?receipt:requestUrl(input).endsWith('/schema-upgrade')?{...detail,source:{kind:'manual'}}:detail,requestId:'receipt'}));
  const api=new ApiClient(`cmry_${'a'.repeat(43)}`,transport);const signal=new AbortController().signal;
  expect(await api.prepareDevelopmentCandidate(project,'run',command,signal)).toEqual(detail);
  expect(await api.getWorkbenchCandidate(project,candidate,signal)).toEqual(detail);
  await api.prepareWorkbenchUpgrade(project,{applicationId:'request-one',expectedSnapshotRevision:2,expectedWriteVersion:3},signal);
  const decision={scope:detail.scope,expectedSnapshotRevision:2,expectedWriteVersion:4};
  await api.adoptWorkbenchCandidate(project,candidate,'adopt-identity',decision,signal);
  await api.rejectWorkbenchCandidate(project,candidate,'reject-identity',{...decision,reason:'人物关系仍需核对'},signal);
  expect(transport.mock.calls.slice(-2).map(([,init])=>new Headers(init?.headers).get('Idempotency-Key'))).toEqual(['adopt-identity','reject-identity']);
  expect(transport.mock.calls.filter(([,init])=>init?.method==='POST').every(([,init])=>!('actorId' in JSON.parse(requestBody(init))))).toBe(true);
  for(const response of [{...detail,projectKey:'other'},{...detail,applicationId:'other'},{...detail,source:{kind:'development',runId:'other',state:'current'}}]){
    const wrong=new ApiClient(`cmry_${'a'.repeat(43)}`,async()=>Response.json({data:response,requestId:'receipt'}));await expect(wrong.prepareDevelopmentCandidate(project,'run',command)).rejects.toMatchObject({code:'BAD_RESPONSE'});
  }
  const wrong=new ApiClient(`cmry_${'a'.repeat(43)}`,async()=>Response.json({data:{...receipt,changeId:project},requestId:'receipt'}));await expect(wrong.adoptWorkbenchCandidate(project,candidate,'decision',decision)).rejects.toMatchObject({code:'BAD_RESPONSE'});
});
it('retains only allowlisted matching error codes for new routes and keeps legacy status handling',async()=>{
  const specific=new ApiClient(`cmry_${'a'.repeat(43)}`,async()=>Response.json({code:'SNAPSHOT_STALE',requestId:'receipt'},{status:409}));
  await expect(specific.getWorkbenchState(project)).rejects.toMatchObject({code:'SNAPSHOT_STALE'});
  await expect(specific.developmentCapabilities(project)).rejects.toMatchObject({code:'CONFLICT'});
  for(const body of [{code:'LEAK_INTERNAL_DETAILS',requestId:'receipt'},{code:'SNAPSHOT_STALE',requestId:'receipt',debug:'secret'},{}]){
    const unsafe=new ApiClient(`cmry_${'a'.repeat(43)}`,async()=>Response.json(body,{status:403}));await expect(unsafe.getWorkbenchState(project)).rejects.toMatchObject({code:'FORBIDDEN'});
  }
});
it('rejects injected approval fields before sending and binds write keys to the submitted identity',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>new Response(null,{status:409}));const api=new ApiClient(`cmry_${'a'.repeat(43)}`,transport);
  expect(()=>api.prepareDevelopmentCandidate(project,'run',{...command,actorId:project} as never)).toThrow();
  expect(()=>api.adoptWorkbenchCandidate(project,candidate,'decision',{scope:{kind:'project',id:project},expectedSnapshotRevision:2,expectedWriteVersion:3,canAdopt:true} as never)).toThrow();
  expect(()=>api.prepareWorkbenchUpgrade(project,{applicationId:'upgrade',expectedSnapshotRevision:2,expectedWriteVersion:3,actorId:project} as never)).toThrow();
  expect(()=>api.rejectWorkbenchCandidate(project,candidate,'reject',{scope:{kind:'project',id:project},expectedSnapshotRevision:2,expectedWriteVersion:3,reason:'还需调整',reviewerId:project} as never)).toThrow();
  expect(transport).not.toHaveBeenCalled();
  for(let i=0;i<2;i++)await expect(api.prepareDevelopmentCandidate(project,'run',command)).rejects.toMatchObject({code:'CONFLICT'});
  expect(transport.mock.calls.map(([,init])=>new Headers(init?.headers).get('Idempotency-Key'))).toEqual(['request-one','request-one']);
  expect(transport.mock.calls.map(([,init])=>JSON.parse(requestBody(init)))).toEqual([command,command]);
  expect(transport.mock.calls[0]?.[1]?.body).toBe(transport.mock.calls[1]?.[1]?.body);
});
