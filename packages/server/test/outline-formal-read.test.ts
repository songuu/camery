import {expect,it,vi} from 'vitest';
import {OUTLINE_COLLECTIONS,StoryboardPackageV07,upgradeV05Package,validatePackage} from '@camery/ir';
import {OUTLINE_FORMAL_SECTIONS} from '@camery/ir/outline-formal';
import type {OutlineFormalCollection} from '@camery/ir/outline-formal';
import {fixtureId as id,makePackage} from '../../ir/test/fixtures.js';
import {ProjectIdentityError} from '../src/projects/contracts.js';
import {outlineFormalReadFixture,setSection} from './outline-formal-read-support.js';

type Fixture=Awaited<ReturnType<typeof outlineFormalReadFixture>>;
const sorted=(rows:{ref:{collection:string;id:string}}[])=>[...rows].sort((a,b)=>a.ref.collection<b.ref.collection?-1:a.ref.collection>b.ref.collection?1:a.ref.id<b.ref.id?-1:a.ref.id>b.ref.id?1:0);
async function reconstructed(f:Fixture,collection:OutlineFormalCollection,objectId:string,revision?:number){
  const address=f.address(collection,objectId),detail=await f.application.object({...address,command:revision===undefined?{}:{revision}}),value=structuredClone(detail.overview.value) as unknown as Record<string,unknown>;
  for(const descriptor of detail.sections){let cursor:string|undefined;const items:unknown[]=[];do{
    const page=await f.application.section({...address,command:{section:descriptor.section,revision:detail.snapshotRevision,limit:31,...(cursor?{cursor}:{})}});
    expect(page.ref).toEqual(detail.ref);expect(page.plan).toEqual(detail.plan);expect(page.total).toBe(descriptor.total);expect(page.snapshotRevision).toBe(detail.snapshotRevision);expect(page.items.length).toBeLessThanOrEqual(31);
    expect(Buffer.byteLength(JSON.stringify({data:page,requestId:'11111111-1111-4111-8111-111111111111'}))).toBeLessThanOrEqual(983040);items.push(...page.items);cursor=page.nextCursor??undefined;
  }while(cursor);expect(items).toHaveLength(descriptor.total);setSection(value,OUTLINE_FORMAL_SECTIONS[descriptor.section].path,items);}
  return {detail,value};
}

it('lists only adopted formal outline headers in deterministic collection/id order without allocating or generating',async()=>{
  const f=await outlineFormalReadFixture(),before=structuredClone(f.snapshot),items:Awaited<ReturnType<Fixture['application']['list']>>['items']=[];let cursor:string|undefined;
  do{const page=await f.application.list({...f.context(),command:{limit:2,...(cursor?{cursor}:{})}});expect(page.schemaVersion).toBe('0.7.0-draft');expect(page.projectKey).toBe(f.scope.projectId);expect(page.projectId).toBe(f.target.projectId);expect(page.snapshotRevision).toBe(f.snapshot.revision.number);expect(page.items.length).toBeLessThanOrEqual(2);expect(JSON.stringify(page)).not.toContain(f.snapshot.adaptation_plans[0]!.adaptation.logline);items.push(...page.items);cursor=page.nextCursor??undefined;}while(cursor);
  const expected=OUTLINE_COLLECTIONS.flatMap(collection=>f.snapshot[collection].map(row=>({ref:{collection,id:row.id,version:row.version},plan:collection==='adaptation_plans'?{id:row.id,version:row.version}:(row as {adaptation_plan:{id:string;version:number}}).adaptation_plan})));
  expect(items).toEqual(sorted(expected));expect(new Set(items.map(row=>row.ref.id)).size).toBe(items.length);expect(f.snapshot).toEqual(before);expect(f.source.exchange).toHaveBeenCalledTimes(1);
});
it('reconstructs every field of all six formal object types from overview and typed section pages',async()=>{
  const f=await outlineFormalReadFixture();for(const collection of OUTLINE_COLLECTIONS){const row=f.snapshot[collection][0]!;const result=await reconstructed(f,collection,row.id);expect(result.value).toEqual(row);expect(result.detail.ref).toEqual({collection,id:row.id,version:row.version});}
  expect(f.source.exchange).toHaveBeenCalledTimes(1);
},30000);
it('describes empty arrays explicitly and retains them when rebuilding a complete object',async()=>{
  const f=await outlineFormalReadFixture(),snapshot=structuredClone(f.snapshot),asset=snapshot.asset_plans[0]!;
  // Imported narrative locations legitimately have no prop state transitions.
  asset.kind='location';asset.prop_states=[];expect(validatePackage(snapshot).valid).toBe(true);StoryboardPackageV07.parse(snapshot);f.snapshots.set(snapshot.revision.number,snapshot);
  const address=f.address('asset_plans',asset.id),object=await f.application.object({...address,command:{}});
  const empty=object.sections.filter(section=>section.total===0);expect(empty.length).toBeGreaterThan(0);
  for(const section of empty){const page=await f.application.section({...address,command:{section:section.section}});expect(page.items).toEqual([]);expect(page.nextCursor).toBeNull();expect(page.total).toBe(0);}
  expect((await reconstructed(f,'asset_plans',asset.id)).value).toEqual(asset);
});
it('reads an oversized legitimate formal graph through bounded pages and retains every source reference and signature beat pin',async()=>{
  const f=await outlineFormalReadFixture({large:true}),plan=f.snapshot.adaptation_plans[0]!;expect(validatePackage(f.snapshot).valid).toBe(true);expect(Buffer.byteLength(JSON.stringify(plan))).toBeGreaterThan(1101588);
  const rebuilt=await reconstructed(f,'adaptation_plans',plan.id);expect(rebuilt.value).toEqual(plan);expect(StoryboardPackageV07.parse({...f.snapshot,adaptation_plans:[rebuilt.value]})).toEqual(f.snapshot);
  const first=await f.application.section({...f.address(),command:{section:'adaptation_plans.recipe.signature_scenes',limit:50}});expect(first.items.length).toBeLessThan(32);expect(first.nextCursor).not.toBeNull();expect(Buffer.byteLength(JSON.stringify({data:first,requestId:'11111111-1111-4111-8111-111111111111'}))).toBeLessThanOrEqual(983040);
  const keys=new Set<string>();let cursor:string|undefined;do{const page=await f.application.list({...f.context(),command:{limit:50,...(cursor?{cursor}:{})}});for(const item of page.items){expect(keys.has(item.ref.id)).toBe(false);keys.add(item.ref.id);}cursor=page.nextCursor??undefined;}while(cursor);
  expect(keys.size).toBe(1085);expect(f.mapped.outline_beats).toHaveLength(500);expect(f.source.exchange).toHaveBeenCalledTimes(1);
},30000);
it('rebuilds all 1,085 formal rows through bulk rows and bounded sections without truncation',async()=>{
  const f=await outlineFormalReadFixture({large:true}),actual=new Map<string,unknown>(),expected=new Map<string,unknown>();let cursor:string|undefined,sectioned=0,pages=0;
  for(const collection of OUTLINE_COLLECTIONS)for(const value of f.snapshot[collection])expected.set(collection+':'+value.id,value);
  do{const page=await f.application.rows({...f.context(),command:{limit:50,...(cursor?{cursor}:{})}});pages++;expect(page.rows.length).toBeLessThanOrEqual(50);expect(page.rows.length).toBeGreaterThan(0);expect(page.snapshotRevision).toBe(f.snapshot.revision.number);expect(Buffer.byteLength(JSON.stringify({data:page,requestId:'11111111-1111-4111-8111-111111111111'}))).toBeLessThanOrEqual(983040);
    for(const row of page.rows){const key=row.ref.collection+':'+row.ref.id;expect(actual.has(key)).toBe(false);if(row.kind==='complete'){expect(row.record.collection).toBe(row.ref.collection);actual.set(key,row.record.value);}else{sectioned++;expect(row.overview.collection).toBe(row.ref.collection);const rebuilt=await reconstructed(f,row.ref.collection,row.ref.id,page.snapshotRevision);expect(rebuilt.detail.overview).toEqual(row.overview);expect(rebuilt.detail.sections).toEqual(row.sections);actual.set(key,rebuilt.value);}}
    cursor=page.nextCursor??undefined;
  }while(cursor);expect(actual).toEqual(expected);expect(actual.size).toBe(1085);expect(sectioned).toBe(1);expect(pages).toBeLessThanOrEqual(24);expect(f.source.exchange).toHaveBeenCalledTimes(1);
},60000);
it('keeps bulk cursors separate from metadata cursors and pins bulk pages when the current head moves',async()=>{
  const f=await outlineFormalReadFixture(),list=await f.application.list({...f.context(),command:{limit:1}}),first=await f.application.rows({...f.context(),command:{limit:1}});f.advance();
  const next=await f.application.rows({...f.context(),command:{limit:1,cursor:first.nextCursor!}});expect(next.snapshotRevision).toBe(first.snapshotRevision);expect(next.headRevision).toBe(f.current().headRevision);
  await expect(f.application.rows({...f.context(),command:{cursor:list.nextCursor!}})).rejects.toMatchObject({code:'INVALID_INPUT'});await expect(f.application.list({...f.context(),command:{cursor:first.nextCursor!}})).rejects.toMatchObject({code:'INVALID_INPUT'});
});

it.each(['list','rows','object','section'] as const)('authorizes %s before identity or snapshot access',async method=>{
  const f=await outlineFormalReadFixture();for(const subject of [{...f.subject(),tenantId:'foreign-tenant'},{...f.subject(),grants:[]},{...f.subject(),grants:[{projectId:'another-project',role:'viewer' as const}]}]){
    const action=method==='list'?f.application.list({...f.context(subject),command:{}}):method==='rows'?f.application.rows({...f.context(subject),command:{}}):method==='object'?f.application.object({...f.address('adaptation_plans',f.snapshot.adaptation_plans[0]!.id,subject),command:{}}):f.application.section({...f.address('adaptation_plans',f.snapshot.adaptation_plans[0]!.id,subject),command:{section:'adaptation_plans.beats'}});
    await expect(action).rejects.toMatchObject({code:'FORBIDDEN'});
  }expect(f.identities.resolveProject).not.toHaveBeenCalled();expect(f.store.snapshot).not.toHaveBeenCalled();expect(f.source.exchange).toHaveBeenCalledTimes(1);
});
it('allows a viewer without a principal registration and performs no writing-capability lookup',async()=>{const f=await outlineFormalReadFixture();await f.application.list({...f.context(f.subject('viewer','unregistered-viewer')),command:{}});expect(f.identities.resolveProject).toHaveBeenCalledWith(f.scope);expect(Object.keys(f.identities)).toEqual(['resolveProject']);expect(Object.keys(f.store)).toEqual(['snapshot']);});
it.each(['tenant','project','formal-tenant','formal-project'] as const)('rejects wrong %s registry read bindings before loading stored bodies',async field=>{
  const f=await outlineFormalReadFixture(),binding={...f.scope,versionKey:{...f.target}};if(field==='tenant')binding.tenantId='other';if(field==='project')binding.projectId='other';if(field==='formal-tenant')binding.versionKey.tenantId='not-stable';if(field==='formal-project')binding.versionKey.projectId='not-stable';f.identities.resolveProject.mockResolvedValueOnce(binding);
  await expect(f.application.object({...f.address(),command:{}})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.store.snapshot).not.toHaveBeenCalled();
});
it('rejects a returned snapshot from another tenant even when its formal project ID is identical',async()=>{const f=await outlineFormalReadFixture(),actual=(await f.store.snapshot({target:f.target}))!;f.store.snapshot.mockResolvedValueOnce({...actual,target:{...f.target,tenantId:id('different-formal-tenant')}});await expect(f.application.list({...f.context(),command:{}})).rejects.toMatchObject({code:'STORAGE_FAILED'});});
it('preserves explicit missing identity mappings without creating a project',async()=>{const f=await outlineFormalReadFixture();f.identities.resolveProject.mockRejectedValueOnce(new ProjectIdentityError('PROJECT_BINDING_MISSING','explicit missing project'));await expect(f.application.list({...f.context(),command:{}})).rejects.toMatchObject({code:'PROJECT_BINDING_MISSING'});expect(f.store.snapshot).not.toHaveBeenCalled();});
it('fails closed on unknown snapshot dependency errors including opaque proxies',async()=>{for(const error of [new Error('postgresql://private@formal-reader'),new Proxy({},{getPrototypeOf(){throw new Error('private prototype trap');}})]){const f=await outlineFormalReadFixture();f.store.snapshot.mockRejectedValueOnce(error);const failure=await f.application.object({...f.address(),command:{}}).catch((caught:unknown)=>caught);expect(failure).toMatchObject({code:'STORAGE_FAILED'});expect(String(failure)).not.toContain('private');}});

it('pins list pages to their original immutable snapshot while a real native adoption advances the head',async()=>{
  const f=await outlineFormalReadFixture(),first=await f.application.list({...f.context(),command:{limit:1}}),selected=first.snapshotRevision;expect(first.nextCursor).not.toBeNull();const later=f.advance();
  const next=await f.application.list({...f.context(),command:{cursor:first.nextCursor!,limit:1}});expect(next.snapshotRevision).toBe(selected);expect(next.headRevision).toBe(later.revision.number);expect(next.writeVersion).toBe(f.current().writeVersion);expect(f.store.snapshot).toHaveBeenLastCalledWith({target:f.target,revision:selected});
  const latest=await f.application.list({...f.context(),command:{}});expect(latest.snapshotRevision).toBe(later.revision.number);expect(f.snapshots.get(selected)).toEqual(f.snapshot);
});
it('pins section pages and explicit old-object reads to the selected snapshot instead of silently switching versions',async()=>{
  const f=await outlineFormalReadFixture(),first=await f.application.section({...f.address(),command:{section:'adaptation_plans.beats',limit:1}}),selected=first.snapshotRevision;expect(first.nextCursor).not.toBeNull();const later=f.advance();
  const next=await f.application.section({...f.address(),command:{section:'adaptation_plans.beats',cursor:first.nextCursor!,limit:1}});expect(next.snapshotRevision).toBe(selected);expect(next.headRevision).toBe(later.revision.number);expect(next.items).toEqual(f.snapshot.adaptation_plans[0]!.beats.slice(1,2));
  const old=await f.application.object({...f.address(),command:{revision:selected}});expect(old.snapshotRevision).toBe(selected);expect(old.headRevision).toBe(later.revision.number);expect(old.overview.value.id).toBe(f.snapshot.adaptation_plans[0]!.id);
});
it('rejects an explicit revision inconsistent with either kind of existing cursor',async()=>{
  const f=await outlineFormalReadFixture(),list=await f.application.list({...f.context(),command:{limit:1}}),section=await f.application.section({...f.address(),command:{section:'adaptation_plans.beats',limit:1}});f.advance();f.store.snapshot.mockClear();
  await expect(f.application.list({...f.context(),command:{cursor:list.nextCursor!,revision:list.snapshotRevision+1}})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.application.section({...f.address(),command:{section:'adaptation_plans.beats',cursor:section.nextCursor!,revision:section.snapshotRevision+1}})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(f.store.snapshot).not.toHaveBeenCalled();
});
it.each(['subject','collection','plan','target','malformed','position'] as const)('binds list cursors against a changed %s selector',async field=>{
  const f=await outlineFormalReadFixture(),first=await f.application.list({...f.context(),command:{limit:1}});let cursor=first.nextCursor!;const command:{cursor:string;collection?:string;planId?:string}={cursor};let context=f.context();
  if(field==='subject')context=f.context(f.subject('viewer','another-viewer'));if(field==='collection')command.collection='outline_beats';if(field==='plan')command.planId=f.snapshot.adaptation_plans[0]!.id;if(field==='target')f.identities.resolveProject.mockResolvedValueOnce({...f.scope,versionKey:{...f.target,tenantId:id('other-formal-tenant')}});if(field==='malformed')command.cursor='not-canonical!';
  if(field==='position'){const token=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')) as {position:{last:{id:string}}};token.position.last.id=id('absent-position');cursor=Buffer.from(JSON.stringify(token)).toString('base64url');command.cursor=cursor;}
  await expect(f.application.list({...context,command})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
it.each(['subject','section','object','target','malformed','offset'] as const)('binds section cursors against a changed %s selector',async field=>{
  const f=await outlineFormalReadFixture(),first=await f.application.section({...f.address(),command:{section:'adaptation_plans.beats',limit:1}});let address=f.address(),cursor=first.nextCursor!;const command:{section:string;cursor:string}={section:'adaptation_plans.beats',cursor};
  if(field==='subject')address=f.address('adaptation_plans',f.snapshot.adaptation_plans[0]!.id,f.subject('viewer','other-viewer'));if(field==='section')command.section='adaptation_plans.assets';if(field==='object')address={...address,objectId:id('other-plan')};if(field==='target')f.identities.resolveProject.mockResolvedValueOnce({...f.scope,versionKey:{...f.target,tenantId:id('other-formal-tenant')}});if(field==='malformed')command.cursor='not-canonical!';
  if(field==='offset'){const token=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')) as {position:{offset:number}};token.position.offset=999999;cursor=Buffer.from(JSON.stringify(token)).toString('base64url');command.cursor=cursor;}
  await expect(f.application.section({...address,command})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
it('permits a fresh session for the same viewer to resume an immutable snapshot cursor',async()=>{const f=await outlineFormalReadFixture(),first=await f.application.list({...f.context(),command:{limit:1}}),subject={...f.subject(),sessionId:'new-session-same-user'};const next=await f.application.list({...f.context(subject),command:{cursor:first.nextCursor!,limit:1}});expect(next.snapshotRevision).toBe(first.snapshotRevision);});
it('filters one formal collection and one real owning plan without returning another collection',async()=>{const f=await outlineFormalReadFixture(),planId=f.snapshot.adaptation_plans[0]!.id,page=await f.application.list({...f.context(),command:{collection:'asset_plans',planId}});expect(page.items).toHaveLength(f.snapshot.asset_plans.length);expect(page.items.every(row=>row.ref.collection==='asset_plans'&&row.plan.id===planId)).toBe(true);await expect(f.application.list({...f.context(),command:{planId:id('absent-plan')}})).rejects.toMatchObject({code:'NOT_FOUND'});});
it.each(['missing-object','wrong-owner-section','unsafe-path','unknown-collection','extra','unsafe-revision','unsafe-limit'] as const)('rejects the %s selector without returning arbitrary document or configuration data',async field=>{
  const f=await outlineFormalReadFixture();const action=field==='missing-object'?f.application.object({...f.address('adaptation_plans',id('absent-object')),command:{}}):field==='wrong-owner-section'?f.application.section({...f.address('outline_beats',f.snapshot.outline_beats[0]!.id),command:{section:'adaptation_plans.source.references'}}):field==='unsafe-path'?f.application.section({...f.address(),command:{section:'__proto__.private'}}):field==='unknown-collection'?f.application.object({...f.address('assets'),command:{}}):field==='extra'?f.application.list({...f.context(),command:{actor:'forged'}}):field==='unsafe-revision'?f.application.object({...f.address(),command:{revision:0}}):f.application.list({...f.context(),command:{limit:51}});
  await expect(action).rejects.toMatchObject({code:field==='missing-object'?'NOT_FOUND':'INVALID_INPUT'});
});
it('captures query and identity data before an awaited lookup and refuses command getters without invoking them',async()=>{
  const f=await outlineFormalReadFixture(),command={limit:1},context=f.context();let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});f.identities.resolveProject.mockImplementationOnce(async()=>{await gate;return {...f.scope,versionKey:f.target};});
  const pending=f.application.list({...context,command});command.limit=50;context.projectId='changed-after-start';release();expect((await pending).items).toHaveLength(1);expect(f.identities.resolveProject).toHaveBeenCalledWith(f.scope);
  const getter=vi.fn(()=>1),unsafe=Object.defineProperty({limit:1},'revision',{get:getter,enumerable:true});f.store.snapshot.mockClear();await expect(f.application.list({...f.context(),command:unsafe})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(getter).not.toHaveBeenCalled();expect(f.store.snapshot).not.toHaveBeenCalled();
});
it('returns detached or immutable overview data without changing the stored snapshot',async()=>{const f=await outlineFormalReadFixture(),before=structuredClone(f.snapshot),result=await f.application.object({...f.address(),command:{}});try{(result.overview.value as unknown as Record<string,unknown>)['id']=id('client-only');}catch{/* Frozen output is also detached from the authoritative snapshot. */}expect(f.snapshot).toEqual(before);});
it('reports an absent registered formal project consistently across all four read capabilities',async()=>{
  const f=await outlineFormalReadFixture();f.store.snapshot.mockResolvedValue(null);for(const read of [()=>f.application.list({...f.context(),command:{}}),()=>f.application.rows({...f.context(),command:{}}),()=>f.application.object({...f.address(),command:{}}),()=>f.application.section({...f.address(),command:{section:'adaptation_plans.beats'}})])await expect(read()).rejects.toMatchObject({code:'NOT_FOUND'});expect(f.store.snapshot).toHaveBeenCalledTimes(4);expect(f.source.exchange).toHaveBeenCalledTimes(1);
});
it('requires schema upgrade before projecting a legacy package returned by a trusted dependency',async()=>{
  const f=await outlineFormalReadFixture(),data=(await f.store.snapshot({target:f.target}))!,legacy=upgradeV05Package(makePackage());legacy.project.id=f.target.projectId;expect(validatePackage(legacy).valid).toBe(true);f.store.snapshot.mockResolvedValue({...data,packageId:legacy.package_id,revision:legacy.revision.number,snapshot:legacy as unknown as typeof data.snapshot});await expect(f.application.object({...f.address(),command:{}})).rejects.toMatchObject({code:'SCHEMA_UPGRADE_REQUIRED'});
});
it.each(['version','at-end','past-end'] as const)('rejects a section cursor forged to %s without returning a skipped or empty continuation',async kind=>{
  const f=await outlineFormalReadFixture(),page=await f.application.section({...f.address(),command:{section:'adaptation_plans.beats',limit:1}}),token=JSON.parse(Buffer.from(page.nextCursor!,'base64url').toString()) as {position:{version:number;offset:number}};
  if(kind==='version')token.position.version+=1;else token.position.offset=page.total+(kind==='past-end'?1:0);const cursor=Buffer.from(JSON.stringify(token)).toString('base64url');await expect(f.application.section({...f.address(),command:{section:'adaptation_plans.beats',cursor}})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(f.snapshot.adaptation_plans[0]!.beats).toHaveLength(page.total);
});
it('returns explicit zero counts and terminal empty pages for a valid package with no adopted outlines',async()=>{
  const f=await outlineFormalReadFixture(),empty=structuredClone(f.snapshot);for(const collection of OUTLINE_COLLECTIONS)empty[collection]=[];expect(validatePackage(empty).valid).toBe(true);f.snapshots.set(empty.revision.number,empty);
  const list=await f.application.list({...f.context(),command:{}}),bulk=await f.application.rows({...f.context(),command:{}});expect(list.items).toEqual([]);expect(bulk.rows).toEqual([]);expect(list.nextCursor).toBeNull();expect(bulk.nextCursor).toBeNull();expect(list.counts).toEqual(OUTLINE_COLLECTIONS.map(collection=>({collection,count:0})));expect(bulk.counts).toEqual(list.counts);await expect(f.application.object({...f.address(),command:{}})).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('marks a single requested oversized row as sectioned and resumes at its exact next record',async()=>{
  const f=await outlineFormalReadFixture({large:true}),first=await f.application.rows({...f.context(),command:{collection:'adaptation_plans',limit:1}});expect(first.rows).toHaveLength(1);expect(first.rows[0]!.kind).toBe('sectioned');expect(first.nextCursor).toBeNull();expect((await reconstructed(f,'adaptation_plans',first.rows[0]!.ref.id)).value).toEqual(f.snapshot.adaptation_plans[0]);expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(982784);
},30000);
it('shrinks an oversized bulk batch of valid complete plans while keeping every row and its continuation',async()=>{
  const f=await outlineFormalReadFixture(),snapshot=structuredClone(f.snapshot),plan=snapshot.adaptation_plans[0]!;
  // Imported formal graphs may reuse reviewed provenance; this tests transport capacity, not new review evidence.
  for(let index=plan.source.references.length;index<900;index++)plan.source.references.push({id:'batch-source-'+index,path:'/batch/'+index+'/'+'界'.repeat(230)});
  const second=structuredClone(snapshot),ids=new Map(OUTLINE_COLLECTIONS.flatMap(collection=>second[collection].map(row=>[row.id,id('batch-second-'+row.id)] as const)));
  function rebind(value:unknown):void{if(Array.isArray(value)){for(const child of value)rebind(child);return;}if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){if(typeof child==='string'&&ids.has(child))(value as Record<string,unknown>)[key]=ids.get(child)!;else rebind(child);}}
  for(const collection of OUTLINE_COLLECTIONS){rebind(second[collection]);(snapshot[collection] as unknown[]).push(...second[collection]);}
  StoryboardPackageV07.parse(snapshot);expect(validatePackage(snapshot).valid).toBe(true);expect(Buffer.byteLength(JSON.stringify(snapshot.adaptation_plans))).toBeGreaterThan(982784);for(const row of snapshot.adaptation_plans)expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(982784);f.snapshots.set(snapshot.revision.number,snapshot);
  const actual:unknown[]=[];let cursor:string|undefined,pages=0;do{const page=await f.application.rows({...f.context(),command:{collection:'adaptation_plans',limit:50,...(cursor?{cursor}:{})}});pages++;expect(page.rows).toHaveLength(1);expect(Buffer.byteLength(JSON.stringify({data:page,requestId:'11111111-1111-4111-8111-111111111111'}))).toBeLessThanOrEqual(983040);for(const row of page.rows){expect(row.kind).toBe('complete');if(row.kind==='complete')actual.push(row.record.value);}cursor=page.nextCursor??undefined;}while(cursor);expect(pages).toBe(2);expect(actual).toEqual([...snapshot.adaptation_plans].sort((a,b)=>a.id<b.id?-1:1));expect(f.source.exchange).toHaveBeenCalledTimes(1);
},30000);
it.each(['section-parent-null','section-parent-array','section-not-array','section-item-type','overview-parent-null','overview-field-type','bulk-record-type'] as const)('fails closed on corrupt dependency projection %s without leaking the malformed payload',async kind=>{
  const f=await outlineFormalReadFixture(),snapshot=structuredClone(f.snapshot),plan=snapshot.adaptation_plans[0]!,unsafe=plan as unknown as Record<string,unknown>;
  if(kind==='section-parent-null'||kind==='overview-parent-null')unsafe['source']=null;else if(kind==='section-parent-array')unsafe['source']=[];else if(kind==='section-not-array')(unsafe['source'] as Record<string,unknown>)['references']='private invalid references';else if(kind==='section-item-type')(unsafe['source'] as Record<string,unknown>)['references']=[{id:'private',path:42}];else (unsafe['adaptation'] as Record<string,unknown>)['title']={private:'invalid scalar'};
  f.snapshots.set(snapshot.revision.number,snapshot);const action=kind.startsWith('overview')?f.application.object({...f.address(),command:{}}):kind==='bulk-record-type'?f.application.rows({...f.context(),command:{collection:'adaptation_plans'}}):f.application.section({...f.address(),command:{section:'adaptation_plans.source.references'}}),failed=await action.catch((error:unknown)=>error);expect(failed).toMatchObject({code:'STORAGE_FAILED'});expect(String(failed)).not.toContain('private');expect(f.source.exchange).toHaveBeenCalledTimes(1);
});
