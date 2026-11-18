import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {AccessError} from '@camery/access';
import type {Role,SessionIdentity,SessionStore} from '@camery/access';
import {OutlineFormalSectionPageSchema} from '@camery/ir/outline-formal';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {ProjectApplicationError} from '../src/projects/intent-contracts.js';
import type {OutlineFormalReadOptions} from '../src/projects/outline-formal-options.js';
import {formalListPage,formalObject,formalSectionPage,requiredFormalRow} from '../src/projects/outline-formal-projection.js';
import {outlineFormalReadFixture} from './outline-formal-read-support.js';
const methods=vi.hoisted(()=>({list:vi.fn(),rows:vi.fn(),object:vi.fn(),section:vi.fn()}));
vi.mock('../src/projects/outline-formal-application.js',()=>({OutlineFormalReadApplication:class {constructor(){return methods;}}}));
import {createApplication} from '../src/app.js';

const authorization=`Bearer cmry_${'c'.repeat(43)}`,headers={authorization};
let projectId:string,tenantId:string,objectId:string,base:string,objectUrl:string,sectionUrl:string;
let valid:{list:unknown;rows:unknown;object:unknown;section:unknown};
const apps:Awaited<ReturnType<typeof createApplication>>[]=[];
beforeAll(async()=>{
  const source=await outlineFormalReadFixture(),data=(await source.store.snapshot({target:source.target}))!;projectId=source.scope.projectId;tenantId=source.scope.tenantId;objectId=data.snapshot.adaptation_plans[0]!.id;base='/api/v1/projects/'+projectId+'/formal-outline';objectUrl=base+'/adaptation_plans/'+objectId;sectionUrl=objectUrl+'/sections?section=adaptation_plans.source.references';
  const row=requiredFormalRow(data,'adaptation_plans',objectId);valid={list:formalListPage({projectKey:projectId,data,query:{},binding:{}}),rows:formalListPage({projectKey:projectId,data,query:{},binding:{},bulk:true}),object:formalObject(projectId,data,row),section:formalSectionPage({projectKey:projectId,data,row,section:'adaptation_plans.source.references',binding:{},offset:0})};
},30000);
beforeEach(()=>{for(const name of Object.keys(methods) as (keyof typeof methods)[]){methods[name].mockReset();methods[name].mockResolvedValue(valid[name]);}});
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function fixture(role:Role='viewer',enabled=true){
  const subject:SessionIdentity={tenantId,userId:'viewer',sessionId:'session',grants:[{projectId,role}]},store={lookup:vi.fn(async()=>subject as SessionIdentity|null),revoke:vi.fn(async()=>{})} satisfies SessionStore;
  const app=await createApplication({tenantId,store,...(enabled?{outlineFormal:{tenantId} as OutlineFormalReadOptions}:{})});apps.push(app);return {app,store,subject};
}
const requests=()=>[{url:base,headers},{url:base+'/rows',headers},{url:objectUrl,headers},{url:sectionUrl,headers}];

it('serves all four formal routes to a viewer with typed bounded no-store envelopes',async()=>{
  const f=await fixture();for(const request of requests()){const response=await f.app.inject(request);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({data:expect.any(Object),requestId:expect.any(String)});expect(response.headers['cache-control']).toBe('no-store');expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(983040);}
  expect(methods.list).toHaveBeenCalledWith({subject:f.subject,projectId,command:{}});expect(methods.rows).toHaveBeenCalledWith({subject:f.subject,projectId,command:{}});expect(methods.object).toHaveBeenCalledWith({subject:f.subject,projectId,collection:'adaptation_plans',objectId,command:{}});expect(methods.section).toHaveBeenCalledWith({subject:f.subject,projectId,collection:'adaptation_plans',objectId,command:{section:'adaptation_plans.source.references'}});
});
it('keeps the four routes absent when the reader is not configured',async()=>{const f=await fixture('viewer',false);for(const request of requests())expect((await f.app.inject(request)).statusCode).toBe(404);for(const method of Object.values(methods))expect(method).not.toHaveBeenCalled();});
it('authenticates every read before dispatch and rechecks a revoked session',async()=>{
  const f=await fixture();for(const request of requests())expect((await f.app.inject({...request,headers:{}})).statusCode).toBe(401);for(const method of Object.values(methods))expect(method).not.toHaveBeenCalled();
  expect((await f.app.inject({url:base,headers})).statusCode).toBe(200);methods.list.mockClear();f.store.lookup.mockResolvedValue(null);const revoked=await f.app.inject({url:base,headers});expect(revoked.statusCode).toBe(401);expect(revoked.headers['www-authenticate']).toBe('Bearer');expect(methods.list).not.toHaveBeenCalled();
});
it('isolates all four routes from another ordinary project before application dispatch',async()=>{const f=await fixture();for(const request of requests())expect((await f.app.inject({...request,url:request.url.replace('/projects/'+projectId+'/','/projects/other/')})).statusCode).toBe(403);for(const method of Object.values(methods))expect(method).not.toHaveBeenCalled();});
it('rejects duplicate bearer credentials before dispatching any reader',async()=>{const f=await fixture(),duplicateHeaders:Record<string,string|string[]>={authorization:[authorization,authorization]};for(const request of requests())expect((await f.app.inject({...request,headers:duplicateHeaders})).statusCode).toBe(401);for(const method of Object.values(methods))expect(method).not.toHaveBeenCalled();});
it('parses canonical revision, collection, plan and page selectors for each exact route',async()=>{
  const f=await fixture();for(const [url,method,command] of [[base+'?revision=6&collection=asset_plans&planId='+objectId+'&limit=50&cursor=rows-cursor',methods.list,{revision:6,collection:'asset_plans',planId:objectId,limit:50,cursor:'rows-cursor'}],[base+'/rows?revision=6&limit=1&cursor=bulk-cursor',methods.rows,{revision:6,limit:1,cursor:'bulk-cursor'}],[objectUrl+'?revision=6',methods.object,{revision:6}],[sectionUrl+'&revision=6&limit=1&cursor=section-cursor',methods.section,{section:'adaptation_plans.source.references',revision:6,limit:1,cursor:'section-cursor'}]] as const){expect((await f.app.inject({url,headers})).statusCode).toBe(200);expect(method).toHaveBeenCalledWith(expect.objectContaining({subject:f.subject,projectId,command}));}
});
it.each(['actorId=other','tenantId=other','projectId=other','offset=50','revision=0','revision=01','revision=9007199254740992','revision=1&revision=2','limit=51','limit=1&limit=2','cursor=a&cursor=b','collection=assets','planId=slug'])('rejects strict list and bulk selector %s before application access',async selector=>{const f=await fixture();for(const url of [base,base+'/rows'])expect((await f.app.inject({url:url+'?'+selector,headers})).statusCode).toBe(400);expect(methods.list).not.toHaveBeenCalled();expect(methods.rows).not.toHaveBeenCalled();});
it('rejects invalid object addresses and section paths rather than arbitrary document selectors',async()=>{
  const f=await fixture();for(const url of [base+'/assets/'+objectId,base+'/adaptation_plans/slug',objectUrl+'?actorId=other',objectUrl+'?limit=1',objectUrl+'?revision=1&revision=2',objectUrl+'/sections',objectUrl+'/sections?section=__proto__.private',sectionUrl+'&section=adaptation_plans.beats',sectionUrl+'&offset=1',sectionUrl+'&limit=01'])expect((await f.app.inject({url,headers})).statusCode).toBe(400);expect(methods.object).not.toHaveBeenCalled();expect(methods.section).not.toHaveBeenCalled();
});
it.each(['list','rows','object','section'] as const)('rejects malformed %s projection data and redacts private host fields',async method=>{
  const f=await fixture(),url=method==='list'?base:method==='rows'?base+'/rows':method==='object'?objectUrl:sectionUrl;methods[method].mockResolvedValue({...valid[method] as object,secret:'private-credential'});const response=await f.app.inject({url,headers});expect(response.statusCode,response.body).toBe(503);expect(response.json()).toEqual({code:'STORAGE_FAILED',requestId:expect.any(String)});expect(response.body).not.toContain('private');
});
it('enforces the complete wire envelope budget even when the typed data alone fits',async()=>{
  const f=await fixture(),targetBytes=983020,near={...valid.section as Record<string,unknown>,section:'adaptation_plans.recipe.signature_scenes',total:32,nextCursor:'x',items:Array.from({length:32},(_,index)=>({key:'wire-scene-'+index,description:'\u0001'.repeat(1000),beats:Array.from({length:500},(_,beat)=>({id:id('wire-beat-'+beat),version:Number.MAX_SAFE_INTEGER}))}))};
  expect(Buffer.byteLength(JSON.stringify(near))).toBeGreaterThan(targetBytes);
  while(Buffer.byteLength(JSON.stringify(near))>targetBytes){const excess=Buffer.byteLength(JSON.stringify(near))-targetBytes,last=near.items.at(-1)!;if(last.beats.length>1)last.beats.splice(last.beats.length-Math.min(last.beats.length-1,Math.max(1,Math.floor(excess/64))));else if(excess<last.description.length*6)last.description=last.description.slice(Math.ceil(excess/6));else near.items.pop();}
  near.nextCursor+='x'.repeat(targetBytes-Buffer.byteLength(JSON.stringify(near)));expect(Buffer.byteLength(JSON.stringify(near))).toBe(targetBytes);expect(OutlineFormalSectionPageSchema.safeParse(near).success).toBe(true);methods.section.mockResolvedValue(near);
  const response=await f.app.inject({url:objectUrl+'/sections?section=adaptation_plans.recipe.signature_scenes',headers});expect(response.statusCode,response.body.slice(0,200)).toBe(503);expect(response.json()).toEqual({code:'STORAGE_FAILED',requestId:expect.any(String)});expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(983040);
},30000);
it.each([{error:new ProjectApplicationError('SCHEMA_UPGRADE_REQUIRED','private'),status:409,code:'SCHEMA_UPGRADE_REQUIRED'},{error:new ProjectApplicationError('NOT_FOUND','private'),status:404,code:'NOT_FOUND'},{error:new ProjectApplicationError('INVALID_INPUT','private'),status:400,code:'INVALID_INPUT'},{error:new ProjectApplicationError('STORAGE_FAILED','private'),status:503,code:'STORAGE_FAILED'},{error:new AccessError('FORBIDDEN'),status:403,code:'FORBIDDEN'},{error:new Error('postgresql://private@host'),status:500,code:'INTERNAL_ERROR'}])('maps a failed reader to safe $status/$code transport metadata',async({error,status,code})=>{const f=await fixture();methods.object.mockRejectedValue(error);const response=await f.app.inject({url:objectUrl,headers});expect(response.statusCode,response.body).toBe(status);expect(response.json()).toEqual({code,requestId:expect.any(String)});expect(response.body).not.toContain('private');});
it('rejects a formal reader configured for another deployment tenant before startup',async()=>{await expect(createApplication({tenantId,store:{lookup:async()=>null,revoke:async()=>{}},outlineFormal:{tenantId:'other'} as OutlineFormalReadOptions})).rejects.toThrow('Formal outline tenant mismatch');});
