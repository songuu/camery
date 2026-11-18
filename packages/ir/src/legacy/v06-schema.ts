import {z} from 'zod';
import * as v05 from './v05-schema';
// The old schema remains a strict reader, including its original object and operation shapes.
export * from './v05-schema';
export const LEGACY_SCHEMA_VERSION=v05.SCHEMA_VERSION;
export const SCHEMA_VERSION='0.6.0-draft' as const;
const text=(max:number)=>z.string().min(1).max(max).refine(value=>value.trim().length>0&&value.isWellFormed()&&!value.includes('\0'));
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity={id:v05.StableId,version:integer.min(1)};
const key=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$(?![\s\S])/);
const appId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const digest=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
/** A rule key belongs to its World; it is not a package-global object identity. */
export const DevelopmentRuleRef=z.strictObject({world_id:v05.StableId,key});
export const CharacterDevelopment=z.strictObject({function:z.enum(['protagonist','antagonist','supporting']),desire:text(500),obstacle:text(500),arc:text(1000)});
export const World=z.strictObject({...identity,setting:text(1000),era:text(200),rules:z.array(z.strictObject({key,text:text(1000)})).max(32)});
export type World=z.infer<typeof World>;
export const CharacterRelationship=z.strictObject({...identity,from_character_id:v05.StableId,to_character_id:v05.StableId,text:text(500)});
export type CharacterRelationship=z.infer<typeof CharacterRelationship>;
const provenance={tenant_key:appId,project_key:appId,run_id:appId,run_digest:digest,brief_id:appId,brief_revision:integer.min(1),brief_digest:digest,candidate_digest:digest,review_digest:digest,
  reviewer_id:v05.StableId,reviewer_key:appId,reviewed_at:z.iso.datetime({precision:3})};
export const DevelopmentPlan=z.strictObject({...identity,title:text(120),
  brief:z.strictObject({idea:text(2000),episode_count:integer.min(1).max(100),target_seconds:integer.min(1).max(3600)}),
  world:v05.RevisionRef,characters:z.array(v05.RevisionRef).min(1).max(32),relationships:z.array(v05.RevisionRef).max(64),
  mainline:z.strictObject({premise:text(1000),central_conflict:text(1000),stakes:text(1000),progression:text(2000),resolution:text(1000),
    character_ids:z.array(v05.StableId).min(1).max(32),rule_refs:z.array(DevelopmentRuleRef).max(32)}),
  open_questions:z.array(z.strictObject({key,text:text(500)})).max(16),source:z.strictObject({...provenance,stage:z.literal('foundation')}),
});
export type DevelopmentPlan=z.infer<typeof DevelopmentPlan>;
export const EpisodePlan=z.strictObject({...identity,episode_id:v05.StableId,number:integer.min(1).max(100),development_plan:v05.RevisionRef,
  summary:text(1200),goal:text(500),conflict:text(500),turn:text(500),ending:text(500),characters:z.array(v05.RevisionRef).min(1).max(32),rule_refs:z.array(DevelopmentRuleRef).max(32),
  source:z.strictObject({...provenance,stage:z.literal('episodes')}),
});
export type EpisodePlan=z.infer<typeof EpisodePlan>;
export const StoryboardPackageV05=v05.StoryboardPackage;
export type StoryboardPackageV05=z.infer<typeof StoryboardPackageV05>;
export const StoryboardPackageV06=v05.StoryboardPackage.extend({schema_version:z.literal(SCHEMA_VERSION),
  characters:z.array(v05.StoryboardPackage.shape.characters.element.extend({development:CharacterDevelopment.optional()})),
  worlds:z.array(World),character_relationships:z.array(CharacterRelationship),development_plans:z.array(DevelopmentPlan),episode_plans:z.array(EpisodePlan),
});
export type StoryboardPackageV06=z.infer<typeof StoryboardPackageV06>;
export const StoryboardPackage=z.discriminatedUnion('schema_version',[StoryboardPackageV05,StoryboardPackageV06]);
export type StoryboardPackage=z.infer<typeof StoryboardPackage>;
export const EditableCollection=z.enum([...v05.EditableCollection.options,'worlds','character_relationships','development_plans','episode_plans']);
export type EditableCollection=z.infer<typeof EditableCollection>;
export const UpgradeSchemaOp=z.strictObject({op_id:v05.StableId,op:z.literal('upgrade_schema'),from:z.literal(LEGACY_SCHEMA_VERSION),to:z.literal(SCHEMA_VERSION)});
export const ChangeOp=z.discriminatedUnion('op',[
  v05.ChangeOp.options[0].extend({collection:EditableCollection}),v05.ChangeOp.options[1].extend({collection:EditableCollection}),
  v05.ChangeOp.options[2].extend({collection:EditableCollection}),v05.ChangeOp.options[3].extend({collection:EditableCollection}),
  v05.ChangeOp.options[4],v05.ChangeOp.options[5],v05.ChangeOp.options[6],v05.ChangeOp.options[7],v05.ChangeOp.options[8],v05.ChangeOp.options[9],UpgradeSchemaOp,
]);
export type ChangeOp=z.infer<typeof ChangeOp>;
export const ChangeSetV05=v05.ChangeSet;
export type ChangeSetV05=z.infer<typeof ChangeSetV05>;
export const ChangeSetV06=v05.ChangeSet.extend({schema_version:z.literal(SCHEMA_VERSION),ops:z.array(ChangeOp).min(1)});
export const ChangeSet=z.discriminatedUnion('schema_version',[ChangeSetV05,ChangeSetV06]);
export type ChangeSet=z.infer<typeof ChangeSet>;
/** Pure structural conversion. Only an explicitly adopted upgrade ChangeSet may change a persisted head. */
export function upgradeV05Package(input:unknown):StoryboardPackageV06{
  const old=StoryboardPackageV05.parse(input);return StoryboardPackageV06.parse({...old,schema_version:SCHEMA_VERSION,worlds:[],character_relationships:[],development_plans:[],episode_plans:[]});
}
export function toJsonSchema():Record<string,unknown>{return z.toJSONSchema(StoryboardPackage);}
export function toChangeSetJsonSchema():Record<string,unknown>{return z.toJSONSchema(ChangeSet);}
