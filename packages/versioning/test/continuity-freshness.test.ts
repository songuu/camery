import {expect,it} from 'vitest';
import {validatePackage} from '@camery/ir';
import {adoptChangeSet,createVersionState,submitChangeSet} from '../src/index';
import {makeContinuityPackage} from '../../ir/test/continuity-ledger-fixture';
import {changeSet,fixtureId as id} from '../../ir/test/fixtures';
const approval={actor:{kind:'user' as const,id:id('user_1')},scope:{kind:'project' as const,id:id('prj_demo')},at:'2026-11-18T15:30:00.000Z',authorize:()=>true};
it('preserves stale typed-ledger warnings through native preview, human adoption and original-ID replay',()=>{
  const p=makeContinuityPackage(),s=p.continuity_snapshots[0]!,beat=p.beats[0]!,state=createVersionState(p),request={...changeSet([{op:'update' as const,op_id:id('continuity-stale-edit'),collection:'beats' as const,target:beat.id,set:{summary:'核对后的新版本原文。'}}]),schema_version:'0.8.0-draft' as const,base_revisions:[{id:beat.id,version:beat.version}]};
  const pending=submitChangeSet(state,request);expect(pending.status).toBe('candidate');expect(pending.warnings).toContainEqual(expect.objectContaining({code:'STALE_CONTINUITY_DEPENDENCY'}));
  const adopted=adoptChangeSet(pending.state,request.id,approval);expect(adopted.status).toBe('adopted');expect(adopted.warnings).toContainEqual(expect.objectContaining({code:'STALE_CONTINUITY_DEPENDENCY'}));
  expect(adopted.state.head.schema_version).toBe('0.8.0-draft');if(adopted.state.head.schema_version!=='0.8.0-draft')throw new Error('Expected v08');expect(adopted.state.head.continuity_snapshots[0]).toEqual(s);
  expect(validatePackage(adopted.state.head).warnings).toContainEqual(expect.objectContaining({code:'STALE_CONTINUITY_DEPENDENCY'}));expect(adoptChangeSet(adopted.state,request.id,approval)).toEqual(adopted);
});
it('allows an explicitly versioned script reorder to mark old chronology stale without rewriting ledger evidence',()=>{
  const p=makeContinuityPackage(),s=p.continuity_snapshots[0]!,first=p.beats[0]!,last=p.beats.find(row=>row.scene_id===first.scene_id&&row.order_key>first.order_key)!;s.based_on.push({id:last.id,version:last.version});s.ledger.facts[0]!.retired={...structuredClone(s.ledger.facts[0]!.introduced),eventId:'retire.clock',order:6,evidence:{event:{kind:'beat',id:last.id,version:last.version},quote:last.summary}};
  expect(validatePackage(p).errors).toEqual([]);const old=structuredClone(s),state=createVersionState(p),request={...changeSet([{op:'update' as const,op_id:id('continuity-reorder-edit'),collection:'beats' as const,target:first.id,set:{order_key:'z0'}}]),schema_version:'0.8.0-draft' as const,base_revisions:[{id:first.id,version:first.version}]};
  const pending=submitChangeSet(state,request);expect(pending.status).toBe('candidate');expect(pending.warnings).toContainEqual(expect.objectContaining({code:'STALE_CONTINUITY_DEPENDENCY'}));
  const adopted=adoptChangeSet(pending.state,request.id,approval);expect(adopted.status).toBe('adopted');if(adopted.state.head.schema_version!=='0.8.0-draft')throw new Error('Expected v08');expect(adopted.state.head.continuity_snapshots[0]).toEqual(old);
});
