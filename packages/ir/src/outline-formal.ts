import {z} from 'zod';
import {StableId,RevisionRef,OUTLINE_COLLECTIONS,AdaptationPlan,OutlineBeat,OutlineEpisodePlan,AssetPlan,OutlinePlotUnit,OutlineAdaptationDecision} from './schema';

const ordinaryId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const stable=StableId.refine(value=>value.length===26);
const planRef=RevisionRef.extend({id:stable});
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision=count.min(1);
const decimal=z.string().regex(/^[1-9][0-9]*$(?![\s\S])/).transform(Number);
const readRevision=z.union([z.number(),decimal]).pipe(revision);
const limit=z.union([z.number(),decimal]).pipe(revision.max(50));
const cursor=z.string().min(1).max(4096);
export const OutlineFormalCollectionSchema=z.enum(OUTLINE_COLLECTIONS);
export type OutlineFormalCollection=z.infer<typeof OutlineFormalCollectionSchema>;
export const OutlineFormalRefSchema=z.strictObject({collection:OutlineFormalCollectionSchema,id:stable,version:revision});
export type OutlineFormalRef=z.infer<typeof OutlineFormalRefSchema>;

function definition<const C extends OutlineFormalCollection,const P extends readonly string[],S extends z.ZodType>(collection:C,path:P,element:S){return Object.freeze({collection,path:Object.freeze(path),element});}
/** Every selector is a fixed typed domain array; paths supplied by a client never become property access. */
export const OUTLINE_FORMAL_SECTIONS=Object.freeze({
  'adaptation_plans.source.references':definition('adaptation_plans',['source','references'],AdaptationPlan.shape.source.shape.references.element),
  'adaptation_plans.recipe.signature_scenes':definition('adaptation_plans',['recipe','signature_scenes'],AdaptationPlan.shape.recipe.shape.signature_scenes.element),
  'adaptation_plans.recipe.failure_modes':definition('adaptation_plans',['recipe','failure_modes'],AdaptationPlan.shape.recipe.shape.failure_modes.element),
  'adaptation_plans.recipe.ablations':definition('adaptation_plans',['recipe','ablations'],AdaptationPlan.shape.recipe.shape.ablations.element),
  'adaptation_plans.characters':definition('adaptation_plans',['characters'],AdaptationPlan.shape.characters.element),
  'adaptation_plans.decisions':definition('adaptation_plans',['decisions'],AdaptationPlan.shape.decisions.element),
  'adaptation_plans.beats':definition('adaptation_plans',['beats'],AdaptationPlan.shape.beats.element),
  'adaptation_plans.episodes':definition('adaptation_plans',['episodes'],AdaptationPlan.shape.episodes.element),
  'adaptation_plans.assets':definition('adaptation_plans',['assets'],AdaptationPlan.shape.assets.element),
  'adaptation_plans.plot_units':definition('adaptation_plans',['plot_units'],AdaptationPlan.shape.plot_units.element),
  'adaptation_plans.season_engine.characters':definition('adaptation_plans',['season_engine','characters'],AdaptationPlan.shape.season_engine.shape.characters.element),
  'adaptation_plans.season_engine.plot_units':definition('adaptation_plans',['season_engine','plot_units'],AdaptationPlan.shape.season_engine.shape.plot_units.element),
  'adaptation_plans.review.report.emotion_curve':definition('adaptation_plans',['review','report','emotion_curve'],AdaptationPlan.shape.review.shape.report.shape.emotion_curve.element),
  'adaptation_plans.review.report.issues':definition('adaptation_plans',['review','report','issues'],AdaptationPlan.shape.review.shape.report.shape.issues.element),
  'adaptation_plans.review.ablations':definition('adaptation_plans',['review','ablations'],AdaptationPlan.shape.review.shape.ablations.element),
  'adaptation_plans.review.waivers':definition('adaptation_plans',['review','waivers'],AdaptationPlan.shape.review.shape.waivers.element),
  'outline_beats.characters':definition('outline_beats',['characters'],OutlineBeat.shape.characters.element),
  'outline_episode_plans.beats':definition('outline_episode_plans',['beats'],OutlineEpisodePlan.shape.beats.element),
  'asset_plans.beats':definition('asset_plans',['beats'],AssetPlan.shape.beats.element),
  'asset_plans.prop_states':definition('asset_plans',['prop_states'],AssetPlan.shape.prop_states.element),
  'outline_plot_units.episodes':definition('outline_plot_units',['episodes'],OutlinePlotUnit.shape.episodes.element),
  'outline_plot_units.beats':definition('outline_plot_units',['beats'],OutlinePlotUnit.shape.beats.element),
});
export type OutlineFormalSection=keyof typeof OUTLINE_FORMAL_SECTIONS;
const sectionKeys=Object.keys(OUTLINE_FORMAL_SECTIONS) as [OutlineFormalSection,...OutlineFormalSection[]];
export const OutlineFormalSectionSchema=z.enum(sectionKeys);
export const OutlineFormalListQuerySchema=z.strictObject({revision:readRevision.optional(),collection:OutlineFormalCollectionSchema.optional(),planId:stable.optional(),cursor:cursor.optional(),limit:limit.optional()});
export type OutlineFormalListQuery=z.infer<typeof OutlineFormalListQuerySchema>;
export const OutlineFormalObjectQuerySchema=z.strictObject({revision:readRevision.optional()});
export type OutlineFormalObjectQuery=z.infer<typeof OutlineFormalObjectQuerySchema>;
export const OutlineFormalSectionQuerySchema=z.strictObject({revision:readRevision.optional(),section:OutlineFormalSectionSchema,cursor:cursor.optional(),limit:limit.optional()});
export type OutlineFormalSectionQuery=z.infer<typeof OutlineFormalSectionQuerySchema>;

export const OutlineFormalOverviewSchemas={
  adaptation_plans:AdaptationPlan.omit({characters:true,decisions:true,beats:true,episodes:true,assets:true,plot_units:true}).extend({
    source:AdaptationPlan.shape.source.omit({references:true}),
    recipe:AdaptationPlan.shape.recipe.omit({signature_scenes:true,failure_modes:true,ablations:true}),
    season_engine:AdaptationPlan.shape.season_engine.omit({characters:true,plot_units:true}),
    review:AdaptationPlan.shape.review.omit({ablations:true,waivers:true}).extend({report:AdaptationPlan.shape.review.shape.report.omit({emotion_curve:true,issues:true})}),
  }),
  outline_beats:OutlineBeat.omit({characters:true}),
  outline_episode_plans:OutlineEpisodePlan.omit({beats:true}),
  asset_plans:AssetPlan.omit({beats:true,prop_states:true}),
  outline_plot_units:OutlinePlotUnit.omit({episodes:true,beats:true}),
  outline_adaptation_decisions:OutlineAdaptationDecision,
} as const;
export const OutlineFormalOverviewSchema=z.discriminatedUnion('collection',[
  z.strictObject({collection:z.literal('adaptation_plans'),value:OutlineFormalOverviewSchemas.adaptation_plans}),
  z.strictObject({collection:z.literal('outline_beats'),value:OutlineFormalOverviewSchemas.outline_beats}),
  z.strictObject({collection:z.literal('outline_episode_plans'),value:OutlineFormalOverviewSchemas.outline_episode_plans}),
  z.strictObject({collection:z.literal('asset_plans'),value:OutlineFormalOverviewSchemas.asset_plans}),
  z.strictObject({collection:z.literal('outline_plot_units'),value:OutlineFormalOverviewSchemas.outline_plot_units}),
  z.strictObject({collection:z.literal('outline_adaptation_decisions'),value:OutlineFormalOverviewSchemas.outline_adaptation_decisions}),
]);
export type OutlineFormalOverview=z.infer<typeof OutlineFormalOverviewSchema>;
export const OutlineFormalRecordSchema=z.discriminatedUnion('collection',[
  z.strictObject({collection:z.literal('adaptation_plans'),value:AdaptationPlan}),
  z.strictObject({collection:z.literal('outline_beats'),value:OutlineBeat}),
  z.strictObject({collection:z.literal('outline_episode_plans'),value:OutlineEpisodePlan}),
  z.strictObject({collection:z.literal('asset_plans'),value:AssetPlan}),
  z.strictObject({collection:z.literal('outline_plot_units'),value:OutlinePlotUnit}),
  z.strictObject({collection:z.literal('outline_adaptation_decisions'),value:OutlineAdaptationDecision}),
]);
export type OutlineFormalRecord=z.infer<typeof OutlineFormalRecordSchema>;
const base=z.strictObject({contractVersion:z.literal(1),projectKey:ordinaryId,projectId:stable,schemaVersion:z.enum(['0.7.0-draft','0.8.0-draft']),snapshotRevision:revision,headRevision:revision,writeVersion:revision});
function snapshotBinding(value:{snapshotRevision:number;headRevision:number},context:z.RefinementCtx){if(value.snapshotRevision>value.headRevision)context.addIssue({code:'custom',message:'Selected snapshot must already belong to project history'});}
function planBinding(ref:OutlineFormalRef,plan:z.infer<typeof RevisionRef>,context:z.RefinementCtx){if(ref.collection==='adaptation_plans'&&(ref.id!==plan.id||ref.version!==plan.version))context.addIssue({code:'custom',message:'Plan object must identify itself'});}
const header=z.strictObject({ref:OutlineFormalRefSchema,plan:planRef});
const counts=z.array(z.strictObject({collection:OutlineFormalCollectionSchema,count})).max(6);
const objectBase=base.extend(header.shape);
function headerBindings(value:{items:readonly z.infer<typeof header>[];counts:z.infer<typeof counts>},context:z.RefinementCtx){
  const collections=new Set<string>(),objects=new Set<string>();
  for(const item of value.counts){if(collections.has(item.collection))context.addIssue({code:'custom',message:'Collection counts must be unique'});collections.add(item.collection);}
  for(const item of value.items){planBinding(item.ref,item.plan,context);const key=item.ref.collection+':'+item.ref.id;if(objects.has(key))context.addIssue({code:'custom',message:'Object headers must be unique'});objects.add(key);}
}
export const OutlineFormalListSchema=base.extend({items:z.array(header).max(50),counts,nextCursor:cursor.nullable()}).superRefine((value,context)=>{
  snapshotBinding(value,context);headerBindings(value,context);
});
export type OutlineFormalList=z.infer<typeof OutlineFormalListSchema>;
const objectBody=header.extend({overview:OutlineFormalOverviewSchema,sections:z.array(z.strictObject({section:OutlineFormalSectionSchema,total:count})).max(22)});
function objectBinding(value:z.infer<typeof objectBody>,context:z.RefinementCtx){
  planBinding(value.ref,value.plan,context);
  if(value.ref.collection!==value.overview.collection||value.ref.id!==value.overview.value.id||value.ref.version!==value.overview.value.version)context.addIssue({code:'custom',message:'Overview must match its exact object reference'});
  if('adaptation_plan' in value.overview.value&&(value.overview.value.adaptation_plan.id!==value.plan.id||value.overview.value.adaptation_plan.version!==value.plan.version))context.addIssue({code:'custom',message:'Overview parent must match its plan reference'});
  const expected=sectionKeys.filter(key=>OUTLINE_FORMAL_SECTIONS[key].collection===value.ref.collection),actual=new Set(value.sections.map(section=>section.section));
  if(actual.size!==value.sections.length||actual.size!==expected.length||expected.some(key=>!actual.has(key)))context.addIssue({code:'custom',message:'Object must describe every section exactly once, including empty arrays'});
}
export const OutlineFormalObjectSchema=base.extend(objectBody.shape).superRefine((value,context)=>{
  snapshotBinding(value,context);objectBinding(value,context);
});
export type OutlineFormalObject=z.infer<typeof OutlineFormalObjectSchema>;
const completeRow=header.extend({kind:z.literal('complete'),record:OutlineFormalRecordSchema}).superRefine((value,context)=>{
  planBinding(value.ref,value.plan,context);
  if(value.ref.collection!==value.record.collection||value.ref.id!==value.record.value.id||value.ref.version!==value.record.value.version)context.addIssue({code:'custom',message:'Complete record must match its exact object reference'});
  if('adaptation_plan' in value.record.value&&(value.record.value.adaptation_plan.id!==value.plan.id||value.record.value.adaptation_plan.version!==value.plan.version))context.addIssue({code:'custom',message:'Complete record parent must match its plan reference'});
});
const sectionedRow=objectBody.extend({kind:z.literal('sectioned')}).superRefine(objectBinding);
export const OutlineFormalRowSchema=z.discriminatedUnion('kind',[completeRow,sectionedRow]);
export type OutlineFormalRow=z.infer<typeof OutlineFormalRowSchema>;
/** Whole small rows and section descriptors share the same immutable snapshot and object binding. */
export const OutlineFormalRowsSchema=base.extend({rows:z.array(OutlineFormalRowSchema).max(50),counts,nextCursor:cursor.nullable()}).superRefine((value,context)=>{
  snapshotBinding(value,context);headerBindings({items:value.rows,counts:value.counts},context);
});
export type OutlineFormalRows=z.infer<typeof OutlineFormalRowsSchema>;
function page<const K extends OutlineFormalSection>(section:K){
  const definition=OUTLINE_FORMAL_SECTIONS[section];
  const element=definition.element as (typeof OUTLINE_FORMAL_SECTIONS)[K]['element'];
  return objectBase.extend({section:z.literal(section),total:count,items:z.array(element).max(50),nextCursor:cursor.nullable()}).superRefine((value,context)=>{
    snapshotBinding(value,context);planBinding(value.ref,value.plan,context);
    if(value.ref.collection!==definition.collection)context.addIssue({code:'custom',message:'Section must belong to the addressed collection'});
    if(value.items.length>value.total)context.addIssue({code:'custom',message:'A section page cannot contain more items than its total'});
  });
}
export const OutlineFormalSectionPageSchema=z.discriminatedUnion('section',[
  page('adaptation_plans.source.references'),page('adaptation_plans.recipe.signature_scenes'),page('adaptation_plans.recipe.failure_modes'),page('adaptation_plans.recipe.ablations'),
  page('adaptation_plans.characters'),page('adaptation_plans.decisions'),page('adaptation_plans.beats'),page('adaptation_plans.episodes'),page('adaptation_plans.assets'),page('adaptation_plans.plot_units'),
  page('adaptation_plans.season_engine.characters'),page('adaptation_plans.season_engine.plot_units'),page('adaptation_plans.review.report.emotion_curve'),page('adaptation_plans.review.report.issues'),page('adaptation_plans.review.ablations'),page('adaptation_plans.review.waivers'),
  page('outline_beats.characters'),page('outline_episode_plans.beats'),page('asset_plans.beats'),page('asset_plans.prop_states'),page('outline_plot_units.episodes'),page('outline_plot_units.beats'),
]);
export type OutlineFormalSectionPage=z.infer<typeof OutlineFormalSectionPageSchema>;
