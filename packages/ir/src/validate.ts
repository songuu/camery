import {StoryboardPackage,LEGACY_SCHEMA_VERSION} from './schema';
import type {StoryboardPackageV06} from './schema';
import {validatePackage as validateV05,validateParsedCore} from './legacy/v05-validate';
import type {Issue,ValidationOptions,ValidationReport} from './legacy/v05-validate';
export type {Issue,ValidationOptions,ValidationReport} from './legacy/v05-validate';
export interface DevelopmentDependencyIssue {readonly objectId:string;readonly referenceId:string;readonly expectedVersion:number;readonly actualVersion:number|null}
/** Derived freshness never rewrites an old reference to whichever content is current. Consumers must gate new generation on this result. */
export function developmentDependencyIssues(pkg:StoryboardPackage):readonly DevelopmentDependencyIssue[]{
  if(pkg.schema_version===LEGACY_SCHEMA_VERSION)return [];
  const versions=new Map<string,number>();for(const rows of Object.values(pkg))if(Array.isArray(rows))for(const row of rows)if(row&&typeof row==='object'&&'id' in row&&'version' in row)versions.set(row.id,row.version);
  const result:DevelopmentDependencyIssue[]=[];const check=(objectId:string,ref:{id:string;version:number})=>{const actualVersion=versions.get(ref.id)??null;if(actualVersion!==ref.version)result.push({objectId,referenceId:ref.id,expectedVersion:ref.version,actualVersion});};
  const planRefs=(plan:StoryboardPackageV06['development_plans'][number])=>[plan.world,...plan.characters,...plan.relationships];
  for(const plan of pkg.development_plans)for(const ref of planRefs(plan))check(plan.id,ref);
  for(const episode of pkg.episode_plans){check(episode.id,episode.development_plan);for(const ref of episode.characters)check(episode.id,ref);const plan=pkg.development_plans.find(row=>row.id===episode.development_plan.id);if(plan?.version===episode.development_plan.version)for(const ref of planRefs(plan))check(episode.id,ref);}
  return result;
}
export function validatePackage(input:unknown,options:ValidationOptions={}):ValidationReport{
  if(input!==null&&typeof input==='object'&&Object.getOwnPropertyDescriptor(input,'schema_version')?.value===LEGACY_SCHEMA_VERSION)return validateV05(input,options);
  const parsed=StoryboardPackage.safeParse(input);if(!parsed.success)return {valid:false,errors:parsed.error.issues.map(issue=>({code:'SCHEMA',where:'/'+issue.path.join('/'),message:issue.message})),warnings:[],meaning:'仅检查结构、引用、版本和声明；不代表真实模型质量或人工批准。'};
  const p=parsed.data;if(p.schema_version===LEGACY_SCHEMA_VERSION)return validateV05(p,options);
  // The parsed complete graph lets the original lock and snapshot checks see new objects and fields too.
  const {worlds,character_relationships,development_plans,episode_plans}=p;
  const report=validateParsedCore(p,options);const errors:Issue[]=[...report.errors];const warnings:Issue[]=[...report.warnings];
  const error=(code:string,where:string,message:string)=>{errors.push({code,where,message});};
  const unique=(values:readonly string[],where:string)=>{if(new Set(values).size!==values.length)error('DUPLICATE_REFERENCE',where,'References or local keys must be unique in their namespace');};
  const need=<T extends {id:string}>(rows:readonly T[],id:string,where:string)=>{const row=rows.find(value=>value.id===id);if(!row)error('MISSING_REFERENCE',where,'Referenced development object is absent from the expected collection');return row;};
  const rules=(refs:StoryboardPackageV06['episode_plans'][number]['rule_refs'],plan:StoryboardPackageV06['development_plans'][number],where:string)=>{
    unique(refs.map(ref=>ref.world_id+'/'+ref.key),where);for(const [index,ref] of refs.entries()){
      if(ref.world_id!==plan.world.id){error('DEVELOPMENT_SCOPE',where+'/'+index,'Rule belongs to a different development World');continue;}
      const world=need(worlds,ref.world_id,where+'/'+index);if(world?.version===plan.world.version&&!world.rules.some(rule=>rule.key===ref.key))error('MISSING_REFERENCE',where+'/'+index,'Rule key is absent from the referenced World version');
    }
  };
  worlds.forEach((world,index)=>unique(world.rules.map(rule=>rule.key),`/worlds/${index}/rules`));
  character_relationships.forEach((relation,index)=>{need(p.characters,relation.from_character_id,`/character_relationships/${index}/from_character_id`);need(p.characters,relation.to_character_id,`/character_relationships/${index}/to_character_id`);if(relation.from_character_id===relation.to_character_id)error('SELF_RELATIONSHIP',`/character_relationships/${index}`,'Relationship requires two different characters');});
  development_plans.forEach((plan,index)=>{
    const path=`/development_plans/${index}`;need(worlds,plan.world.id,path+'/world');unique(plan.characters.map(ref=>ref.id),path+'/characters');unique(plan.relationships.map(ref=>ref.id),path+'/relationships');unique(plan.open_questions.map(question=>question.key),path+'/open_questions');unique(plan.mainline.character_ids,path+'/mainline/character_ids');
    const members=new Set(plan.characters.map(ref=>ref.id));let protagonist=false;
    for(const ref of plan.characters){const character=need(p.characters,ref.id,path+'/characters');if(character?.version===ref.version){if(!character.development)error('INCOMPLETE_DEVELOPMENT',path+'/characters','Current referenced character lacks complete development fields');if(character.development?.function==='protagonist')protagonist=true;}}
    if(plan.characters.every(ref=>p.characters.some(character=>character.id===ref.id&&character.version===ref.version))&&!protagonist)error('PROTAGONIST_REQUIRED',path+'/characters','Development plan needs a protagonist');
    for(const ref of plan.relationships){const relation=need(character_relationships,ref.id,path+'/relationships');if(relation?.version===ref.version&&(!members.has(relation.from_character_id)||!members.has(relation.to_character_id)))error('DEVELOPMENT_SCOPE',path+'/relationships','Relationship leaves the plan character set');}
    for(const id of plan.mainline.character_ids)if(!members.has(id))error('DEVELOPMENT_SCOPE',path+'/mainline/character_ids','Mainline character is outside the plan');
    const activeCharacters=plan.characters.map(ref=>p.characters.find(character=>character.id===ref.id&&character.version===ref.version));if(activeCharacters.some(character=>character?.development?.function==='protagonist')&&!activeCharacters.some(character=>character?.development?.function==='protagonist'&&plan.mainline.character_ids.includes(character.id)))error('PROTAGONIST_REQUIRED',path+'/mainline/character_ids','Mainline must include a plan protagonist');
    rules(plan.mainline.rule_refs,plan,path+'/mainline/rule_refs');
  });
  const slots=new Set<string>();const episodeIds=new Set<string>();episode_plans.forEach((episode,index)=>{
    const path=`/episode_plans/${index}`;need(p.episodes,episode.episode_id,path+'/episode_id');const plan=need(development_plans,episode.development_plan.id,path+'/development_plan');unique(episode.characters.map(ref=>ref.id),path+'/characters');for(const ref of episode.characters)need(p.characters,ref.id,path+'/characters');
    const slot=episode.development_plan.id+'/'+episode.number;if(slots.has(slot))error('DUPLICATE_EPISODE_PLAN',path,'A plan cannot define an episode number twice');slots.add(slot);
    const episodeKey=episode.development_plan.id+'/'+episode.episode_id;if(episodeIds.has(episodeKey))error('DUPLICATE_EPISODE_PLAN',path,'A plan cannot bind different entries to the same Episode');episodeIds.add(episodeKey);
    for(const ref of episode.rule_refs)need(worlds,ref.world_id,path+'/rule_refs');
    if(plan?.version===episode.development_plan.version){
      if(episode.number>plan.brief.episode_count)error('EPISODE_COUNT',path+'/number','Episode number exceeds the development brief');
      if(episode.source.tenant_key!==plan.source.tenant_key||episode.source.project_key!==plan.source.project_key||episode.source.brief_id!==plan.source.brief_id||episode.source.brief_revision!==plan.source.brief_revision||episode.source.brief_digest!==plan.source.brief_digest||episode.source.run_id===plan.source.run_id&&episode.source.run_digest!==plan.source.run_digest)error('DEVELOPMENT_SOURCE',path+'/source','Episode and foundation sources must bind the same scoped brief revision and immutable run header');
      for(const ref of episode.characters)if(!plan.characters.some(character=>character.id===ref.id&&character.version===ref.version))error('DEVELOPMENT_SCOPE',path+'/characters','Episode character revision is outside the development plan');rules(episode.rule_refs,plan,path+'/rule_refs');
    }
  });
  for(const issue of developmentDependencyIssues(p))if(issue.actualVersion!==null){
    const message=`Dependency ${issue.referenceId} was pinned to version ${issue.expectedVersion}; current version is ${issue.actualVersion}`;
    if(issue.expectedVersion>issue.actualVersion)error('FUTURE_DEVELOPMENT_DEPENDENCY','/objects/'+issue.objectId,message);
    else warnings.push({code:'STALE_DEVELOPMENT_DEPENDENCY',where:'/objects/'+issue.objectId,message});
  }
  return {...report,valid:errors.length===0,errors,warnings};
}
