import {expect,it,vi} from 'vitest';
import {ApiClient} from '../src/api.js';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {makeOutlinePackage} from '../../ir/test/outline-formal-fixture.js';
import {OUTLINE_FORMAL_SECTIONS,OutlineFormalObjectSchema,OutlineFormalSectionPageSchema} from '@camery/ir/outline-formal';
import type {OutlineFormalSection} from '@camery/ir/outline-formal';

const token='cmry_'+'d'.repeat(43),candidateId=id('web-outline-candidate'),requestId='original-decision',projectKey='project',runId='reviewed-run';
const compare={expectedSnapshotRevision:2,expectedWriteVersion:3},prepare={...compare,applicationId:'original-application',runDigest:'a'.repeat(64),briefDigest:'b'.repeat(64),candidateDigest:'c'.repeat(64),reviewDigest:'d'.repeat(64),sourceDigest:'e'.repeat(64)};
const p=makeOutlinePackage(),plan=p.adaptation_plans[0]!,ref={collection:'adaptation_plans' as const,id:plan.id,version:plan.version},owner={id:plan.id,version:plan.version};
const base={contractVersion:1 as const,projectKey,projectId:p.project.id,schemaVersion:'0.7.0-draft' as const,snapshotRevision:2,headRevision:3,writeVersion:4};
const counts=[{collection:'adaptation_plans' as const,count:1}];
const preparation={contractVersion:1 as const,projectKey,candidateId,kind:'preparation' as const,requestId:prepare.applicationId,status:'candidate' as const,snapshotRevision:2,writeVersion:3,issueCount:0,warningCount:600,adoption:null,rejection:null};
const candidate={contractVersion:1 as const,projectKey,candidateId,applicationId:prepare.applicationId,runId,status:'candidate' as const,snapshotRevision:2,writeVersion:3,baseRevision:2,operationCount:1249,sourceState:'current' as const,canReview:true,preparation};
const header={candidateId,applicationId:prepare.applicationId,runId,status:'candidate' as const,authorId:id('author'),createdAt:'2026-11-18T10:00:00.000Z',baseRevision:2,operationCount:1249};
const adopted={...preparation,kind:'decision' as const,requestId,status:'adopted' as const,adoption:{change_set_id:candidateId,actor_id:id('reviewer'),scope:{kind:'project' as const,id:p.project.id},from_revision:2,to_revision:3,at:'2026-11-18T10:00:00.000Z'}};
const rejected={...preparation,kind:'decision' as const,requestId,status:'rejected' as const,rejection:{actor_id:id('reviewer'),reason:'保留人物动机。',at:'2026-11-18T10:00:00.000Z'}};
const messages={contractVersion:1 as const,projectKey,candidateId,kind:'preparation' as const,requestId:prepare.applicationId,section:'warnings' as const,total:600,items:[{code:'STALE_OUTLINE_DEPENDENCY',where:'/outline_beats/0',message:'请核对人物引用。'}],nextCursor:'more-messages'};
const overview=structuredClone(plan) as unknown as Record<string,unknown>,sections:{section:OutlineFormalSection;total:number}[]=[];
for(const [section,definition] of Object.entries(OUTLINE_FORMAL_SECTIONS) as [OutlineFormalSection,(typeof OUTLINE_FORMAL_SECTIONS)[OutlineFormalSection]][]){if(definition.collection!=='adaptation_plans')continue;let parent=overview;for(const key of definition.path.slice(0,-1))parent=parent[key] as Record<string,unknown>;const last=definition.path.at(-1)!;sections.push({section,total:(parent[last] as unknown[]).length});delete parent[last];}
const object=OutlineFormalObjectSchema.parse({...base,ref,plan:owner,overview:{collection:'adaptation_plans',value:overview},sections});
const section=OutlineFormalSectionPageSchema.parse({...base,ref,plan:owner,section:'adaptation_plans.source.references',total:plan.source.references.length,items:plan.source.references,nextCursor:null});
const list={...base,items:[{ref,plan:owner}],counts,nextCursor:null},rows={...base,rows:[{kind:'complete' as const,ref,plan:owner,record:{collection:'adaptation_plans' as const,value:plan}}],counts,nextCursor:null};
const root='/api/v1/projects/project',candidatePath=root+'/outline-adoption/candidates/'+candidateId,formalPath=root+'/formal-outline';
const upgrade={contractVersion:1 as const,from:'0.6.0-draft' as const,to:'0.7.0-draft' as const,candidate:{contractVersion:1 as const,projectKey,candidateId,applicationId:'upgrade-application',managed:true,status:'candidate' as const,authorId:id('author'),authorKey:'author',createdAt:'2026-11-18T10:00:00.000Z',baseRevision:2,source:{kind:'manual' as const},snapshotRevision:2,writeVersion:3,baseWriteVersion:2,scope:{kind:'project' as const,id:p.project.id},differences:[],issues:[],warnings:[],canAdopt:true,canReject:true,blockingReasons:[],preparation:null}};
function fixture(data:unknown){const transport=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({data,requestId:'wire-request'}));return {client:new ApiClient(token,transport),transport};}
const calls=()=>[
  {name:'prepare',data:candidate,url:root+'/outline/'+runId+'/candidates',method:'POST',body:prepare,key:prepare.applicationId,call:(c:ApiClient,s?:AbortSignal)=>c.outlinePrepareCandidate(projectKey,runId,prepare,s)},
  {name:'catalog',data:{contractVersion:1,items:[header],nextCursor:null},url:root+'/outline-adoption/candidates?runId='+runId+'&limit=1',method:'GET',call:(c:ApiClient,s?:AbortSignal)=>c.outlineCandidates(projectKey,{runId,limit:1},s)},
  {name:'candidate',data:candidate,url:candidatePath,method:'GET',call:(c:ApiClient,s?:AbortSignal)=>c.outlineCandidate(projectKey,candidateId,s)},
  {name:'adopt',data:adopted,url:candidatePath+'/adopt',method:'POST',body:compare,key:requestId,call:(c:ApiClient,s?:AbortSignal)=>c.outlineAdoptCandidate(projectKey,candidateId,requestId,compare,s)},
  {name:'reject',data:rejected,url:candidatePath+'/reject',method:'POST',body:{...compare,reason:rejected.rejection.reason},key:requestId,call:(c:ApiClient,s?:AbortSignal)=>c.outlineRejectCandidate(projectKey,candidateId,requestId,{...compare,reason:rejected.rejection.reason},s)},
  {name:'messages',data:messages,url:candidatePath+'/receipts?kind=preparation&requestId='+prepare.applicationId+'&section=warnings&limit=1',method:'GET',call:(c:ApiClient,s?:AbortSignal)=>c.outlineReceiptMessages(projectKey,candidateId,{kind:'preparation',requestId:prepare.applicationId,section:'warnings',limit:1},s)},
  {name:'formal list',data:list,url:formalPath+'?revision=2&collection=adaptation_plans&planId='+plan.id+'&limit=1',method:'GET',call:(c:ApiClient,s?:AbortSignal)=>c.formalOutlineList(projectKey,{revision:2,collection:'adaptation_plans',planId:plan.id,limit:1},s)},
  {name:'formal rows',data:rows,url:formalPath+'/rows?revision=2&collection=adaptation_plans&planId='+plan.id+'&limit=1',method:'GET',call:(c:ApiClient,s?:AbortSignal)=>c.formalOutlineRows(projectKey,{revision:2,collection:'adaptation_plans',planId:plan.id,limit:1},s)},
  {name:'formal object',data:object,url:formalPath+'/adaptation_plans/'+plan.id+'?revision=2',method:'GET',call:(c:ApiClient,s?:AbortSignal)=>c.formalOutlineObject(projectKey,'adaptation_plans',plan.id,{revision:2},s)},
  {name:'formal section',data:section,url:formalPath+'/adaptation_plans/'+plan.id+'/sections?revision=2&section=adaptation_plans.source.references&limit=1',method:'GET',call:(c:ApiClient,s?:AbortSignal)=>c.formalOutlineSection(projectKey,'adaptation_plans',plan.id,{revision:2,section:'adaptation_plans.source.references',limit:1},s)},
];

it.each(calls())('sends the typed $name request through the existing private same-origin transport',async operation=>{
  const f=fixture(operation.data),abort=new AbortController();expect(await operation.call(f.client,abort.signal)).toEqual(operation.data);const [url,init]=f.transport.mock.calls[0]!;expect(url).toBe(operation.url);expect(init?.method??'GET').toBe(operation.method);expect(init).toMatchObject({mode:'same-origin',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store'});expect(init?.signal).toBeInstanceOf(AbortSignal);expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer '+token);
  if('body' in operation){expect(JSON.parse(init!.body as string)).toEqual(operation.body);expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(operation.key);expect(init?.body).not.toContain('actorId');expect(init?.body).not.toContain('target');}else expect(init?.body).toBeUndefined();
});
it('supports first pages without optional filters and preserves opaque cursors by URL encoding',async()=>{
  const f=fixture(list);await f.client.formalOutlineList(projectKey);expect(f.transport.mock.calls[0]![0]).toBe(formalPath);await f.client.formalOutlineList(projectKey,{cursor:'position:+/?='});expect(f.transport.mock.calls[1]![0]).toBe(formalPath+'?cursor=position%3A%2B%2F%3F%3D');
  const catalog=fixture({contractVersion:1,items:[header],nextCursor:null});await catalog.client.outlineCandidates(projectKey);expect(catalog.transport.mock.calls[0]![0]).toBe(root+'/outline-adoption/candidates');
  await fixture(rows).client.formalOutlineRows(projectKey);await fixture(object).client.formalOutlineObject(projectKey,'adaptation_plans',plan.id);
});
it('rejects command fields, unsafe IDs, query values and cross-collection sections before transport',async()=>{
  const f=fixture(candidate),getter=vi.fn(()=>2),accessor=Object.defineProperty({...prepare},'expectedSnapshotRevision',{get:getter,enumerable:true});
  for(const action of [()=>f.client.outlinePrepareCandidate('../project',runId,prepare),()=>f.client.outlinePrepareCandidate(projectKey,runId,{...prepare,actorId:'other'} as typeof prepare),()=>f.client.outlinePrepareCandidate(projectKey,runId,accessor),()=>f.client.outlineAdoptCandidate(projectKey,'slug',requestId,compare),()=>f.client.outlineAdoptCandidate(projectKey,candidateId,'invalid\n',compare),()=>f.client.outlineRejectCandidate(projectKey,candidateId,requestId,{...compare,reason:''}),()=>f.client.outlineCandidates(projectKey,{limit:51}),()=>f.client.outlineCandidates(projectKey,{runId:'../run'}),()=>f.client.outlineReceiptMessages(projectKey,candidateId,{kind:'preparation',requestId:'x',section:'invalid'} as never),()=>f.client.formalOutlineList(projectKey,{revision:0}),()=>f.client.formalOutlineRows(projectKey,{limit:51}),()=>f.client.formalOutlineObject(projectKey,'assets' as never,plan.id),()=>f.client.formalOutlineObject(projectKey,'adaptation_plans','slug'),()=>f.client.formalOutlineSection(projectKey,'outline_beats',plan.id,{section:'adaptation_plans.beats'}),()=>f.client.formalOutlineSection(projectKey,'adaptation_plans',plan.id,{section:'__proto__.secret'} as never)])await expect(async()=>action()).rejects.toMatchObject({code:'INVALID_REQUEST'});
  expect(getter).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
});
it.each(calls().filter(operation=>operation.name!=='catalog'))('rejects a mismatched project in $name response',async operation=>{const f=fixture({...operation.data,projectKey:'other'});await expect(operation.call(f.client)).rejects.toMatchObject({code:'BAD_RESPONSE'});});
it.each([
  ['prepare run',(c:ApiClient)=>c.outlinePrepareCandidate(projectKey,runId,prepare),{...candidate,runId:'other'}],
  ['prepare application',(c:ApiClient)=>c.outlinePrepareCandidate(projectKey,runId,prepare),{...candidate,applicationId:'other',preparation:null}],
  ['candidate',(c:ApiClient)=>c.outlineCandidate(projectKey,candidateId),{...candidate,candidateId:id('other-candidate'),preparation:null}],
  ['decision request',(c:ApiClient)=>c.outlineAdoptCandidate(projectKey,candidateId,requestId,compare),{...adopted,requestId:'other'}],
  ['decision kind',(c:ApiClient)=>c.outlineAdoptCandidate(projectKey,candidateId,requestId,compare),{...adopted,kind:'preparation'}],
  ['reject reason',(c:ApiClient)=>c.outlineRejectCandidate(projectKey,candidateId,requestId,{...compare,reason:'原理由'}),rejected],
  ['catalog run',(c:ApiClient)=>c.outlineCandidates(projectKey,{runId}),{contractVersion:1,items:[{...header,runId:'other'}],nextCursor:null}],
  ['receipt section',(c:ApiClient)=>c.outlineReceiptMessages(projectKey,candidateId,{kind:'preparation',requestId:prepare.applicationId,section:'warnings'}),{...messages,section:'issues'}],
  ['receipt request',(c:ApiClient)=>c.outlineReceiptMessages(projectKey,candidateId,{kind:'preparation',requestId:prepare.applicationId,section:'warnings'}),{...messages,requestId:'other'}],
  ['formal revision',(c:ApiClient)=>c.formalOutlineList(projectKey,{revision:3}),list],
  ['formal collection',(c:ApiClient)=>c.formalOutlineRows(projectKey,{collection:'asset_plans'}),rows],
  ['formal parent',(c:ApiClient)=>c.formalOutlineRows(projectKey,{planId:id('other-plan')}),rows],
  ['formal object',(c:ApiClient)=>c.formalOutlineObject(projectKey,'adaptation_plans',id('other-plan')),object],
  ['formal section',(c:ApiClient)=>c.formalOutlineSection(projectKey,'adaptation_plans',plan.id,{section:'adaptation_plans.characters'}),section],
] as const)('refuses mismatched %s rather than acknowledging another operation',async(_name,action,data)=>{await expect(action(fixture(data).client)).rejects.toMatchObject({code:'BAD_RESPONSE'});});
it('does not truncate more than 500 receipt warnings or a 1249 operation candidate into old Workbench limits',async()=>{expect((await fixture(candidate).client.outlineCandidate(projectKey,candidateId)).operationCount).toBe(1249);expect((await fixture(messages).client.outlineReceiptMessages(projectKey,candidateId,{kind:'preparation',requestId:prepare.applicationId,section:'warnings'})).total).toBe(600);});
it('accepts complete section descriptors for an oversized row without inventing the omitted arrays',async()=>{
  const sectioned={...base,rows:[{kind:'sectioned' as const,ref,plan:owner,overview:object.overview,sections:object.sections}],counts,nextCursor:'after-large-plan'};
  const result=await fixture(sectioned).client.formalOutlineRows(projectKey,{collection:'adaptation_plans',planId:plan.id});expect(result).toEqual(sectioned);expect(result.rows[0]).not.toHaveProperty('record');expect(result.rows[0]!.kind).toBe('sectioned');
});
it('binds requested page limits and preserves a failed or no-change preparation acknowledgement',async()=>{
  const secondHeader={...header,candidateId:id('another-candidate')};await expect(fixture({contractVersion:1,items:[header,secondHeader],nextCursor:null}).client.outlineCandidates(projectKey,{limit:1})).rejects.toMatchObject({code:'BAD_RESPONSE'});
  const noChange={...candidate,status:'unchanged' as const,operationCount:0,canReview:false,preparation:{...preparation,status:'unchanged' as const,warningCount:0}};expect(await fixture(noChange).client.outlinePrepareCandidate(projectKey,runId,prepare)).toEqual(noChange);
  const failed={...candidate,status:'conflicted' as const,canReview:false,preparation:{...preparation,status:'conflicted' as const,issueCount:1}};expect(await fixture(failed).client.outlinePrepareCandidate(projectKey,runId,prepare)).toEqual(failed);
  const twoHeaders={...list,items:[...list.items,{ref:{...ref,id:id('another-plan')},plan:{id:id('another-plan'),version:1}}]};await expect(fixture(twoHeaders).client.formalOutlineList(projectKey,{limit:1})).rejects.toMatchObject({code:'BAD_RESPONSE'});
});
it('preserves failed native decisions with their previous audit instead of treating that history as a new action',async()=>{
  const priorRejection={...rejected,status:'conflicted' as const,issueCount:1},priorAdoption={...adopted,status:'conflicted' as const,issueCount:1};
  expect(await fixture(priorRejection).client.outlineAdoptCandidate(projectKey,candidateId,requestId,compare)).toEqual(priorRejection);
  expect(await fixture(priorAdoption).client.outlineRejectCandidate(projectKey,candidateId,requestId,{...compare,reason:'本次理由'})).toEqual(priorAdoption);
  expect(await fixture({...rejected,status:'conflicted',rejection:null,issueCount:1}).client.outlineRejectCandidate(projectKey,candidateId,requestId,{...compare,reason:'本次理由'})).toMatchObject({issueCount:1,status:'conflicted'});
});
it('rejects an oversized complete wire envelope even when its typed data alone fits',async()=>{
  const target=983020,near={...section,section:'adaptation_plans.recipe.signature_scenes' as const,total:32,nextCursor:'next',items:Array.from({length:32},(_,index)=>({key:'bounded-scene-'+index,description:'x'.repeat(1000),beats:Array.from({length:500},(_,beat)=>({id:id('wire-beat-'+beat),version:Number.MAX_SAFE_INTEGER}))}))};
  let bytes=Buffer.byteLength(JSON.stringify(near));expect(bytes).toBeGreaterThan(target);
  while(bytes>target){const excess=bytes-target;if(excess<=near.items[0]!.description.length){near.items[0]!.description=near.items[0]!.description.slice(0,-excess);break;}const row=near.items.find(item=>item.beats.length>1)!;const each=Buffer.byteLength(JSON.stringify(row.beats[0]))+1;row.beats.splice(row.beats.length-Math.min(row.beats.length-1,Math.floor(excess/each)));bytes=Buffer.byteLength(JSON.stringify(near));}
  expect(Buffer.byteLength(JSON.stringify(near))).toBe(target);expect(OutlineFormalSectionPageSchema.safeParse(near).success).toBe(true);expect(Buffer.byteLength(JSON.stringify({data:near,requestId:'wire-request'}))).toBeGreaterThan(983040);
  const f=new ApiClient(token,async()=>Response.json({data:near,requestId:'wire-request'}));await expect(f.formalOutlineSection(projectKey,'adaptation_plans',plan.id,{section:near.section})).rejects.toMatchObject({code:'BAD_RESPONSE'});
});
it('forwards cancellation and preserves safe typed conflicts without exposing server diagnostics',async()=>{
  const abort=new AbortController(),transport=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{expect(init?.signal?.aborted).toBe(true);throw new DOMException('private credential '+token,'AbortError');});abort.abort();await expect(new ApiClient(token,transport).outlineCandidate(projectKey,candidateId,abort.signal)).rejects.toMatchObject({code:'CANCELLED'});
  for(const code of ['SCHEMA_UPGRADE_REQUIRED','PROJECT_BINDING_MISSING','SNAPSHOT_STALE','WRITE_VERSION_CONFLICT'])await expect(new ApiClient(token,async()=>Response.json({code,requestId:'error-request'},{status:409})).outlineCandidate(projectKey,candidateId)).rejects.toMatchObject({code});
  const denied=new ApiClient(token,async()=>Response.json({code:'PRIVATE_DIAGNOSTIC',requestId:'error-request',secret:token},{status:409}));const error=await denied.outlineCandidate(projectKey,candidateId).catch((problem:unknown)=>problem);expect(error).toMatchObject({code:'CONFLICT'});expect(String(error)).not.toContain(token);
});
it('reads only a verified schema-upgrade candidate through the explicit typed endpoint',async()=>{
  const f=fixture(upgrade),abort=new AbortController();expect(await f.client.workbenchUpgradeCandidate(projectKey,candidateId,abort.signal)).toEqual(upgrade);expect(f.transport.mock.calls[0]![0]).toBe(root+'/workbench/schema-upgrades/'+candidateId);expect(f.transport.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  expect(()=>f.client.workbenchUpgradeCandidate(projectKey,'slug')).toThrow(expect.objectContaining({code:'INVALID_REQUEST'}));
});
it.each([
  {...upgrade,candidate:{...upgrade.candidate,projectKey:'other'}},
  {...upgrade,candidate:{...upgrade.candidate,candidateId:id('another-upgrade')}},
  {...upgrade,candidate:{...upgrade.candidate,managed:false}},
  {...upgrade,candidate:{...upgrade.candidate,source:{kind:'unmanaged'}}},
  {...upgrade,candidate:{...upgrade.candidate,scope:{kind:'episode',id:p.project.id}}},
  {...upgrade,from:'0.5.0-draft'},
  {...upgrade,to:'0.6.0-draft'},
])('refuses an unverified manual change, impossible schema pair or foreign upgrade candidate',async data=>{await expect(fixture(data).client.workbenchUpgradeCandidate(projectKey,candidateId)).rejects.toMatchObject({code:'BAD_RESPONSE'});});
