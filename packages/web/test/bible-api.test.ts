import { describe,expect,it,vi } from 'vitest';
import { createSourcePage } from '@camery/ingest';
import { captureSource } from '@camery/bible';
import { projectBibleRun } from '@camery/bible/node';
import { reviewFixture } from '../../bible/test/review-support.js';
import { ApiClient } from '../src/api.js';
const token=`cmry_${'a'.repeat(43)}`;
function requestUrl(input:RequestInfo|URL){return typeof input==='string'?input:input instanceof URL?input.href:input.url;}
function data(){
  const f=reviewFixture();const execution={currency:'CNY',limits:{tokens:100,costMicros:0}};
  // A validated fixture is projected on the server; the browser sees the public transport contract only.
  const view=projectBibleRun({run:{tenantId:'tenant',projectId:'project',runId:'run',source:captureSource(f.source),plan:f.plan,method:f.candidate.method,execution:execution as never,digest:'a'.repeat(64),createdAt:f.host.at},records:f.candidate.records,candidate:f.candidate,review:null},true,null);
  const {current:_current,candidate:_candidate,review:_review,budget:_budget,...status}=view;
  const {state:_state,task:_task,...summary}=status;
  return {f,view,status,summary,page:createSourcePage({documentId:'book',title:'提取时原文',kind:'novel',revision:1,document:f.source.document})};
}
describe('Bible browser transport',()=>{
  it('uses only authenticated same-origin requests and strict bounded public DTOs',async()=>{
    const {f,view,status,summary,page}=data();
    const transport=vi.fn<typeof fetch>(async(input,init)=>{
      const url=requestUrl(input);
      if(url.endsWith('/capabilities'))return Response.json({canStart:false,modelLabel:null,budget:null});
      if(url.includes('/source?'))return Response.json(page);
      if(url.endsWith('/status')||init?.method==='POST'&&url.endsWith('/bibles'))return Response.json(status);
      if(url.endsWith('/bibles')||url.includes('?cursor='))return Response.json({items:[summary],nextCursor:null});
      return Response.json(view);
    });
    const client=new ApiClient(token,transport);const signal=new AbortController().signal;
    for(const provided of [undefined,signal]){
      await client.bibleCapabilities('project',provided);await client.bibleList('project',undefined,provided);await client.bibleList('project','opaque',provided);
      expect(await client.bibleRead('project','run',provided)).toEqual(view);expect(await client.bibleStatus('project','run',provided)).toEqual(status);
      await client.bibleSource('project','run',0,provided);await client.bibleSource('project','run',12000,provided,'before');
    }
    await client.bibleSource('project','run');
    const command={runId:'run',documentId:'book',kind:'novel' as const,expectedRevision:1,expectedSourceDigest:f.plan.source.sourceDigest};
    await client.bibleStart('project',command);await client.bibleConfirm('project','run',f.decision);await client.bibleReject('project','run','需要核对');
    expect(transport.mock.calls.every(([url,init])=>requestUrl(url).startsWith('/api/v1/projects/project/bibles')&&init?.credentials==='omit'&&new Headers(init.headers).get('authorization')===`Bearer ${token}`)).toBe(true);
    expect(transport.mock.calls.some(([url])=>requestUrl(url).endsWith('source?before=12000'))).toBe(true);
    for(const [,init] of transport.mock.calls.filter(([,init])=>init?.method==='POST'))expect(JSON.parse(init!.body as string)).not.toHaveProperty('tenantId');
  });
  it('rejects invalid requests, injected decisions and oversized/malformed responses',async()=>{
    const client=new ApiClient(token,async()=>Response.json({}));const {f}=data();
    expect(()=>client.bibleStart('project',{} as never)).toThrow();expect(()=>client.bibleConfirm('project','run',{...f.decision,approved:true} as never)).toThrow();
    expect(()=>client.bibleReject('project','run','')).toThrow();expect(()=>client.bibleSource('project','run',-1)).toThrow();
    expect(()=>client.bibleSource('project','run',0.1)).toThrow();
    await expect(client.bibleRead('project','run')).rejects.toMatchObject({code:'BAD_RESPONSE'});
    const {view}=data();await expect(new ApiClient(token,async()=>Response.json({...view,extra:'x'.repeat(2_100_000)})).bibleRead('project','run')).rejects.toMatchObject({code:'BAD_RESPONSE'});
  });
});
