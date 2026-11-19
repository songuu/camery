import {expect,it} from 'vitest';
import {adoptChangeSet,createVersionState,submitChangeSet} from '@camery/versioning';
import {upgradeV06Package} from '@camery/ir';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {makeContinuityPackage} from '../../ir/test/continuity-ledger-fixture.js';
import {prepareOutlineMappingDraft,finalizeOutlineChangeSet} from '../src/outline/node/formal-mapping.js';
import {prepareDevelopmentDraft,finalizeDevelopmentChangeSet} from '../src/node/development-mapping.js';
import {outlineFormalMappingFixture,outlineMappingInput} from './outline-formal-mapping-support.js';
import {mappingFixture} from './development-mapping-fixture.js';

it('retains old outline draft bytes and emits an explicit v08 draft only for a v08 head',async()=>{
  const f=await outlineFormalMappingFixture(),input=outlineMappingInput(f),old=prepareOutlineMappingDraft(input);
  expect(Object.hasOwn(old,'schemaVersion')).toBe(false);
  const original=JSON.stringify(old),head={...f.head,schema_version:'0.8.0-draft',continuity_snapshots:[]};
  const draft=prepareOutlineMappingDraft({...input,head});
  expect(draft).toEqual({...old,schemaVersion:'0.8.0-draft'});
  expect(JSON.stringify(prepareOutlineMappingDraft(input))).toBe(original);
  const command=finalizeOutlineChangeSet({draft,changeSetId:id('v08-outline-map'),author:{kind:'user',id:id('v08-map-author')},operationIds:draft.operations.map(row=>({slot:row.slot,id:id('v08-map:'+row.slot)}))});
  expect(command.schema_version).toBe('0.8.0-draft');
  const pending=submitChangeSet(createVersionState(head),command);expect(pending.issues).toEqual([]);expect(pending.status).toBe('candidate');
  const adopted=adoptChangeSet(pending.state,command.id,{actor:command.author,scope:{kind:'project',id:f.head.project.id},at:'2026-11-18T15:20:00.000Z',authorize:()=>true});
  expect(adopted.status).toBe('adopted');expect(adopted.state.head).toMatchObject({schema_version:'0.8.0-draft',continuity_snapshots:[]});
});

it('maps reviewed development through a v08 head without downgrading it or adding v07 outline operations',async()=>{
  const f=await mappingFixture(),head={...upgradeV06Package(f.head),schema_version:'0.8.0-draft',continuity_snapshots:[]},saved=structuredClone(head);
  const draft=prepareDevelopmentDraft({...f,head});expect(draft.schemaVersion).toBe('0.8.0-draft');
  const command=finalizeDevelopmentChangeSet({draft,changeSetId:id('v08-development-map'),author:{kind:'user',id:id('v08-map-author')},operationIds:draft.operations.map(row=>({slot:row.slot,id:id('v08-development:'+row.slot)}))});
  expect(command.schema_version).toBe('0.8.0-draft');
  const pending=submitChangeSet(createVersionState(head),command);expect(pending.issues).toEqual([]);expect(pending.status).toBe('candidate');
  expect(pending.state.changes.at(-1)?.preview).toMatchObject({schema_version:'0.8.0-draft',continuity_snapshots:[],adaptation_plans:[]});
  expect(head).toEqual(saved);
});

it.each(['outline','development'] as const)('preserves every existing four-ledger field while preparing an unrelated %s mapping',async kind=>{
  const head=makeContinuityPackage(),saved=structuredClone(head.continuity_snapshots);
  const author={kind:'user' as const,id:id('v08-unrelated-author')},changeSetId=id('v08-unrelated-'+kind);
  let command:ReturnType<typeof finalizeOutlineChangeSet>|ReturnType<typeof finalizeDevelopmentChangeSet>;
  if(kind==='outline'){
    const f=await outlineFormalMappingFixture(),draft=prepareOutlineMappingDraft({...outlineMappingInput(f),head});
    command=finalizeOutlineChangeSet({draft,changeSetId,author,operationIds:draft.operations.map(row=>({slot:row.slot,id:id(kind+row.slot)}))});
  }else{
    const f=await mappingFixture(),draft=prepareDevelopmentDraft({...f,head});
    command=finalizeDevelopmentChangeSet({draft,changeSetId,author,operationIds:draft.operations.map(row=>({slot:row.slot,id:id(kind+row.slot)}))});
  }
  const pending=submitChangeSet(createVersionState(head),command);expect(pending.issues).toEqual([]);expect(pending.status).toBe('candidate');
  const preview=pending.state.changes.at(-1)!.preview!;expect(preview).toMatchObject({schema_version:'0.8.0-draft',continuity_snapshots:saved});
  const adopted=adoptChangeSet(pending.state,command.id,{actor:author,scope:{kind:'project',id:head.project.id},at:'2026-11-18T15:20:00.000Z',authorize:()=>true});
  expect(adopted.status).toBe('adopted');expect(adopted.state.head).toMatchObject({schema_version:'0.8.0-draft',continuity_snapshots:saved});
  expect(command.ops.every(op=>!('collection' in op)||op.collection!=='continuity_snapshots')).toBe(true);
  expect(head.continuity_snapshots).toEqual(saved);
});
