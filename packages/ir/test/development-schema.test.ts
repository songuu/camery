import {expect,it} from 'vitest';
import {StoryboardPackage,SCHEMA_VERSION,upgradeV05Package,validatePackage,developmentDependencyIssues} from '../src/index';
import {fixtureId,makePackage} from './fixtures';
import {makeDevelopmentPackage as fixture} from './development-fixture';
const id=fixtureId;

it('reads an unchanged legacy package and creates an explicit empty v06 extension without invented content',()=>{
  const old=makePackage();expect(StoryboardPackage.parse(old)).toEqual(old);expect(validatePackage(old).valid).toBe(true);const p=upgradeV05Package(old);
  expect(SCHEMA_VERSION).toBe('0.6.0-draft');expect(p.schema_version).toBe(SCHEMA_VERSION);expect(p.worlds).toEqual([]);expect(p.development_plans).toEqual([]);expect(p.episode_plans).toEqual([]);expect(p.characters).toEqual(old.characters);expect(p.revision).toEqual(old.revision);expect(old.schema_version).toBe('0.5.0-draft');
});
it('retains complete typed development content and reviewer provenance in the v06 package',()=>{
  const p=fixture();expect(StoryboardPackage.parse(p)).toEqual(p);expect(validatePackage(p).valid).toBe(true);expect(developmentDependencyIssues(p)).toEqual([]);
});
it.each(['world-key','character','relationship','episode','plan','source','duplicate-key','duplicate-id','unknown-field'] as const)('rejects inconsistent development %s data',kind=>{
  const p=fixture();if(kind==='world-key')p.development_plans[0]!.mainline.rule_refs[0]!.key='missing';if(kind==='character')p.development_plans[0]!.characters[0]!.id=id('missing');
  if(kind==='relationship')p.character_relationships.push({id:id('relationship'),version:1,from_character_id:p.characters[0]!.id,to_character_id:id('missing'),text:'互相核对。'});
  if(kind==='episode')p.episode_plans[0]!.episode_id=id('missing');if(kind==='plan')p.episode_plans[0]!.development_plan.id=id('missing');if(kind==='source')p.episode_plans[0]!.source.stage='foundation' as never;
  if(kind==='duplicate-key')p.worlds[0]!.rules.push({...p.worlds[0]!.rules[0]!});if(kind==='duplicate-id')p.worlds[0]!.id=p.characters[0]!.id;if(kind==='unknown-field')Object.assign(p.development_plans[0]!,{raw_output:{hidden:true}});
  expect(validatePackage(p).valid).toBe(false);
});
it('keeps changed dependencies explicit for both the plan and downstream episodes without silently rebinding them',()=>{
  const p=fixture();p.worlds[0]!.version=2;p.worlds[0]!.rules=[];const report=validatePackage(p);expect(report.valid).toBe(true);expect(report.warnings.some(issue=>issue.code==='STALE_DEVELOPMENT_DEPENDENCY')).toBe(true);
  const issues=developmentDependencyIssues(p);expect(issues.map(issue=>issue.objectId)).toEqual(expect.arrayContaining([p.development_plans[0]!.id,p.episode_plans[0]!.id]));expect(p.development_plans[0]!.world.version).toBe(1);
});
it('validates locks against complete new objects and Character development fields',()=>{
  const p=fixture();p.locks.push({id:id('world-lock'),version:1,target:p.worlds[0]!.id,fields:['setting'],owner_id:id('user_1'),reason:'固定世界设定。'},{id:id('character-lock'),version:1,target:p.characters[0]!.id,fields:['development.arc'],owner_id:id('user_1'),reason:'保留已采用人物弧光。'});
  expect(validatePackage(p).valid).toBe(true);p.locks[0]!.fields=['missing'];expect(validatePackage(p).errors.some(issue=>issue.code==='LOCK_FIELD')).toBe(true);
});
it('allows continuity snapshots to pin an actual new development object revision',()=>{
  const p=fixture();p.episode_state_snapshots.push({id:id('development-snapshot'),version:1,episode_id:p.episodes[0]!.id,based_on:[{id:p.development_plans[0]!.id,version:1}],status:'adopted',facts:['已公开核对。'],knowledge:[],characters:[],plot_threads:[]});expect(validatePackage(p).valid).toBe(true);
});
it.each(['world','reviewer','dependency'] as const)('requires an exact canonical ULID in a new %s identity',kind=>{
  const p=fixture();if(kind==='world')p.worlds[0]!.id+='\n';if(kind==='reviewer')p.development_plans[0]!.source.reviewer_id+='\n';if(kind==='dependency')p.development_plans[0]!.world.id+='\n';expect(StoryboardPackage.safeParse(p).success).toBe(false);
});
it.each(['brief-id','brief-revision','brief-digest','source-tenant','source-project','source-run','future-plan','future-world','future-character','same-episode'] as const)('refuses incompatible or nonexistent %s dependencies',kind=>{
  const p=fixture();const episode=p.episode_plans[0]!;if(kind==='brief-id')episode.source.brief_id='other';if(kind==='brief-revision')episode.source.brief_revision=2;if(kind==='brief-digest')episode.source.brief_digest='d'.repeat(64);
  if(kind==='source-tenant')episode.source.tenant_key='other';if(kind==='source-project')episode.source.project_key='other';if(kind==='source-run')episode.source.run_digest='f'.repeat(64);
  if(kind==='future-plan')episode.development_plan.version=2;if(kind==='future-world')p.development_plans[0]!.world.version=2;if(kind==='future-character')episode.characters[0]!.version=p.characters[0]!.version+1;if(kind==='same-episode')p.episode_plans.push({...episode,id:id('duplicate-episode'),number:2});expect(validatePackage(p).valid).toBe(false);
});
