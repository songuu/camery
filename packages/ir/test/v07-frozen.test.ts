import {createHash} from 'node:crypto';
import {z} from 'zod';
import {expect,it} from 'vitest';
import {SCHEMA_VERSION,OUTLINE_SCHEMA_VERSION,DEVELOPMENT_SCHEMA_VERSION,StoryboardPackage,StoryboardPackageV07,ChangeSet,ChangeSetV07,EditableCollection,upgradeV06Package,toJsonSchema,toChangeSetJsonSchema} from '../src/legacy/v07-schema';
import {makeOutlinePackage} from './outline-formal-fixture';
import {makeDevelopmentPackage} from './development-fixture';
import {fixtureId as id,makePackage} from './fixtures';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const command=()=>({schema_version:'0.7.0-draft',id:id('frozen-v07-upgrade'),base_revision:5,base_revisions:[],status:'candidate',author:{kind:'user',id:id('user_1')},ops:[{op:'upgrade_schema',op_id:id('frozen-v07-upgrade-op'),from:'0.6.0-draft',to:'0.7.0-draft'}]});

it('freezes the released v07 strict package and change readers from measurements taken before v08',()=>{
  expect(SCHEMA_VERSION).toBe('0.7.0-draft');expect(OUTLINE_SCHEMA_VERSION).toBe('0.7.0-draft');expect(DEVELOPMENT_SCHEMA_VERSION).toBe('0.6.0-draft');
  expect(hash(z.toJSONSchema(StoryboardPackageV07))).toBe('86ba00a2a0c5cd6f1de053a0ae99687b85a439fb6f3ec96c85517b0d2c467a12');
  expect(hash(z.toJSONSchema(ChangeSetV07))).toBe('3ed5983a19d9b61321bf0cac63a50504f2936cee5b26fc05a075a2de3cfeb04e');
  expect(hash(toJsonSchema())).toBe('c59797a77a510e2a60f00fd8969240b8aafa630ca431bdbcdb863d71755d2e54');
  expect(hash(toChangeSetJsonSchema())).toBe('ad23fa37587112fe26943f7109028a67d085ac2a0b54faf05e71080ea928d285');
  expect(EditableCollection.options).toContain('adaptation_plans');expect(EditableCollection.options).not.toContain('continuity_snapshots');
});
it('retains exact v05/v06/v07 package round trips and the original pure adjacent conversion',()=>{
  const legacy=makePackage(),development=makeDevelopmentPackage(),outline=makeOutlinePackage(),saved=structuredClone(development);
  for(const p of [legacy,development,outline])expect(StoryboardPackage.parse(p)).toEqual(p);
  expect(upgradeV06Package(development)).toEqual({...development,schema_version:'0.7.0-draft',adaptation_plans:[],outline_beats:[],outline_episode_plans:[],asset_plans:[],outline_plot_units:[],outline_adaptation_decisions:[]});
  expect(development).toEqual(saved);
});
it.each(['version','collection','object-field'] as const)('rejects the v08 %s without stripping or promoting data',kind=>{
  const p=makeOutlinePackage(),input=kind==='version'?{...p,schema_version:'0.8.0-draft'}:kind==='collection'?{...p,continuity_snapshots:[]}:{...p,episodes:p.episodes.map(row=>({...row,continuity_ledger:{facts:[]}}))};
  expect(StoryboardPackageV07.safeParse(input).success).toBe(false);expect(StoryboardPackage.safeParse(input).success).toBe(false);
});
it('retains the v06 to v07 edge while rejecting v08 changes and new typed collection operations',()=>{
  expect(ChangeSet.parse(command())).toEqual(command());expect(ChangeSetV07.parse(command())).toEqual(command());
  expect(ChangeSetV07.safeParse({...command(),schema_version:'0.8.0-draft'}).success).toBe(false);
  expect(ChangeSet.safeParse({...command(),ops:[{...command().ops[0],from:'0.7.0-draft',to:'0.8.0-draft'}]}).success).toBe(false);
  expect(ChangeSetV07.safeParse({...command(),ops:[{op_id:id('frozen-v07-new-op'),op:'add',collection:'continuity_snapshots',value:{id:id('frozen-v07-new-snapshot'),version:1}}]}).success).toBe(false);
});
