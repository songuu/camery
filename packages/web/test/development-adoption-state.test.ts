import {expect,it} from 'vitest';
import {AdoptionLifetime,AdoptionPending,adoptionSource,decisionReceiptFeedback} from '../src/DevelopmentAdoptionState.js';
import type {WorkbenchActionReceipt} from '@camery/ir/workbench';
import type {DevelopmentRunView} from '@camery/script/http';
it('keeps the original identity and exact content across unknown-result retries, even after the live baseline changes',()=>{
  const pending=new AdoptionPending<{expectedSnapshotRevision:number;expectedWriteVersion:number}>();const body={expectedSnapshotRevision:1,expectedWriteVersion:1};
  const first=pending.begin('adopt',{requestId:'original',body});body.expectedWriteVersion=2;
  expect(pending.begin('adopt',{requestId:'new',body})).toEqual(first);
  expect(first.body.expectedWriteVersion).toBe(1);
  expect(()=>pending.begin('reject',{requestId:'other',body})).toThrow();
  pending.clear();expect(pending.begin('adopt',{requestId:'new',body}).requestId).toBe('new');
});
it('does not confuse a rejected adoption attempt with a human rejection of the still-live candidate',()=>{
  const receipt:WorkbenchActionReceipt={version:1,changeId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',status:'rejected',snapshotRevision:1,writeVersion:2,adoption:null,rejection:null,issues:[{code:'LOCK_AUTHORITY',where:'/actor',message:'The trusted adopting identity must match the human lock request author'}],warnings:[]};
  const feedback=decisionReceiptFeedback('adopt',receipt);expect(feedback.message).toBeNull();expect(feedback.error).toContain('本次采用未完成');expect(feedback.issues).toEqual(receipt.issues);
  expect(decisionReceiptFeedback('reject',{...receipt,issues:[]}).message).toBeNull();
  expect(decisionReceiptFeedback('adopt',{...receipt,status:'adopted',issues:[]}).message).toBeNull();
  const rejected={...receipt,issues:[],rejection:{actor_id:receipt.changeId,reason:'人物仍需调整',at:'2026-11-17T06:00:00.000Z'}};
  expect(decisionReceiptFeedback('reject',rejected).message).toContain('候选已拒绝');expect(decisionReceiptFeedback('adopt',rejected).message).toBeNull();
});
it('invalidates and aborts old work immediately on a context change and blocks all late completion',()=>{
  const lifetime=new AdoptionLifetime();const old=lifetime.next();const fresh=lifetime.next();
  expect(old.signal.aborted).toBe(true);expect(lifetime.current(old)).toBe(false);expect(lifetime.current(fresh)).toBe(true);
  lifetime.close();expect(fresh.signal.aborted).toBe(true);expect(lifetime.current(fresh)).toBe(false);
});
it('uses stored source digests and never treats candidate output or a rejected review as approval',()=>{
  const run={runDigest:'run',brief:{digest:'brief'},foundation:{review:{status:'reviewed',digest:'foundation'}},episodes:{review:{status:'reviewed',digest:'episodes'}}} as DevelopmentRunView;
  expect(adoptionSource(run)).toEqual({runDigest:'run',briefDigest:'brief',foundationReviewDigest:'foundation',episodesReviewDigest:'episodes'});
  expect(adoptionSource({...run,episodes:{candidate:null,review:null}})).toBeNull();
});
