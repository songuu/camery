import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {SCHEMA_VERSION,LEGACY_SCHEMA_VERSION,StoryboardPackage,StoryboardPackageV05,StoryboardPackageV06,ChangeSet,ChangeSetV06,EditableCollection,upgradeV05Package,toJsonSchema,toChangeSetJsonSchema} from '../src/legacy/v06-schema';
import {developmentDependencyIssues,parsedDevelopmentDependencyIssues,validatePackage,validateParsedDevelopment} from '../src/legacy/v06-validate';
import {fixtureId,makePackage} from './fixtures';
import {makeDevelopmentPackage} from './development-fixture';
const id=fixtureId;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

it('freezes both old strict package and ChangeSet JSON schemas, independently of the newest reader',()=>{
  expect(SCHEMA_VERSION).toBe('0.6.0-draft');expect(LEGACY_SCHEMA_VERSION).toBe('0.5.0-draft');
  // Recorded from the v0.6 reader before introducing v0.7, rather than from a mutable generated file.
  expect(hash(toJsonSchema())).toBe('f6c11e6ac5719ed2f074cd416adb48d16660fbf124f2ea59d7b192f7a1ca9883');
  expect(hash(toChangeSetJsonSchema())).toBe('33c3368c45f988c8c6278692062eb749a82a59416838b3f36706f5c539d30487');
  expect(EditableCollection.options).not.toContain('adaptation_plans');
});
it('retains the exact v05 to v06 upgrade and leaves every original field and input unchanged',()=>{
  const old=StoryboardPackageV05.parse(makePackage()),saved=structuredClone(old),upgraded=upgradeV05Package(old);
  expect(StoryboardPackage.parse(old)).toEqual(old);expect(validatePackage(old).valid).toBe(true);expect(developmentDependencyIssues(old)).toEqual([]);
  expect(upgraded).toEqual({...old,schema_version:'0.6.0-draft',worlds:[],character_relationships:[],development_plans:[],episode_plans:[]});expect(old).toEqual(saved);
  expect(StoryboardPackageV06.parse(upgraded)).toEqual(upgraded);expect(validatePackage(upgraded).valid).toBe(true);
});
it.each(['new-version','new-collection','new-character-field'] as const)('keeps the v06 package reader strict against %s',kind=>{
  const p=makeDevelopmentPackage();const changed=kind==='new-version'?{...p,schema_version:'0.7.0-draft'}:kind==='new-collection'?{...p,adaptation_plans:[]}:{...p,characters:p.characters.map(character=>({...character,outline_origin:'untrusted'}))};
  expect(StoryboardPackage.safeParse(changed).success).toBe(false);expect(validatePackage(changed).errors.some(issue=>issue.code==='SCHEMA')).toBe(true);
});
it('keeps the old upgrade operation exclusive to the existing v05 to v06 version pair',()=>{
  const command={schema_version:'0.6.0-draft',id:id('v06-change'),base_revision:5,base_revisions:[],status:'candidate',author:{kind:'user',id:id('v06-author')},ops:[{op:'upgrade_schema',op_id:id('v06-upgrade'),from:'0.5.0-draft',to:'0.6.0-draft'}]};
  expect(ChangeSetV06.safeParse(command).success).toBe(true);expect(ChangeSet.safeParse(command).success).toBe(true);
  expect(ChangeSetV06.safeParse({...command,ops:[{...command.ops[0],from:'0.6.0-draft',to:'0.7.0-draft'}]}).success).toBe(false);
  expect(ChangeSet.safeParse({...command,schema_version:'0.7.0-draft'}).success).toBe(false);
  expect(ChangeSetV06.safeParse({...command,ops:[{op:'add',op_id:id('new-collection'),collection:'adaptation_plans',value:{id:id('new-plan'),version:1}}]}).success).toBe(false);
});
it('replays unchanged development semantics and exposes matching pinned dependency issues',()=>{
  const p=makeDevelopmentPackage();expect(validatePackage(p).valid).toBe(true);expect(validateParsedDevelopment(p)).toEqual(validatePackage(p));
  expect(developmentDependencyIssues(p)).toEqual([]);p.worlds[0]!.version=2;
  expect(parsedDevelopmentDependencyIssues(p)).toEqual(developmentDependencyIssues(p));expect(developmentDependencyIssues(p).map(issue=>issue.objectId)).toEqual(expect.arrayContaining([p.development_plans[0]!.id,p.episode_plans[0]!.id]));
  expect(validateParsedDevelopment(p).warnings.some(issue=>issue.code==='STALE_DEVELOPMENT_DEPENDENCY')).toBe(true);
  p.worlds[0]!.version=1;p.development_plans[0]!.world.version=2;expect(validateParsedDevelopment(p).errors.some(issue=>issue.code==='FUTURE_DEVELOPMENT_DEPENDENCY')).toBe(true);
});
it('lets parsed newer complete graphs register extra objects for IDs, locks and continuity without stripping them',()=>{
  const p=Object.assign(makeDevelopmentPackage(),{outline_nodes:[{id:id('new-outline-node'),version:1,description:'保留已经采用的计划。'}]});
  p.locks.push({id:id('new-outline-lock'),version:1,target:p.outline_nodes[0]!.id,fields:['description'],owner_id:id('user_1'),reason:'锁定规划文本。'});
  p.episode_state_snapshots.push({id:id('new-outline-snapshot'),version:1,episode_id:p.episodes[0]!.id,based_on:[{id:p.outline_nodes[0]!.id,version:1}],status:'adopted',facts:['新对象在完整图中。'],knowledge:[],characters:[],plot_threads:[]});
  expect(validateParsedDevelopment(p).valid).toBe(true);p.locks.at(-1)!.fields=['missing'];expect(validateParsedDevelopment(p).errors.some(issue=>issue.code==='LOCK_FIELD')).toBe(true);
  p.locks.at(-1)!.fields=['description'];p.outline_nodes[0]!.id=p.characters[0]!.id;expect(validateParsedDevelopment(p).errors.some(issue=>issue.code==='DUPLICATE_ID')).toBe(true);
  expect(StoryboardPackageV06.safeParse(p).success).toBe(false);
});
