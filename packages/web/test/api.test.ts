import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../src/api.js';
import { createSourcePage, importNovel } from '@camery/ingest';
const token = `cmry_${'c'.repeat(43)}`;
function urlOf(input: RequestInfo|URL): string { return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; }
describe('same-origin authenticated source client', () => {
  it('does not call a browser-native transport with the API client as its receiver',async()=>{
    const transport:typeof fetch=function(this:unknown,_input:RequestInfo|URL,_init?:RequestInit){
      if(this!==undefined)throw new TypeError('Illegal invocation');
      return Promise.resolve(Response.json({tenantId:'tenant',userId:'user',grants:[]}));
    };
    await expect(new ApiClient(token,transport).me()).resolves.toEqual({tenantId:'tenant',userId:'user',grants:[]});
  });
  it('keeps credentials out of URLs, serialized client state and request error details', async () => {
    const transport = vi.fn(async (_url: RequestInfo|URL, _options?: RequestInit) => new Response(JSON.stringify({ tenantId: 'tenant', userId: 'user', grants: [{ projectId: 'project', role: 'editor' }] })));
    const client = new ApiClient(token,transport); await client.me();
    const [url,options] = transport.mock.calls[0]!;
    expect(url).toBe('/api/v1/me'); expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' }); expect(new Headers(options!.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(JSON.stringify(client)).not.toContain(token);
  });
  it.each([401,403,409,413,422,503])('preserves safe HTTP status %s without source text', async status => {
    const client = new ApiClient(token,async () => new Response(JSON.stringify({ code: 'unexpected', source: 'private content' }),{status}));
    await expect(client.me()).rejects.toBeInstanceOf(ApiError);
    try { await client.me(); } catch (error) { expect(String(error)).not.toContain('private'); }
  });
  it('rejects malformed credentials, network errors, non-JSON and invalid response shapes', async () => {
    expect(() => new ApiClient('wrong')).toThrow();
    await expect(new ApiClient(token,async () => { throw new Error(token); }).me()).rejects.toMatchObject({ code: 'NETWORK_FAILED' });
    await expect(new ApiClient(token,async () => new Response('not json')).me()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    await expect(new ApiClient(token,async () => new Response('{}')).me()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
  it('validates every source response while preserving same-origin URL and wire payload boundaries', async () => {
    const document = importNovel('第一章 开始\n原文😀');
    const source = { documentId:'source',title:'小说',kind:'novel' as const,format:'novel' as const,revision:1 };
    const page = createSourcePage({documentId:source.documentId,title:source.title,kind:source.kind,revision:1,document});
    const transport = vi.fn(async (input: RequestInfo|URL,init?:RequestInit) => {
      const url=urlOf(input);
      if(url.endsWith('/sign-out'))return new Response(null,{status:204});
      if(url.endsWith('/access'))return Response.json({projectId:'project',permissions:['project:read','candidate:write']});
      if(url.includes('/sources'))return Response.json({items:[source],nextCursor:null});
      if(url.endsWith('/batches'))return Response.json({...source,sourceDigest:document.sourceDigest,batchRevision:1,duplicate:false});
      if(url.endsWith('/checkpoint'))return Response.json({offset:3,version:1});
      if(init?.method==='PUT')return Response.json({...source,kind:'script',format:'fountain',sourceDigest:document.sourceDigest,duplicate:false});
      return Response.json(page);
    });
    const client=new ApiClient(token,transport); const controller=new AbortController();
    expect((await client.access('project',controller.signal)).permissions).toContain('candidate:write');
    await client.access('project'); await client.list('project'); await client.list('project','novel:source',controller.signal);
    expect(await client.read('project','novel','source')).toEqual(page);
    await client.read('project','script','source',0,controller.signal);
    await client.read('project','novel','source',undefined,undefined,12000);
    await client.append('project','source',{batchId:'first',text:document.text,expectedRevision:0});
    await client.script('project','source','fountain','剧本.fountain',new Uint8Array([1,2,3]));
    await client.checkpoint('project','source',{sourceDigest:document.sourceDigest,offset:3,expectedVersion:0}); await client.signOut();
    expect(transport.mock.calls.every(([url])=>urlOf(url).startsWith('/api/v1/'))).toBe(true);
    const binary = transport.mock.calls.find(([,init])=>init?.method==='PUT')!;
    expect(binary[0]).toContain(encodeURIComponent('剧本.fountain'));
    expect(new Uint8Array(binary[1]!.body as ArrayBuffer)).toEqual(new Uint8Array([1,2,3]));
    const post = transport.mock.calls.find(([url])=>urlOf(url).endsWith('/batches'))!;
    expect(JSON.parse(post[1]!.body as string)).not.toHaveProperty('tenantId');
  });
  it('rejects unsafe URL identifiers and invalid offsets before making requests', () => {
    const transport=vi.fn(); const client=new ApiClient(token,transport);
    expect(()=>client.access('project\n')).toThrow(expect.objectContaining({code:'INVALID_REQUEST'}));
    expect(()=>client.read('project','novel','../escape')).toThrow();
    for(const offset of [-1,NaN,Infinity,0.1])expect(()=>client.read('project','novel','source',offset)).toThrow();
    expect(()=>client.read('project','novel','source',0,undefined,12)).toThrow();
    expect(()=>client.read('project','novel','source',undefined,undefined,-1)).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([['AbortError','CANCELLED'],['TimeoutError','TIMEOUT']] as const)('maps %s to a safe %s',async(name,code)=>{
    await expect(new ApiClient(token,async()=>{throw new DOMException('private',name);}).me()).rejects.toMatchObject({code});
  });
  it('handles unknown HTTP failures without parsing their body',async()=>{
    await expect(new ApiClient(token,async()=>new Response('private',{status:500})).me()).rejects.toMatchObject({code:'HTTP_FAILED'});
  });
});
