import {z} from 'zod';
import * as v06 from './v06-schema';
import {AdaptationPlan,OutlineBeat,OutlineEpisodePlan,AssetPlan,OutlinePlotUnit,OutlineAdaptationDecision,OUTLINE_SCHEMA_VERSION} from '../outline-schema';
export * from './v06-schema';
export * from '../outline-schema';
export const DEVELOPMENT_SCHEMA_VERSION=v06.SCHEMA_VERSION;
export const SCHEMA_VERSION=OUTLINE_SCHEMA_VERSION;
export const OUTLINE_COLLECTIONS=['adaptation_plans','outline_beats','outline_episode_plans','asset_plans','outline_plot_units','outline_adaptation_decisions'] as const;
export const StoryboardPackageV07=v06.StoryboardPackageV06.extend({schema_version:z.literal(SCHEMA_VERSION),
  adaptation_plans:z.array(AdaptationPlan),outline_beats:z.array(OutlineBeat),outline_episode_plans:z.array(OutlineEpisodePlan),
  asset_plans:z.array(AssetPlan),outline_plot_units:z.array(OutlinePlotUnit),outline_adaptation_decisions:z.array(OutlineAdaptationDecision),
});
export type StoryboardPackageV07=z.infer<typeof StoryboardPackageV07>;
export const StoryboardPackage=z.discriminatedUnion('schema_version',[v06.StoryboardPackageV05,v06.StoryboardPackageV06,StoryboardPackageV07]);
export type StoryboardPackage=z.infer<typeof StoryboardPackage>;
export const EditableCollection=z.enum([...v06.EditableCollection.options,...OUTLINE_COLLECTIONS]);
export type EditableCollection=z.infer<typeof EditableCollection>;
export const UpgradeSchemaOp=z.strictObject({op_id:v06.StableId,op:z.literal('upgrade_schema'),from:z.enum([v06.LEGACY_SCHEMA_VERSION,DEVELOPMENT_SCHEMA_VERSION]),to:z.enum([DEVELOPMENT_SCHEMA_VERSION,SCHEMA_VERSION])})
  .refine(op=>op.from===v06.LEGACY_SCHEMA_VERSION?op.to===DEVELOPMENT_SCHEMA_VERSION:op.to===SCHEMA_VERSION,{message:'Only adjacent schema upgrades are supported'});
const editOperations=[
  v06.ChangeOp.options[0].extend({collection:EditableCollection}),v06.ChangeOp.options[1].extend({collection:EditableCollection}),
  v06.ChangeOp.options[2].extend({collection:EditableCollection}),v06.ChangeOp.options[3].extend({collection:EditableCollection}),
  v06.ChangeOp.options[4],v06.ChangeOp.options[5],v06.ChangeOp.options[6],v06.ChangeOp.options[7],v06.ChangeOp.options[8],v06.ChangeOp.options[9],
] as const;
export const ChangeOp=z.discriminatedUnion('op',[...editOperations,UpgradeSchemaOp]);
export type ChangeOp=z.infer<typeof ChangeOp>;
export const ChangeOpV07=z.discriminatedUnion('op',[...editOperations,v06.UpgradeSchemaOp.extend({from:z.literal(DEVELOPMENT_SCHEMA_VERSION),to:z.literal(SCHEMA_VERSION)})]);
export const ChangeSetV07=v06.ChangeSetV06.extend({schema_version:z.literal(SCHEMA_VERSION),ops:z.array(ChangeOpV07).min(1)});
export type ChangeSetV07=z.infer<typeof ChangeSetV07>;
export const ChangeSet=z.discriminatedUnion('schema_version',[v06.ChangeSetV05,v06.ChangeSetV06,ChangeSetV07]);
export type ChangeSet=z.infer<typeof ChangeSet>;
/** Pure conversion only. Persisting the new schema still requires its own explicitly adopted project ChangeSet. */
export function upgradeV06Package(input:unknown):StoryboardPackageV07{
  const old=v06.StoryboardPackageV06.parse(input);return StoryboardPackageV07.parse({...old,schema_version:SCHEMA_VERSION,
    adaptation_plans:[],outline_beats:[],outline_episode_plans:[],asset_plans:[],outline_plot_units:[],outline_adaptation_decisions:[]});
}
export function toJsonSchema():Record<string,unknown>{return z.toJSONSchema(StoryboardPackage);}
export function toChangeSetJsonSchema():Record<string,unknown>{return z.toJSONSchema(ChangeSet);}
