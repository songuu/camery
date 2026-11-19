import {expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {upgradeV07Package} from '@camery/ir';
import {makeOutlinePackage} from '../../ir/test/outline-formal-fixture.js';
import {makeContinuityPackage} from '../../ir/test/continuity-ledger-fixture.js';
import {PostgresOutlineFormalReadStore} from '../src/projects/outline-formal-store.js';
import {OutlineFormalReadApplication} from '../src/projects/outline-formal-application.js';
import {projectReadSnapshot} from '../src/projects/read-projection.js';
import {createVersionState} from '@camery/versioning';
import {outlineAdoptionApplicationFixture} from './outline-adoption-application-support.js';

function fixture(snapshot=upgradeV07Package(makeOutlinePackage())){
  const scope={tenantId:'tenant',projectId:'project'},target={tenantId:snapshot.package_id,projectId:snapshot.project.id};
  const row={tenant_id:target.tenantId,project_id:target.projectId,package_id:snapshot.package_id,head_revision:snapshot.revision.number,write_version:3,snapshot_revision:snapshot.revision.number,package_digest:'a'.repeat(64),package_unchanged:false,package:snapshot};
  const query=vi.fn(async()=>({rows:[row]})),store=new PostgresOutlineFormalReadStore({query} as unknown as Pool);
  const identities={resolveProject:vi.fn(async()=>({...scope,versionKey:target}))};
  const application=new OutlineFormalReadApplication({tenantId:scope.tenantId,store,identities});
  const subject={tenantId:scope.tenantId,userId:'viewer',sessionId:'session',grants:[{projectId:scope.projectId,role:'viewer' as const}]};
  return {snapshot,scope,target,row,query,store,identities,application,subject,context:{subject,projectId:scope.projectId}};
}

it('reads and caches a complete v08 package while formal outline responses report its actual schema',async()=>{
  const f=fixture(),saved=structuredClone(f.snapshot),selected=await f.store.snapshot({target:f.target});
  expect(selected?.snapshot).toEqual(f.snapshot);expect(selected?.snapshot.schema_version).toBe('0.8.0-draft');
  f.row.package_unchanged=true;f.row.package=null as unknown as typeof f.snapshot;
  expect((await f.store.snapshot({target:f.target}))?.snapshot).toBe(selected?.snapshot);
  const page=await f.application.list({...f.context,command:{}});expect(page.schemaVersion).toBe('0.8.0-draft');expect(page.items).toHaveLength(6);
  const rows=await f.application.rows({...f.context,command:{collection:'outline_beats'}});expect(rows.schemaVersion).toBe('0.8.0-draft');expect(rows.rows).toHaveLength(1);
  expect(selected?.snapshot).toEqual(saved);expect(f.query).toHaveBeenCalledTimes(4);expect(f.identities.resolveProject).toHaveBeenCalledTimes(2);
});

it('retains episode outline selection after a v08 upgrade without pulling every season member into view',()=>{
  const f=fixture(),episode=f.snapshot.outline_episode_plans[0]!;
  const page=projectReadSnapshot({projectKey:f.scope.projectId,target:f.target,subjectId:f.subject.userId,head:f.snapshot,writeVersion:3,query:{episodeId:episode.episode_id},capabilities:{canWrite:false,canReview:false}});
  expect(page.schemaVersion).toBe('0.8.0-draft');
  expect(page.rows.find(row=>row.ref.id===episode.id)?.role).toBe('owned');
  expect(page.rows.find(row=>row.ref.id===episode.beats[0]!.id)?.role).toBe('owned');
  expect(page.rows.find(row=>row.ref.id===f.snapshot.adaptation_plans[0]!.id)?.role).toBe('context');
});

it('preserves a nonempty four-ledger snapshot through formal reads and episode-scoped Workbench reads',async()=>{
  const f=fixture(makeContinuityPackage()),expected=f.snapshot.continuity_snapshots[0]!,saved=structuredClone(expected);
  expect((await f.store.snapshot({target:f.target}))?.snapshot).toEqual(f.snapshot);
  const page=projectReadSnapshot({projectKey:f.scope.projectId,target:f.target,subjectId:f.subject.userId,head:f.snapshot,writeVersion:3,query:{episodeId:expected.episode_id,collection:'continuity_snapshots'},capabilities:{canWrite:false,canReview:false}});
  expect(page.rows).toHaveLength(1);expect(page.rows[0]).toMatchObject({role:'owned',value:saved});
  expect(page.relations.some(row=>row.from.id===expected.id&&row.pin==='explicit')).toBe(true);
  expect(f.snapshot.continuity_snapshots[0]).toEqual(saved);
});

it('stores and adopts the dedicated v08 outline intent, retaining four ledgers and recovering its unchanged receipt',async()=>{
  const f=await outlineAdoptionApplicationFixture(),head=makeContinuityPackage(),saved=structuredClone(head.continuity_snapshots);
  f.setState(createVersionState(head),1);
  const pending=await f.prepare(),intent=await f.intentStore.candidateForChange({scope:f.scope,changeId:pending.candidateId});
  expect(intent?.draft.schemaVersion).toBe('0.8.0-draft');expect(intent?.request?.schema_version).toBe('0.8.0-draft');
  const adopted=await f.application.adoptCandidate(f.decisionInput(pending.candidateId));expect(adopted.status).toBe('adopted');
  expect(f.getState().state.head).toMatchObject({schema_version:'0.8.0-draft',continuity_snapshots:saved});
  // The explicit SQL protocol double has one intent slot; retain the real native state for the next command.
  f.db.rows.clear();
  const unchanged=await f.prepare(f.command('v08-unchanged'));
  expect(unchanged).toMatchObject({status:'unchanged',preparation:{status:'unchanged'}});
  expect(await f.prepare(f.command('v08-unchanged'))).toEqual(unchanged);
  expect(f.getState().state.head).toMatchObject({schema_version:'0.8.0-draft',continuity_snapshots:saved});
});
