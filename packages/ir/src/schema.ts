import {z} from 'zod';
import * as v07 from './legacy/v07-schema';
import {ContinuitySnapshotSchema,CONTINUITY_SCHEMA_VERSION} from './continuity-schema';
export * from './legacy/v07-schema';
export * from './continuity-schema';
export const SCHEMA_VERSION=CONTINUITY_SCHEMA_VERSION;
export const CONTINUITY_COLLECTIONS=['continuity_snapshots'] as const;
export const StoryboardPackageV08=v07.StoryboardPackageV07.extend({schema_version:z.literal(SCHEMA_VERSION),continuity_snapshots:z.array(ContinuitySnapshotSchema)});
export type StoryboardPackageV08=z.infer<typeof StoryboardPackageV08>;
export const StoryboardPackage=z.discriminatedUnion('schema_version',[v07.StoryboardPackageV05,v07.StoryboardPackageV06,v07.StoryboardPackageV07,StoryboardPackageV08]);
export type StoryboardPackage=z.infer<typeof StoryboardPackage>;
export const EditableCollection=z.enum([...v07.EditableCollection.options,...CONTINUITY_COLLECTIONS]);
export type EditableCollection=z.infer<typeof EditableCollection>;
export const UpgradeSchemaOp=z.strictObject({op_id:v07.StableId,op:z.literal('upgrade_schema'),from:z.enum([v07.LEGACY_SCHEMA_VERSION,v07.DEVELOPMENT_SCHEMA_VERSION,v07.OUTLINE_SCHEMA_VERSION]),to:z.enum([v07.DEVELOPMENT_SCHEMA_VERSION,v07.OUTLINE_SCHEMA_VERSION,SCHEMA_VERSION])})
  .refine(op=>op.to===(op.from===v07.LEGACY_SCHEMA_VERSION?v07.DEVELOPMENT_SCHEMA_VERSION:op.from===v07.DEVELOPMENT_SCHEMA_VERSION?v07.OUTLINE_SCHEMA_VERSION:SCHEMA_VERSION),{message:'Only adjacent schema upgrades are supported'});
const editOperations=[
  v07.ChangeOpV07.options[0].extend({collection:EditableCollection}),v07.ChangeOpV07.options[1].extend({collection:EditableCollection}),
  v07.ChangeOpV07.options[2].extend({collection:EditableCollection}),v07.ChangeOpV07.options[3].extend({collection:EditableCollection}),
  v07.ChangeOpV07.options[4],v07.ChangeOpV07.options[5],v07.ChangeOpV07.options[6],v07.ChangeOpV07.options[7],v07.ChangeOpV07.options[8],v07.ChangeOpV07.options[9],
] as const;
export const ChangeOp=z.discriminatedUnion('op',[...editOperations,UpgradeSchemaOp]);
export type ChangeOp=z.infer<typeof ChangeOp>;
export const ChangeOpV08=z.discriminatedUnion('op',[...editOperations,z.strictObject({op_id:v07.StableId,op:z.literal('upgrade_schema'),from:z.literal(v07.OUTLINE_SCHEMA_VERSION),to:z.literal(SCHEMA_VERSION)})]);
export const ChangeSetV08=v07.ChangeSetV07.extend({schema_version:z.literal(SCHEMA_VERSION),ops:z.array(ChangeOpV08).min(1)});
export type ChangeSetV08=z.infer<typeof ChangeSetV08>;
export const ChangeSet=z.discriminatedUnion('schema_version',[v07.ChangeSetV05,v07.ChangeSetV06,v07.ChangeSetV07,ChangeSetV08]);
export type ChangeSet=z.infer<typeof ChangeSet>;
/** Pure conversion only. Persisting v08 requires a separate human-adopted project ChangeSet. */
export function upgradeV07Package(input:unknown):StoryboardPackageV08{
  const old=v07.StoryboardPackageV07.parse(input);return StoryboardPackageV08.parse({...old,schema_version:SCHEMA_VERSION,continuity_snapshots:[]});
}
export function toJsonSchema():Record<string,unknown>{return z.toJSONSchema(StoryboardPackage);}
export function toChangeSetJsonSchema():Record<string,unknown>{return z.toJSONSchema(ChangeSet);}
