import {expect,it} from 'vitest';
import {ChangeSetV06,DEVELOPMENT_SCHEMA_VERSION as SCHEMA_VERSION,upgradeV05Package} from '@camery/ir';
import {adoptChangeSet,createVersionState,rejectChangeSet,submitChangeSet} from '../src/index';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';
const approval={actor:{kind:'user' as const,id:id('user_1')},scope:{kind:'project' as const,id:id('prj_demo')},at:'2026-11-17T04:00:00.000Z',authorize:()=>true};
function upgrade(){return ChangeSetV06.parse({...changeSet([]),schema_version:SCHEMA_VERSION,id:id('upgrade'),ops:[{op_id:id('op-upgrade'),op:'upgrade_schema',from:'0.5.0-draft',to:SCHEMA_VERSION}]});}
it('previews and explicitly adopts an empty v06 extension while preserving every old object and historical value',()=>{
  const state=createVersionState(makePackage());const request=upgrade();const prepared=submitChangeSet(state,request);expect(prepared.status).toBe('candidate');expect(prepared.state.head).toEqual(state.head);
  const adopted=adoptChangeSet(prepared.state,request.id,approval);expect(adopted.status).toBe('adopted');expect(adopted.state.head).toEqual({...upgradeV05Package(state.head),revision:{number:state.head.revision.number+1,status:'adopted',note:request.id}});expect(adopted.state.revisions).toEqual(state.revisions);expect(adopted.state.adoptions).toHaveLength(1);
  expect(adoptChangeSet(adopted.state,request.id,approval).state).toEqual(adopted.state);
});
it('leaves a legacy pending candidate untouched until it is explicitly rejected or adopted before upgrade',()=>{
  const original=createVersionState(makePackage());const legacy=changeSet([{op:'update',op_id:id('op-old'),collection:'shots',target:id('sh_1'),set:{action:'仍按旧语义修改。'}}],{id:id('legacy-pending'),base_revisions:[{id:id('sh_1'),version:1}]});
  const state=submitChangeSet(original,legacy).state;const blocked=submitChangeSet(state,upgrade());expect(blocked.issues[0]!.code).toBe('SCHEMA_UPGRADE_PENDING_CHANGES');expect(blocked.state).toEqual(state);
  const rejected=rejectChangeSet(state,legacy.id,approval,'明确放弃旧候选后升级。');expect(submitChangeSet(rejected.state,upgrade()).status).toBe('candidate');
  const adopted=adoptChangeSet(state,legacy.id,approval);expect(adopted.status).toBe('adopted');expect(adopted.state.head.schema_version).toBe('0.5.0-draft');
});
it('makes a pending schema upgrade exclusive and requires current snapshot and project adoption scope',()=>{
  const state=createVersionState(makePackage());const request=upgrade();const mixed={...request,ops:[...request.ops,{op_id:id('op-extra'),op:'remove' as const,collection:'shots' as const,target:id('sh_1')}]};
  expect(submitChangeSet(state,mixed).issues[0]!.code).toBe('SCHEMA_UPGRADE_EXCLUSIVE');expect(submitChangeSet(state,{...request,base_revision:1}).issues[0]!.code).toBe('SCHEMA_UPGRADE_BASE');
  const prepared=submitChangeSet(state,request);const denied=adoptChangeSet(prepared.state,request.id,{...approval,scope:{kind:'episode',id:id('ep_1')}});expect(denied.issues[0]!.code).toBe('SCHEMA_UPGRADE_PROJECT_ONLY');expect(denied.state).toEqual(prepared.state);
  const old=changeSet([{op_id:id('op-late'),op:'update',collection:'shots',target:id('sh_1'),set:{action:'应先处理升级候选。'}}],{id:id('late-old'),base_revisions:[{id:id('sh_1'),version:1}]});expect(submitChangeSet(prepared.state,old).issues[0]!.code).toBe('SCHEMA_UPGRADE_PENDING_CHANGES');
});
it('rejects new v05 writes after upgrade while preserving already adopted legacy acknowledgements',()=>{
  const legacy=changeSet([{op_id:id('op-old'),op:'update',collection:'shots',target:id('sh_1'),set:{action:'保留历史修改。'}}],{id:id('legacy'),base_revisions:[{id:id('sh_1'),version:1}]});let state=submitChangeSet(createVersionState(makePackage()),legacy).state;state=adoptChangeSet(state,legacy.id,approval).state;
  const request={...upgrade(),base_revision:state.head.revision.number};state=adoptChangeSet(submitChangeSet(state,request).state,request.id,approval).state;
  expect(adoptChangeSet(state,legacy.id,approval).state).toEqual(state);expect(submitChangeSet(state,{...legacy,id:id('old-new')}).issues[0]!.code).toBe('SCHEMA_VERSION');expect(submitChangeSet(state,legacy).state).toEqual(state);
});
it('versions a new World through existing object bases and locks and requires project scope',()=>{
  const state=createVersionState(upgradeV05Package(makePackage()));const world={id:id('world'),version:1,setting:'港城',era:'近未来',rules:[]};const request=ChangeSetV06.parse({...upgrade(),id:id('add-world'),ops:[{op_id:id('op-world'),op:'add',collection:'worlds',value:world}]});
  const candidate=submitChangeSet(state,request);expect(candidate.status).toBe('candidate');expect(adoptChangeSet(candidate.state,request.id,{...approval,scope:{kind:'episode',id:id('ep_1')}}).status).toBe('rejected');const adopted=adoptChangeSet(candidate.state,request.id,approval);expect(adopted.status).toBe('adopted');expect(adopted.state.revisions.at(-1)).toMatchObject({object_id:world.id,collection:'worlds',version:1});
});
