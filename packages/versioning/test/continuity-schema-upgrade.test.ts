import {expect,it} from 'vitest';
import {ChangeSetV06,ChangeSetV07,ChangeSetV08,upgradeV05Package,upgradeV06Package,upgradeV07Package} from '@camery/ir';
import {adoptChangeSet,createVersionState,submitChangeSet} from '../src/index';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';
import {makeOutlinePackage} from '../../ir/test/outline-formal-fixture';
import {continuityAdd,continuitySnapshot,continuityUpgrade,makeContinuityPackage} from './continuity-fixture';

const approval={actor:{kind:'user' as const,id:id('user_1')},scope:{kind:'project' as const,id:id('prj_demo')},at:'2026-11-18T16:00:00.000Z',authorize:()=>true};

it('previews and explicitly adopts the v07 to v08 edge without rewriting earlier content or object revisions',()=>{
  const p=makeOutlinePackage(),saved=structuredClone(p),state=createVersionState(p),command=continuityUpgrade(),candidate=submitChangeSet(state,command);
  expect(candidate.status).toBe('candidate');expect(candidate.state.head).toEqual(p);expect(candidate.state.changes.at(-1)!.preview!.schema_version).toBe('0.8.0-draft');
  const adopted=adoptChangeSet(candidate.state,command.id,approval);expect(adopted.status).toBe('adopted');
  expect(adopted.state.head).toEqual({...upgradeV07Package(p),revision:{number:6,status:'adopted',note:command.id}});expect(adopted.state.revisions).toEqual(state.revisions);expect(p).toEqual(saved);
  expect(adoptChangeSet(adopted.state,command.id,approval).state).toEqual(adopted.state);expect(submitChangeSet(adopted.state,command).state).toEqual(adopted.state);
  expect(adoptChangeSet(adopted.state,command.id,{...approval,authorize:()=>false}).issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');
});
it('preserves two earlier explicit upgrade edges and forbids skipping either predecessor',()=>{
  const p=makePackage();for(const source of [p,upgradeV05Package(p)])expect(submitChangeSet(createVersionState(source),continuityUpgrade()).issues.map(issue=>issue.code)).toContain('SCHEMA_VERSION');
  const command06=ChangeSetV06.parse({...changeSet([]),schema_version:'0.6.0-draft',id:id('continuity-old-upgrade06'),ops:[{op_id:id('continuity-old-upgrade06-op'),op:'upgrade_schema',from:'0.5.0-draft',to:'0.6.0-draft'}]});
  const adopted06=adoptChangeSet(submitChangeSet(createVersionState(p),command06).state,command06.id,approval);
  expect(adopted06.state.head).toEqual({...upgradeV05Package(p),revision:{number:6,status:'adopted',note:command06.id}});
  const command07=ChangeSetV07.parse({...changeSet([]),schema_version:'0.7.0-draft',id:id('continuity-old-upgrade07'),base_revision:6,ops:[{op_id:id('continuity-old-upgrade07-op'),op:'upgrade_schema',from:'0.6.0-draft',to:'0.7.0-draft'}]});
  const adopted07=adoptChangeSet(submitChangeSet(adopted06.state,command07).state,command07.id,approval);expect(adopted07.state.head).toEqual({...upgradeV06Package(adopted06.state.head),revision:{number:7,status:'adopted',note:command07.id}});
  const adopted08=adoptChangeSet(submitChangeSet(adopted07.state,continuityUpgrade(7)).state,continuityUpgrade(7).id,approval);expect(adopted08.status).toBe('adopted');expect(adopted08.state.head.schema_version).toBe('0.8.0-draft');expect(adopted08.state.changes.slice(0,2)).toEqual(adopted07.state.changes);
  expect(submitChangeSet(adopted08.state,{...command07,id:id('continuity-downgrade'),base_revision:8}).issues.map(issue=>issue.code)).toContain('SCHEMA_VERSION');
});
it('requires exact base and one exclusive upgrade operation with a human project adoption',()=>{
  const state=createVersionState(makeOutlinePackage()),upgrade=continuityUpgrade();
  expect(submitChangeSet(state,continuityUpgrade(4)).issues.map(issue=>issue.code)).toContain('SCHEMA_UPGRADE_BASE');
  expect(submitChangeSet(state,{...upgrade,author:{kind:'system',id:id('continuity-agent')}}).issues.map(issue=>issue.code)).toContain('LOCK_AUTHORITY');
  const mixed=ChangeSetV08.parse({...upgrade,ops:[...upgrade.ops,{op_id:id('continuity-mixed-op'),op:'update',collection:'episodes',target:state.head.episodes[0]!.id,set:{title:'未单独采用的修改'}}]});expect(submitChangeSet(state,mixed).issues.map(issue=>issue.code)).toContain('SCHEMA_UPGRADE_EXCLUSIVE');
  const pending=submitChangeSet(state,upgrade);for(const scope of [{kind:'episode' as const,id:state.head.episodes[0]!.id},{kind:'scene' as const,id:state.head.scenes[0]!.id}])expect(adoptChangeSet(pending.state,upgrade.id,{...approval,scope}).issues.map(issue=>issue.code)).toContain('SCHEMA_UPGRADE_PROJECT_ONLY');
});
it('does not run the third upgrade alongside any live old-version candidate in either direction',()=>{
  const state=createVersionState(makeOutlinePackage()),normal=ChangeSetV07.parse({...changeSet([{op_id:id('continuity-pending-op'),op:'update',collection:'episodes',target:state.head.episodes[0]!.id,set:{title:'待核对'}}]),base_revisions:[{id:state.head.episodes[0]!.id,version:1}],schema_version:'0.7.0-draft'});
  const pending=submitChangeSet(state,normal);expect(pending.status).toBe('candidate');expect(submitChangeSet(pending.state,continuityUpgrade()).issues.map(issue=>issue.code)).toContain('SCHEMA_UPGRADE_PENDING_CHANGES');
  const upgradePending=submitChangeSet(state,continuityUpgrade());expect(submitChangeSet(upgradePending.state,normal).issues.map(issue=>issue.code)).toContain('SCHEMA_UPGRADE_PENDING_CHANGES');
});
it('records a typed ledger as a versioned episode object and rejects cross-episode or scene adoption',()=>{
  const p=makeContinuityPackage(),command=continuityAdd(p),state=createVersionState(p),pending=submitChangeSet(state,command);expect(pending.status).toBe('candidate');expect(pending.state.head).toEqual(p);
  for(const scope of [{kind:'episode' as const,id:id('other-episode')},{kind:'scene' as const,id:p.scenes[0]!.id}])expect(adoptChangeSet(pending.state,command.id,{...approval,scope}).issues.map(issue=>issue.code)).toContain('ADOPTION_SCOPE');
  const episodeApproval={...approval,scope:{kind:'episode' as const,id:p.episodes[0]!.id}},adopted=adoptChangeSet(pending.state,command.id,episodeApproval);expect(adopted.status).toBe('adopted');
  if(adopted.state.head.schema_version!=='0.8.0-draft')throw new Error('Expected v08');expect(adopted.state.head.continuity_snapshots).toEqual([continuitySnapshot(p)]);
  expect(adopted.state.revisions.filter(row=>row.object_id===id('continuity-snapshot'))).toEqual([{collection:'continuity_snapshots',object_id:id('continuity-snapshot'),version:1,parent_version:null,snapshot_revision:6,change_set_id:command.id,value:continuitySnapshot(p)}]);
  expect(adoptChangeSet(adopted.state,command.id,episodeApproval).state).toEqual(adopted.state);expect(submitChangeSet(adopted.state,command).state).toEqual(adopted.state);
});
it('uses native field locks, owner unlock, exact object bases and historical identities for typed snapshots',()=>{
  const p=makeContinuityPackage(),snapshot=continuitySnapshot(p),lock={id:id('continuity-lock'),version:1,target:snapshot.id,fields:['ledger'],owner_id:id('user_1'),reason:'保持前集正式账本。'};p.continuity_snapshots.push(snapshot);p.locks.push(lock);
  const operation={op_id:id('continuity-edit-op'),op:'update' as const,collection:'continuity_snapshots' as const,target:snapshot.id,set:{ledger:{...snapshot.ledger,snapshotRevision:4}}};
  const state=createVersionState(p),blocked=ChangeSetV08.parse({...changeSet([operation]),schema_version:'0.8.0-draft',id:id('continuity-locked-edit'),base_revisions:[{id:snapshot.id,version:1}]});expect(submitChangeSet(state,blocked).issues.map(issue=>issue.code)).toContain('LOCKED');
  const edit=ChangeSetV08.parse({...blocked,id:id('continuity-unlocked-edit'),base_revisions:[...blocked.base_revisions,{id:lock.id,version:1}],ops:[{op_id:id('continuity-unlock-op'),op:'unlock',lock_id:lock.id,reason:'明确允许人工修订。'},operation]}),pending=submitChangeSet(state,edit);expect(pending.status).toBe('candidate');
  expect(adoptChangeSet(pending.state,edit.id,{...approval,actor:{kind:'user',id:id('other-human')}}).issues.map(issue=>issue.code)).toContain('LOCK_AUTHORITY');
  const adopted=adoptChangeSet(pending.state,edit.id,{...approval,scope:{kind:'episode',id:snapshot.episode_id}});expect(adopted.status).toBe('adopted');if(adopted.state.head.schema_version!=='0.8.0-draft')throw new Error('Expected v08');
  expect(adopted.state.head.continuity_snapshots[0]).toEqual({...snapshot,version:2,ledger:{...snapshot.ledger,snapshotRevision:4}});expect(adopted.state.head.locks).not.toContainEqual(lock);expect(adopted.state.revisions.filter(row=>row.object_id===snapshot.id).map(row=>({version:row.version,parent:row.parent_version}))).toEqual([{version:1,parent:null},{version:2,parent:1}]);expect(p.continuity_snapshots[0]).toEqual(snapshot);
});
it('requires exact typed-object read bases and refuses identity changes before any native adoption',()=>{
  const p=makeContinuityPackage(),snapshot=continuitySnapshot(p);p.continuity_snapshots.push(snapshot);const state=createVersionState(p),command=ChangeSetV08.parse({...changeSet([{op_id:id('continuity-base-op'),op:'update',collection:'continuity_snapshots',target:snapshot.id,set:{ledger:{...snapshot.ledger,snapshotRevision:4}}}]),schema_version:'0.8.0-draft',id:id('continuity-base-change')});
  expect(submitChangeSet(state,command).issues.map(issue=>issue.code)).toContain('BASE_REQUIRED');
  expect(submitChangeSet(state,{...command,base_revisions:[{id:snapshot.id,version:2}]}).issues.map(issue=>issue.code)).toContain('REVISION_CONFLICT');
  const identityChange={...command,base_revisions:[{id:snapshot.id,version:1}],ops:[{op_id:id('continuity-identity-op'),op:'update' as const,collection:'continuity_snapshots' as const,target:snapshot.id,set:{id:id('continuity-other-identity')}}]};expect(submitChangeSet(state,identityChange).issues.map(issue=>issue.code)).toContain('IMMUTABLE_IDENTITY');expect(state.head).toEqual(p);expect(state.changes).toEqual([]);
});
it('retains a removed typed snapshot as immutable history and forbids allocating its identity again',()=>{
  const p=makeContinuityPackage(),snapshot=continuitySnapshot(p);p.continuity_snapshots.push(snapshot);const state=createVersionState(p),command=ChangeSetV08.parse({...changeSet([{op_id:id('continuity-remove-op'),op:'remove',collection:'continuity_snapshots',target:snapshot.id}]),schema_version:'0.8.0-draft',id:id('continuity-remove-change'),base_revisions:[{id:snapshot.id,version:1}]});
  const pending=submitChangeSet(state,command);expect(pending.status).toBe('candidate');const adopted=adoptChangeSet(pending.state,command.id,{...approval,scope:{kind:'episode',id:snapshot.episode_id}});expect(adopted.status).toBe('adopted');if(adopted.state.head.schema_version!=='0.8.0-draft')throw new Error('Expected v08');expect(adopted.state.head.continuity_snapshots).toEqual([]);
  expect(adopted.state.revisions.filter(row=>row.object_id===snapshot.id).map(row=>({version:row.version,parent:row.parent_version,value:row.value}))).toEqual([{version:1,parent:null,value:snapshot},{version:2,parent:1,value:null}]);
  expect(submitChangeSet(adopted.state,continuityAdd(adopted.state.head)).issues.map(issue=>issue.code)).toContain('ID_REUSE');expect(p.continuity_snapshots).toEqual([snapshot]);
});
