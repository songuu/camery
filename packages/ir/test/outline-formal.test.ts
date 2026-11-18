import {expect,it} from 'vitest';
import {AdaptationPlan,OutlineBeat,OutlineEpisodePlan,AssetPlan,OutlinePlotUnit,OutlineAdaptationDecision} from '../src/schema';
import {validatePackage} from '../src/validate';
import {WorkbenchReadQuerySchema,WorkbenchSubmitSchema} from '../src/workbench';
import {fixtureId as id,changeSet} from './fixtures';
import {makeOutlinePackage} from './outline-formal-fixture';
import {makeCapacityOutlinePackage} from './outline-formal-capacity-fixture';
import {OutlineFormalCollectionSchema,OutlineFormalRefSchema,OutlineFormalListQuerySchema,OutlineFormalObjectQuerySchema,OutlineFormalSectionQuerySchema,OutlineFormalListSchema,OutlineFormalObjectSchema,OutlineFormalOverviewSchema,OutlineFormalSectionPageSchema,OutlineFormalRecordSchema,OutlineFormalRowsSchema,OUTLINE_FORMAL_SECTIONS} from '../src/outline-formal';

const base={contractVersion:1,projectKey:'ordinary-project',projectId:id('formal-project'),schemaVersion:'0.7.0-draft',snapshotRevision:5,headRevision:7,writeVersion:9};
const schemas={adaptation_plans:AdaptationPlan,outline_beats:OutlineBeat,outline_episode_plans:OutlineEpisodePlan,asset_plans:AssetPlan,outline_plot_units:OutlinePlotUnit,outline_adaptation_decisions:OutlineAdaptationDecision};
type Collection=keyof typeof schemas;
function valueAt(input:Record<string,unknown>,path:readonly string[]):unknown{let value:unknown=input;for(const key of path)value=(value as Record<string,unknown>)[key];return value;}
function setAt(input:Record<string,unknown>,path:readonly string[],value:unknown):void{let target=input;for(const key of path.slice(0,-1))target=target[key] as Record<string,unknown>;target[path.at(-1)!]=value;}
function removeAt(input:Record<string,unknown>,path:readonly string[]):void{let target=input;for(const key of path.slice(0,-1))target=target[key] as Record<string,unknown>;delete target[path.at(-1)!];}
function detail(collection:Collection,value:Record<string,unknown>){
  const overview=structuredClone(value),sections=Object.entries(OUTLINE_FORMAL_SECTIONS).filter(([,definition])=>definition.collection===collection).map(([section,definition])=>{
    const rows=valueAt(value,definition.path);if(!Array.isArray(rows))throw new Error('Fixture must follow a real formal array');removeAt(overview,definition.path);return {section,total:rows.length};
  });
  const ref={collection,id:value['id'],version:value['version']},plan=collection==='adaptation_plans'?{id:value['id'],version:value['version']}:value['adaptation_plan'];return {...base,ref,plan,overview:{collection,value:overview},sections};
}
function sourceRow(collection:Collection){return structuredClone(makeOutlinePackage()[collection][0]!) as Record<string,unknown>;}

it('accepts only the six managed collections and canonical stable object identities',()=>{
  expect(OutlineFormalCollectionSchema.options).toEqual(Object.keys(schemas));
  expect(OutlineFormalRefSchema.parse({collection:'adaptation_plans',id:id('plan'),version:1})).toEqual({collection:'adaptation_plans',id:id('plan'),version:1});
  for(const value of ['characters','episodes','assets','__proto__'])expect(OutlineFormalCollectionSchema.safeParse(value).success).toBe(false);
  for(const value of [id('plan')+'x','bad',id('plan')+'\n'])expect(OutlineFormalRefSchema.safeParse({collection:'adaptation_plans',id:value,version:1}).success).toBe(false);
});
it('normalizes only canonical positive decimal read selectors',()=>{
  expect(OutlineFormalListQuerySchema.parse({revision:'5',limit:'50',collection:'outline_beats',planId:id('plan')})).toEqual({revision:5,limit:50,collection:'outline_beats',planId:id('plan')});
  expect(OutlineFormalObjectQuerySchema.parse({revision:5})).toEqual({revision:5});
  expect(OutlineFormalSectionQuerySchema.parse({revision:'5',section:'asset_plans.prop_states',limit:'10'})).toEqual({revision:5,section:'asset_plans.prop_states',limit:10});
});
it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1,Infinity,true,null,'','01',' 1','1e2','1\n'])('rejects unsafe read revisions %j',revision=>{
  for(const schema of [OutlineFormalListQuerySchema,OutlineFormalObjectQuerySchema])expect(schema.safeParse({revision}).success).toBe(false);
  expect(OutlineFormalSectionQuerySchema.safeParse({revision,section:'outline_beats.characters'}).success).toBe(false);
});
it.each(['path','actor','target','tenantId','value','snapshot','request','model'])('rejects arbitrary %s selectors at all public query boundaries',field=>{
  expect(OutlineFormalListQuerySchema.safeParse({[field]:'untrusted'}).success).toBe(false);expect(OutlineFormalObjectQuerySchema.safeParse({[field]:'untrusted'}).success).toBe(false);expect(OutlineFormalSectionQuerySchema.safeParse({section:'outline_beats.characters',[field]:'untrusted'}).success).toBe(false);
});
it('refuses arbitrary or prototype section paths and invalid pagination values',()=>{
  for(const section of ['adaptation_plans.source.token','adaptation_plans.__proto__','asset_plans.file.path','review.report',''])expect(OutlineFormalSectionQuerySchema.safeParse({section}).success).toBe(false);
  for(const limit of [0,51,true,null,'01','0','1e1','50\n'])expect(OutlineFormalSectionQuerySchema.safeParse({section:'asset_plans.beats',limit}).success).toBe(false);
  for(const cursor of ['', 'x'.repeat(4097)])expect(OutlineFormalListQuerySchema.safeParse({cursor}).success).toBe(false);
});
it.each(Object.keys(schemas) as Collection[])('round-trips every %s field through its typed overview and section pages',collection=>{
  const original=sourceRow(collection),view=OutlineFormalObjectSchema.parse(detail(collection,original)),rebuilt=structuredClone(view.overview.value) as Record<string,unknown>;
  expect(OutlineFormalOverviewSchema.parse(view.overview)).toEqual(view.overview);
  for(const descriptor of view.sections){
    const definition=OUTLINE_FORMAL_SECTIONS[descriptor.section],values=valueAt(original,definition.path) as unknown[],items:unknown[]=[];
    for(let offset=0;offset<Math.max(1,values.length);offset+=50){const page=OutlineFormalSectionPageSchema.parse({...base,ref:view.ref,plan:view.plan,section:descriptor.section,total:values.length,items:values.slice(offset,offset+50),nextCursor:offset+50<values.length?'next-page':null});items.push(...page.items);}
    setAt(rebuilt,definition.path,items);expect(descriptor.total).toBe(values.length);
  }
  expect(rebuilt).toEqual(original);expect(schemas[collection].parse(rebuilt)).toEqual(original);
});
it('publishes all twenty-two typed sections and retains explicit empty arrays',()=>{
  expect(Object.keys(OUTLINE_FORMAL_SECTIONS)).toHaveLength(22);const view=OutlineFormalObjectSchema.parse(detail('adaptation_plans',sourceRow('adaptation_plans')));
  expect(view.sections.find(row=>row.section==='adaptation_plans.recipe.ablations')).toEqual({section:'adaptation_plans.recipe.ablations',total:0});
  expect(view.sections.find(row=>row.section==='adaptation_plans.review.waivers')).toEqual({section:'adaptation_plans.review.waivers',total:0});
});
it('retains section-specific TypeScript values after discriminant narrowing',()=>{
  const view=OutlineFormalObjectSchema.parse(detail('adaptation_plans',sourceRow('adaptation_plans')));
  const source=OutlineFormalSectionPageSchema.parse({...base,ref:view.ref,plan:view.plan,section:'adaptation_plans.source.references',total:1,items:[{id:'source:clock',path:'/world'}],nextCursor:null});
  if(source.section==='adaptation_plans.source.references'){const path:string=source.items[0]!.path;expect(path).toBe('/world');}
  const modes=OutlineFormalSectionPageSchema.parse({...base,ref:view.ref,plan:view.plan,section:'adaptation_plans.recipe.failure_modes',total:1,items:['完整保留失败模式'],nextCursor:null});
  if(modes.section==='adaptation_plans.recipe.failure_modes'){const text:string=modes.items[0]!;expect(text).toBe('完整保留失败模式');}
});
it('keeps a valid formal plan larger than one MiB complete without widening old read or submit budgets',()=>{
  const pkg=makeCapacityOutlinePackage(),plan=pkg.adaptation_plans[0]!;
  plan.recipe.signature_scenes=Array.from({length:32},(_,index)=>({key:'large-scene-'+index,description:'完整规划场面。',beats:structuredClone(plan.beats)}));
  plan.source.references.push(...Array.from({length:2047},(_,index)=>({id:'source:extra-'+index,path:'/'+String(index).padStart(4,'0')+'/'+('路'.repeat(245))})));
  const validation=validatePackage(pkg);expect(validation.valid,JSON.stringify(validation.errors.slice(0,5))).toBe(true);expect(Buffer.byteLength(JSON.stringify(plan))).toBeGreaterThan(1_100_000);
  const original=plan as unknown as Record<string,unknown>,view=OutlineFormalObjectSchema.parse(detail('adaptation_plans',original)),rebuilt=structuredClone(view.overview.value) as Record<string,unknown>;
  expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(983040);
  for(const descriptor of view.sections){const definition=OUTLINE_FORMAL_SECTIONS[descriptor.section],values=valueAt(original,definition.path) as unknown[],items:unknown[]=[];for(let offset=0;offset<Math.max(1,values.length);offset+=10){const page=OutlineFormalSectionPageSchema.parse({...base,ref:view.ref,plan:view.plan,section:descriptor.section,total:values.length,items:values.slice(offset,offset+10),nextCursor:offset+10<values.length?'next-page':null});expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(983040);items.push(...page.items);}setAt(rebuilt,definition.path,items);}
  expect(rebuilt).toEqual(plan);expect(AdaptationPlan.parse(rebuilt)).toEqual(plan);expect(WorkbenchReadQuerySchema.safeParse({limit:200}).success).toBe(true);expect(WorkbenchReadQuerySchema.safeParse({limit:201}).success).toBe(false);
  const legacy=changeSet([{op:'update',op_id:id('legacy-op'),collection:'shots',target:id('legacy-shot'),set:{action:'候选'}}]);expect(WorkbenchSubmitSchema.shape.change.safeParse(legacy).success).toBe(true);expect(WorkbenchSubmitSchema.shape.change.safeParse({...legacy,ops:Array.from({length:500},()=>legacy.ops[0]!)}).success).toBe(true);expect(WorkbenchSubmitSchema.shape.change.safeParse({...legacy,ops:Array.from({length:501},()=>legacy.ops[0]!)}).success).toBe(false);
});
it.each(['collection','object','version','plan','section-missing','section-duplicate','section-foreign'] as const)('rejects inconsistent %s object metadata',kind=>{
  const input=detail('outline_beats',sourceRow('outline_beats'));
  if(kind==='collection')input.overview.collection='asset_plans';if(kind==='object')input.ref.id=id('other');if(kind==='version')input.ref.version=9;if(kind==='plan')input.plan={id:id('other-plan'),version:1};if(kind==='section-missing')input.sections=[];if(kind==='section-duplicate')input.sections.push({...input.sections[0]!});if(kind==='section-foreign')input.sections=[{section:'asset_plans.beats',total:1}];
  expect(OutlineFormalObjectSchema.safeParse(input).success).toBe(false);
});
it('rejects wrong section item types, owner collections and section totals',()=>{
  const view=OutlineFormalObjectSchema.parse(detail('outline_beats',sourceRow('outline_beats'))),page={...base,ref:view.ref,plan:view.plan,section:'outline_beats.characters',total:1,items:[{id:id('character'),version:1}],nextCursor:null};
  expect(OutlineFormalSectionPageSchema.parse(page)).toEqual(page);
  for(const input of [{...page,section:'asset_plans.prop_states'},{...page,items:[{text:'free JSON'}]},{...page,items:Array.from({length:51},()=>page.items[0])},{...page,total:0}])expect(OutlineFormalSectionPageSchema.safeParse(input).success).toBe(false);
});
it('pins selected snapshots to an adopted historical revision while exposing current metadata',()=>{
  const row=sourceRow('outline_beats'),view=detail('outline_beats',row),list={...base,items:[{ref:view.ref,plan:view.plan}],counts:[{collection:'outline_beats',count:1}],nextCursor:null};
  expect(OutlineFormalListSchema.parse(list)).toEqual(list);expect(OutlineFormalObjectSchema.parse(view).snapshotRevision).toBe(5);
  for(const schema of [OutlineFormalListSchema,OutlineFormalObjectSchema]){const input=schema===OutlineFormalListSchema?list:view;expect(schema.safeParse({...input,snapshotRevision:8}).success).toBe(false);expect(schema.safeParse({...input,schemaVersion:'0.6.0-draft'}).success).toBe(false);}
});
it('reads all six complete record kinds in one bounded typed rows page',()=>{
  const rows=(Object.keys(schemas) as Collection[]).map(collection=>{const value=sourceRow(collection),view=detail(collection,value),record=OutlineFormalRecordSchema.parse({collection,value});return {kind:'complete',ref:view.ref,plan:view.plan,record};});
  const input={...base,rows,counts:rows.map(row=>({collection:row.ref.collection,count:1})),nextCursor:null};expect(OutlineFormalRowsSchema.parse(input)).toEqual(input);
  expect(OutlineFormalRowsSchema.safeParse({...input,rows:Array.from({length:51},()=>rows[0])}).success).toBe(false);
  expect(OutlineFormalRowsSchema.safeParse({...input,rows:[rows[0],rows[0]]}).success).toBe(false);
});
it('preserves a sectioned record envelope alongside complete rows without hiding any scalar field',()=>{
  const value=sourceRow('adaptation_plans'),view=detail('adaptation_plans',value),row={kind:'sectioned',ref:view.ref,plan:view.plan,overview:view.overview,sections:view.sections};
  expect(OutlineFormalRowsSchema.parse({...base,rows:[row],counts:[{collection:'adaptation_plans',count:1}],nextCursor:null}).rows[0]).toEqual(row);
  expect(OutlineFormalRowsSchema.safeParse({...base,rows:[{...row,sections:[]}],counts:[],nextCursor:null}).success).toBe(false);
});
it.each(['collection','id','version','parent','self-parent','unknown-field'] as const)('rejects a complete row with wrong %s authority bindings',kind=>{
  const collection=kind==='self-parent'?'adaptation_plans':'outline_beats',value=sourceRow(collection),view=detail(collection,value),row={kind:'complete',ref:view.ref,plan:view.plan,record:{collection,value}};
  if(kind==='collection')row.record.collection='asset_plans';if(kind==='id')row.ref.id=id('wrong-row');if(kind==='version')row.ref.version=99;if(kind==='parent'||kind==='self-parent')row.plan={id:id('wrong-plan'),version:1};if(kind==='unknown-field')row.record.value['credential']='private';
  expect(OutlineFormalRowsSchema.safeParse({...base,rows:[row],counts:[],nextCursor:null}).success).toBe(false);
});
it('rejects ambiguous counts, noncanonical plan identities and future row snapshots',()=>{
  const view=detail('adaptation_plans',sourceRow('adaptation_plans')),row={kind:'sectioned',ref:view.ref,plan:view.plan,overview:view.overview,sections:view.sections},input={...base,rows:[row],counts:[{collection:'adaptation_plans',count:1}],nextCursor:null};
  expect(OutlineFormalRowsSchema.safeParse({...input,counts:[input.counts[0],input.counts[0]]}).success).toBe(false);expect(OutlineFormalRowsSchema.safeParse({...input,snapshotRevision:8}).success).toBe(false);
  expect(OutlineFormalObjectSchema.safeParse({...view,plan:{id:String(view.ref.id)+'\n',version:1}}).success).toBe(false);
  expect(OutlineFormalListSchema.safeParse({...base,items:[{ref:view.ref,plan:{id:id('wrong-self'),version:1}}],counts:[],nextCursor:null}).success).toBe(false);
});
