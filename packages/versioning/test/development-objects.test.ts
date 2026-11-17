import {expect,it} from 'vitest';
import {ChangeSetV06} from '@camery/ir';
import {adoptChangeSet,createVersionState,submitChangeSet} from '../src/index';
import {fixtureId as id} from '../../ir/test/fixtures';
import {makeDevelopmentPackage} from '../../ir/test/development-fixture';
const approval={actor:{kind:'user' as const,id:id('user_1')},scope:{kind:'project' as const,id:id('prj_demo')},at:'2026-11-17T04:00:00.000Z',authorize:()=>true};
it('adopts an EpisodePlan only inside its actual Episode scope and records the new object revision',()=>{
  const p=makeDevelopmentPackage();const plan=p.episode_plans[0]!;const state=createVersionState(p);const request=ChangeSetV06.parse({schema_version:p.schema_version,id:id('edit-episode-plan'),base_revision:p.revision.number,author:approval.actor,status:'candidate',base_revisions:[{id:plan.id,version:plan.version}],ops:[{op_id:id('op-episode-plan'),op:'update',collection:'episode_plans',target:plan.id,set:{summary:'采用后继续公开核对的方法。'}}]});
  const candidate=submitChangeSet(state,request);expect(candidate.status).toBe('candidate');expect(adoptChangeSet(candidate.state,request.id,{...approval,scope:{kind:'episode',id:p.episodes[1]!.id}}).issues[0]!.code).toBe('ADOPTION_SCOPE');
  const result=adoptChangeSet(candidate.state,request.id,{...approval,scope:{kind:'episode',id:plan.episode_id}});expect(result.status).toBe('adopted');expect(result.state.revisions.at(-1)).toMatchObject({collection:'episode_plans',object_id:plan.id,version:2});
});
it('rejects a stale object base and protects new World fields with the existing explicit lock authority',()=>{
  const p=makeDevelopmentPackage();const world=p.worlds[0]!;let state=createVersionState(p);const common={schema_version:p.schema_version,base_revision:p.revision.number,author:approval.actor,status:'candidate',base_revisions:[{id:world.id,version:1}]};
  const lock=ChangeSetV06.parse({...common,id:id('lock-world'),ops:[{op_id:id('op-lock-world'),op:'lock',lock_id:id('world-lock'),target:world.id,fields:['setting'],reason:'保留世界设定。'}]});state=adoptChangeSet(submitChangeSet(state,lock).state,lock.id,approval).state;
  const edit=ChangeSetV06.parse({...common,id:id('edit-world'),ops:[{op_id:id('op-edit-world'),op:'update',collection:'worlds',target:world.id,set:{setting:'另一个港城。'}}]});expect(submitChangeSet(state,edit).issues[0]!.code).toBe('LOCKED');
  expect(submitChangeSet(state,{...edit,base_revisions:[{id:world.id,version:2}]}).issues[0]!.code).toBe('REVISION_CONFLICT');
});
it('shows affected downstream development dependencies while keeping their original pinned versions',()=>{
  const p=makeDevelopmentPackage();const world=p.worlds[0]!;const state=createVersionState(p);const request=ChangeSetV06.parse({schema_version:p.schema_version,id:id('change-world'),base_revision:p.revision.number,author:approval.actor,status:'candidate',base_revisions:[{id:world.id,version:1}],ops:[{op_id:id('op-change-world'),op:'update',collection:'worlds',target:world.id,set:{setting:'共同核验后的港城。'}}]});
  const candidate=submitChangeSet(state,request);expect(candidate.status).toBe('candidate');const affected=candidate.warnings.filter(issue=>issue.code==='STALE_DEVELOPMENT_DEPENDENCY').map(issue=>issue.where);expect(affected).toContain('/objects/'+p.development_plans[0]!.id);expect(affected).toContain('/objects/'+p.episode_plans[0]!.id);
  const adopted=adoptChangeSet(candidate.state,request.id,approval);expect(adopted.status).toBe('adopted');if(adopted.state.head.schema_version!=='0.6.0-draft')throw new Error('Expected current schema');expect(adopted.state.head.development_plans[0]!.world.version).toBe(1);expect(adopted.state.head.worlds[0]!.version).toBe(2);
});
