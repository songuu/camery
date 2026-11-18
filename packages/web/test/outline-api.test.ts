import {expect,it,vi} from 'vitest';
import {ApiClient} from '../src/api.js';
import {outlineFixture} from '../../script/test/outline-support.js';
import {captureRuleThresholds,reviewOutlineCraft} from '@camery/script/outline';
import type {OutlineRunView,OutlineSourceSelection,OutlineStatus} from '@camery/script/outline/http';
import {OutlineCraftReportSchema} from '@camery/script/outline/http';

const hash='a'.repeat(64),at='2026-11-18T02:00:00.000Z',token=`cmry_${'b'.repeat(43)}`;
function fixture(){
  const f=outlineFixture();const {sourceRefIds,...context}=f.context;
  const brief={...context,version:1 as const,briefId:'brief',revision:1,notes:'改编说明',thresholds:captureRuleThresholds(),profiles:[{id:'rebirth-revenge' as const,version:1 as const,digest:hash}],digest:hash};
  const source:OutlineSourceSelection={kind:'development',runId:'original',runDigest:hash,briefDigest:hash,foundationReviewDigest:hash,episodesReviewDigest:hash};
  const status:OutlineStatus={runId:'run',runDigest:hash,briefId:'brief',briefRevision:1,createdAt:at,candidateDigest:hash,reviewStatus:null,sourceChanged:false,state:'awaiting_review',task:null};
  const report=OutlineCraftReportSchema.parse(reviewOutlineCraft(f.context,f.output));
  const view:OutlineRunView={...status,brief,source:{version:1,descriptor:source,material:{title:'原始故事'},references:sourceRefIds.map(id=>({id,path:id})),digest:hash},candidate:{digest:hash,output:f.output,report},review:null};
  const write={...context,briefId:'brief',expectedRevision:0,notes:brief.notes};const start={runId:'run',briefId:'brief',expectedRevision:1,expectedBriefDigest:hash,source};
  const decision={candidateDigest:hash,output:f.output,ablations:[{genre:'suspense' as const,judgment:'participates' as const,reason:'查证参与推进主线'}],waivers:[]};
  const reviewed:OutlineRunView={...view,state:'reviewed',reviewStatus:'reviewed',review:{status:'reviewed',digest:hash,actorId:'reviewer',at,report,...decision}};
  return {f,brief,source,status,view,write,start,decision,reviewed};
}
function urlOf(input:RequestInfo|URL){return typeof input==='string'?input:input instanceof URL?input.href:input.url;}
it('uses authenticated fixed GET routes, validates queries, and preserves cancellation without starting a task',async()=>{
  const f=fixture();const transport=vi.fn<typeof fetch>(async input=>{
    const url=urlOf(input);if(url.endsWith('/capabilities'))return Response.json({canStart:false,modelLabel:null,budget:null,defaultEpisodeCount:10,formalAdoption:false});
    if(url.includes('/sources?'))return Response.json({items:[{source:f.source,createdAt:at}],nextCursor:null});
    if(url.includes('/briefs/'))return Response.json({brief:f.brief,actorId:'editor',createdAt:at});
    if(url.endsWith('/status'))return Response.json(f.status);if(url.endsWith('/run'))return Response.json(f.view);
    return Response.json({items:[],nextCursor:null});
  });const client=new ApiClient(token,transport),signal=new AbortController().signal;
  for(const cancel of [undefined,signal]){await client.outlineCapabilities('project',cancel);await client.outlineBriefList('project',undefined,cancel);await client.outlineBriefList('project','a&b',cancel);await client.outlineSources('project','development',undefined,cancel);await client.outlineList('project',undefined,cancel);await client.outlineList('project','a&b',cancel);expect(await client.outlineBrief('project','brief',undefined,cancel)).toMatchObject({brief:f.brief});await client.outlineBrief('project','brief',1,cancel);expect(await client.outlineStatus('project','run',cancel)).toEqual(f.status);expect(await client.outlineRead('project','run',cancel)).toEqual(f.view);}
  expect(transport.mock.calls.every(([url,init])=>urlOf(url).startsWith('/api/v1/projects/project/outlines')&&init?.method===undefined&&init?.body===undefined&&init?.credentials==='omit'&&init.mode==='same-origin'&&init.redirect==='error'&&init.referrerPolicy==='no-referrer'&&init.cache==='no-store'&&new Headers(init.headers).get('Authorization')===`Bearer ${token}`)).toBe(true);
  expect(transport.mock.calls.some(([url])=>urlOf(url).endsWith('/briefs?cursor=a%26b'))).toBe(true);expect(transport.mock.calls.some(([url])=>urlOf(url).endsWith('/briefs/brief?revision=1'))).toBe(true);expect(transport.mock.calls.some(([,init])=>init?.signal instanceof AbortSignal)).toBe(true);
});
it('discovers Bible sources with an encoded cursor, rejecting a response from the other source catalog',async()=>{
  const bible={kind:'bible' as const,runId:'bible',runDigest:hash,documentId:'novel',revision:1,sourceDigest:hash,reviewDigest:hash};
  const transport=vi.fn<typeof fetch>(async()=>Response.json({items:[{source:bible,createdAt:at}],nextCursor:'next'})),client=new ApiClient(token,transport);
  expect((await client.outlineSources('project','bible','a?&')).items[0]!.source).toEqual(bible);expect(urlOf(transport.mock.calls[0]![0])).toBe('/api/v1/projects/project/outlines/sources?kind=bible&cursor=a%3F%26');
  await expect(client.outlineSources('project','development')).rejects.toMatchObject({code:'BAD_RESPONSE'});
});
it('writes exact brief revisions and repeats the same start command without inventing another identity',async()=>{
  const f=fixture(),transport=vi.fn<typeof fetch>(async input=>Response.json(urlOf(input).endsWith('/briefs')?{brief:f.brief,actorId:'editor',createdAt:at}:f.status)),client=new ApiClient(token,transport);
  await client.outlineSaveBrief('project',f.write);await client.outlineStart('project',f.start);await client.outlineStart('project',f.start);
  expect(transport.mock.calls.map(([,init])=>JSON.parse(init!.body as string))).toEqual([f.write,f.start,f.start]);expect(transport.mock.calls.every(([,init])=>init?.method==='POST'&&new Headers(init.headers).get('Content-Type')==='application/json')).toBe(true);
});
it('sends explicit confirm and reject decisions and binds the returned human audit to the request',async()=>{
  const f=fixture(),rejected={...f.view,state:'rejected',reviewStatus:'rejected',review:{status:'rejected',digest:hash,candidateDigest:hash,actorId:'reviewer',at,reason:'仍需修改'}};
  const transport=vi.fn<typeof fetch>(async input=>Response.json(urlOf(input).endsWith('/confirm')?f.reviewed:rejected)),client=new ApiClient(token,transport);
  expect(await client.outlineConfirm('project','run',f.decision)).toEqual(f.reviewed);expect(await client.outlineReject('project','run','仍需修改')).toEqual(rejected);
  expect(transport.mock.calls.map(([input,init])=>({url:urlOf(input),body:JSON.parse(init!.body as string)}))).toEqual([{url:'/api/v1/projects/project/outlines/run/confirm',body:f.decision},{url:'/api/v1/projects/project/outlines/run/reject',body:{reason:'仍需修改'}}]);
});
it('rejects malformed scope, revision, cursor, source kind and commands before any transport call',()=>{
  const transport=vi.fn<typeof fetch>(),client=new ApiClient(token,transport),f=fixture();
  for(const run of [()=>client.outlineCapabilities('../project'),()=>client.outlineBriefList('project',''),()=>client.outlineList('project','x'.repeat(513)),()=>client.outlineBrief('project','brief',0),()=>client.outlineBrief('project','brief',1.5),()=>client.outlineBrief('project','brief',Number.MAX_SAFE_INTEGER+1),()=>client.outlineSources('project','other' as never),()=>client.outlineSources('project','bible',''),()=>client.outlineSaveBrief('project',{...f.write,tenantId:'other'} as never),()=>client.outlineStart('project',{...f.start,actorId:'injected'} as never),()=>client.outlineStart('project',{...f.start,source:{...f.source,projectId:'other'}} as never),()=>client.outlineConfirm('project','run',{...f.decision,actorId:'injected'} as never),()=>client.outlineReject('project','run','')])expect(run).toThrow();
  let getterCalls=0;const command={...f.start};Object.defineProperty(command,'runId',{get(){getterCalls++;return 'run';},enumerable:true});expect(()=>client.outlineStart('project',command)).toThrow();expect(getterCalls).toBe(0);expect(transport).not.toHaveBeenCalled();
});
it('rejects mismatched run, brief revision, start binding and unexpected response properties',async()=>{
  const f=fixture();const wrong=(body:unknown)=>new ApiClient(token,async()=>Response.json(body));
  await expect(wrong({...f.view,runId:'other'}).outlineRead('project','run')).rejects.toMatchObject({code:'BAD_RESPONSE'});await expect(wrong({...f.status,runId:'other'}).outlineStatus('project','run')).rejects.toMatchObject({code:'BAD_RESPONSE'});
  await expect(wrong({brief:{...f.brief,briefId:'other'},actorId:'editor',createdAt:at}).outlineBrief('project','brief')).rejects.toMatchObject({code:'BAD_RESPONSE'});
  await expect(wrong({brief:{...f.brief,revision:2},actorId:'editor',createdAt:at}).outlineBrief('project','brief',1)).rejects.toMatchObject({code:'BAD_RESPONSE'});await expect(wrong({brief:{...f.brief,revision:2},actorId:'editor',createdAt:at}).outlineSaveBrief('project',f.write)).rejects.toMatchObject({code:'BAD_RESPONSE'});await expect(wrong({brief:{...f.brief,briefId:'other'},actorId:'editor',createdAt:at}).outlineSaveBrief('project',f.write)).rejects.toMatchObject({code:'BAD_RESPONSE'});
  for(const body of [{...f.status,runId:'other'},{...f.status,briefId:'other'},{...f.status,briefRevision:2}])await expect(wrong(body).outlineStart('project',f.start)).rejects.toMatchObject({code:'BAD_RESPONSE'});
  await expect(wrong({...f.view,execution:{token:'private'}}).outlineRead('project','run')).rejects.toMatchObject({code:'BAD_RESPONSE'});
});
it('rejects success responses without the requested candidate audit and edited decision',async()=>{
  const f=fixture();for(const body of [f.view,{...f.reviewed,runId:'other'},{...f.reviewed,candidate:null},{...f.reviewed,candidate:{...f.reviewed.candidate,digest:'b'.repeat(64)}},{...f.reviewed,review:null},{...f.reviewed,review:{...f.reviewed.review,candidateDigest:'b'.repeat(64)}},{...f.reviewed,review:{...f.reviewed.review,output:{...f.f.output,adaptation:{...f.f.output.adaptation,title:'other'}}}},{...f.reviewed,review:{...f.reviewed.review,ablations:[{...f.decision.ablations[0],reason:'different'}]}}]){
    const client=new ApiClient(token,async()=>Response.json(body));await expect(client.outlineConfirm('project','run',f.decision)).rejects.toMatchObject({code:'BAD_RESPONSE'});
  }
  await expect(new ApiClient(token,async()=>Response.json(f.reviewed)).outlineReject('project','run','仍需修改')).rejects.toMatchObject({code:'BAD_RESPONSE'});
  const rejected={...f.view,state:'rejected',reviewStatus:'rejected',review:{status:'rejected',digest:hash,candidateDigest:hash,actorId:'reviewer',at,reason:'其他理由'}};
  await expect(new ApiClient(token,async()=>Response.json(rejected)).outlineReject('project','run','仍需修改')).rejects.toMatchObject({code:'BAD_RESPONSE'});await expect(new ApiClient(token,async()=>Response.json({...rejected,runId:'other'})).outlineReject('project','run','其他理由')).rejects.toMatchObject({code:'BAD_RESPONSE'});
});
it('accepts the domain canonical order of located waivers while refusing changed human reasons',async()=>{
  const f=fixture();f.f.output.episodes.forEach(episode=>{episode.openingHook.estimatedSecond=40;});const report=OutlineCraftReportSchema.parse(reviewOutlineCraft(f.f.context,f.f.output));
  const waivers=report.issues.filter(issue=>issue.code!=='ABLATION_REVIEW').map(issue=>({issueId:issue.id,reason:`人工保留 ${issue.id}`}));expect(waivers.length).toBeGreaterThan(1);
  const decision={...f.decision,waivers:[...waivers].reverse()};const view={...f.reviewed,review:{...f.reviewed.review!,status:'reviewed' as const,digest:hash,candidateDigest:hash,actorId:'reviewer',at,output:decision.output,report,ablations:decision.ablations,waivers}};
  expect(await new ApiClient(token,async()=>Response.json(view)).outlineConfirm('project','run',decision)).toEqual(view);
  const altered={...decision,waivers:decision.waivers.map(item=>({...item,reason:'different'}))};await expect(new ApiClient(token,async()=>Response.json(view)).outlineConfirm('project','run',altered)).rejects.toMatchObject({code:'BAD_RESPONSE'});
});
it('preserves complete outputs above 256KiB and detail envelopes above 2MiB',async()=>{
  const f=fixture(),output=structuredClone(f.f.output);
  output.assets=Array.from({length:128},(_,index)=>({...output.assets[0]!,id:`asset-${index}`,description:'x'.repeat(1000),narrativeRole:'y'.repeat(1000)}));
  const report={...f.view.candidate!.report,issues:Array.from({length:400},(_,index)=>({id:`issue-${index}`,code:'LOW_EMOTION' as const,path:'episodes',episodeNumbers:[1],detail:'z'.repeat(2000)}))};
  const decision={...f.decision,output,waivers:report.issues.map(issue=>({issueId:issue.id,reason:'w'.repeat(1000)}))};
  const view={...f.reviewed,source:{...f.view.source,material:{text:'s'.repeat(400000)}},candidate:{digest:hash,output,report},review:{...f.reviewed.review!,...decision,status:'reviewed' as const,digest:hash,actorId:'reviewer',at,report}};
  expect(new TextEncoder().encode(JSON.stringify(output)).length).toBeGreaterThan(262144);expect(new TextEncoder().encode(JSON.stringify(view)).length).toBeGreaterThan(2097152);
  const transport=vi.fn<typeof fetch>(async()=>Response.json(view)),client=new ApiClient(token,transport);expect(await client.outlineRead('project','run')).toEqual(view);expect(await client.outlineConfirm('project','run',decision)).toEqual(view);
  const oversized={...decision,output:{...output,assets:Array.from({length:256},(_,index)=>({...output.assets[0]!,id:`asset-${index}`}))}};
  expect(()=>client.outlineConfirm('project','run',oversized)).toThrow();expect(transport).toHaveBeenCalledTimes(2);
});
