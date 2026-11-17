import type {DevelopmentRunView} from '@camery/script/http';
import type {WorkbenchActionReceipt} from '@camery/ir/workbench';

/** A retry must use the original content even when a refresh changes the current baseline. */
export class AdoptionPending<T=unknown> {
  value:{kind:string;requestId:string;body:T}|null=null;
  begin(kind:string,request:{requestId:string;body:T}){
    if(this.value){if(this.value.kind!==kind)throw new Error('An unresolved adoption request must be retried first');return this.value;}
    this.value={kind,requestId:request.requestId,body:structuredClone(request.body)};return this.value;
  }
  clear(){this.value=null;}
}
export class AdoptionLifetime {
  private controller:AbortController|null=null;
  next(){this.close();const controller=new AbortController();this.controller=controller;return {signal:controller.signal};}
  current(ticket:{signal:AbortSignal}){return this.controller?.signal===ticket.signal&&!ticket.signal.aborted;}
  close(){this.controller?.abort();this.controller=null;}
}
export function adoptionSource(run:DevelopmentRunView){
  if(run.foundation.review?.status!=='reviewed'||run.episodes.review?.status!=='reviewed')return null;
  return {runDigest:run.runDigest,briefDigest:run.brief.digest,foundationReviewDigest:run.foundation.review.digest,episodesReviewDigest:run.episodes.review.digest};
}
/** A failed version operation may report rejected without recording a human rejection. */
export function decisionReceiptFeedback(action:'adopt'|'reject',receipt:WorkbenchActionReceipt){
  const success=receipt.issues.length===0&&(action==='adopt'?receipt.status==='adopted'&&receipt.adoption!==null:receipt.status==='rejected'&&receipt.rejection!==null);
  return success?{message:action==='adopt'?'已采用到正式剧本。':'候选已拒绝，正式剧本保持原版本。',error:null,issues:[] as WorkbenchActionReceipt['issues']}:
    {message:null,error:`本次${action==='adopt'?'采用':'拒绝'}未完成。${receipt.status==='conflicted'?'候选存在冲突，':''}请核对本次操作提示，再刷新候选状态。`,issues:structuredClone(receipt.issues)};
}
