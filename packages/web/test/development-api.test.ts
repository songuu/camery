import {expect,it,vi} from 'vitest';
import {ApiClient} from '../src/api.js';
import {episodeFixture} from '../../script/test/episode-fixture.js';
function requestUrl(input:RequestInfo|URL){return typeof input==='string'?input:input instanceof URL?input.href:input.url;}
it('uses the authenticated same-origin development paths and bounded schemas',async()=>{
  const brief={version:1 as const,briefId:'idea',revision:1,idea:'港城来信',episodeCount:10,targetSeconds:120,digest:'a'.repeat(64)};
  const view={brief,actorId:'human',createdAt:'2026-11-16T12:00:00.000Z'};
  const transport=vi.fn<typeof fetch>(async(url)=>requestUrl(url).endsWith('/capabilities')?Response.json({canStart:false,modelLabel:null,budget:null,defaultEpisodeCount:10}):requestUrl(url).includes('/briefs?')?Response.json({items:[],nextCursor:null}):Response.json(view));
  const client=new ApiClient(`cmry_${'a'.repeat(43)}`,transport);await client.developmentCapabilities('project');await client.developmentBriefList('project','cursor');expect(await client.developmentBrief('project','idea')).toEqual(view);
  await client.developmentPutBrief('project',{briefId:'idea',expectedRevision:0,idea:brief.idea,episodeCount:10,targetSeconds:120});
  expect(transport.mock.calls.every(([url,init])=>requestUrl(url).startsWith('/api/v1/projects/project/development')&&init?.credentials==='omit'&&new Headers(init.headers).has('authorization'))).toBe(true);
  expect(()=>client.developmentPutBrief('project',{...brief,expectedRevision:0} as never)).toThrow();expect(()=>client.developmentReject('project','run','foundation','')).toThrow();
});
it('supports all public read and review routes, preserves request identities and validates response binding',async()=>{
  const f=episodeFixture();const {tenantId:_tenant,projectId:_project,...brief}=f.brief;const at='2026-11-16T12:00:00.000Z';const summary={runId:'run',briefId:brief.briefId,briefRevision:1,createdAt:at,sourceChanged:false,foundationCandidateDigest:'b'.repeat(64),foundationReviewStatus:null,episodesCandidateDigest:null,episodesReviewStatus:null};
  const status={...summary,stage:'foundation',state:'awaiting_review',task:null};const view={...status,brief,budget:{currency:'CNY',tokens:200,costMicros:0},foundation:{candidate:{digest:'b'.repeat(64),output:f.foundation},review:null},episodes:{candidate:null,review:null}};
  const transport=vi.fn<typeof fetch>(async(input,init)=>{const url=requestUrl(input);if(url.endsWith('/capabilities'))return Response.json({canStart:true,modelLabel:'文本模型',budget:view.budget,defaultEpisodeCount:10});if(/\/briefs(?:\?|$)/.test(url))return Response.json({items:[],nextCursor:null});if(url.includes('/briefs/'))return Response.json({brief,actorId:'human',createdAt:at});if(url.endsWith('/status')||url.endsWith('/development')&&init?.method==='POST')return Response.json(status);if(url.endsWith('/development')||url.includes('/development?'))return Response.json({items:[summary],nextCursor:null});return Response.json(view);});
  const client=new ApiClient(`cmry_${'a'.repeat(43)}`,transport);const signal=new AbortController().signal;
  for(const s of [undefined,signal]){await client.developmentCapabilities('project',s);await client.developmentBriefList('project',undefined,s);await client.developmentList('project',undefined,s);await client.developmentList('project','cursor',s);await client.developmentBrief('project',brief.briefId,s);expect(await client.developmentRead('project','run',s)).toEqual(view);expect(await client.developmentStatus('project','run',s)).toEqual(status);}
  const command={runId:'run',briefId:brief.briefId,expectedRevision:1,expectedBriefDigest:brief.digest};await client.developmentStart('project',command);
  await client.developmentConfirm('project','run','foundation',{candidateDigest:'b'.repeat(64),output:f.foundation});await client.developmentConfirm('project','run','episodes',{candidateDigest:'b'.repeat(64),output:f.output});await client.developmentReject('project','run','episodes','需要修改');
  const posts=transport.mock.calls.filter(([,init])=>init?.method==='POST');expect(posts).toHaveLength(4);expect(JSON.parse(posts[0]![1]!.body as string)).toEqual(command);expect(posts.every(([,init])=>!('tenantId' in JSON.parse(init!.body as string)))).toBe(true);
  const wrong=new ApiClient(`cmry_${'a'.repeat(43)}`,async()=>Response.json({...view,runId:'other'}));await expect(wrong.developmentRead('project','run')).rejects.toMatchObject({code:'BAD_RESPONSE'});await expect(wrong.developmentStatus('project','run')).rejects.toMatchObject({code:'BAD_RESPONSE'});
  const wrongBrief=new ApiClient(`cmry_${'a'.repeat(43)}`,async()=>Response.json({brief:{...brief,briefId:'other'},actorId:'human',createdAt:at}));await expect(wrongBrief.developmentBrief('project',brief.briefId)).rejects.toMatchObject({code:'BAD_RESPONSE'});
});
it('rejects malformed start/confirm/reject commands without sending them',()=>{
  const transport=vi.fn<typeof fetch>();const client=new ApiClient(`cmry_${'a'.repeat(43)}`,transport);const f=episodeFixture();
  expect(()=>client.developmentStart('project',{} as never)).toThrow();expect(()=>client.developmentConfirm('project','run','other' as never,{} as never)).toThrow();expect(()=>client.developmentConfirm('project','run','foundation',{candidateDigest:'bad',output:f.foundation})).toThrow();expect(()=>client.developmentConfirm('project','run','episodes',{candidateDigest:'a'.repeat(64),output:f.foundation} as never)).toThrow();expect(()=>client.developmentReject('project','run','other' as never,'原因')).toThrow();expect(transport).not.toHaveBeenCalled();
});
