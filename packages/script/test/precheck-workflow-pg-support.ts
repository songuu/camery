import {ModelSession} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import type {HttpTransport} from '@camery/model-modes';
import {createClassificationBatches} from '../../compliance/src/classification.js';
import {batchTaskId} from '../../compliance/src/node/state.js';
import type {ScanRun} from '../../compliance/src/node/state.js';
import type {PrecheckWorkflowOptions} from '../../compliance/src/node/workflow.js';
/** Synthetic transport against the actual persisted source; no live inference or legal-quality claim. */
export function precheckProtocolSession(run:ScanRun,onCall:()=>void=()=>{}):PrecheckWorkflowOptions['sessionFor']{
  const batches=createClassificationBatches(run.policy,run.source.corpus);
  return async(binding,task)=>{
    const key={tenantId:run.tenantId,projectId:run.projectId,runId:run.runId},index=run.manifest.findIndex(row=>batchTaskId(key,row.index)===task.taskId),batch=batches[index];if(!batch)throw new Error('Unknown owned precheck batch');
    const output={version:1,assessments:batch.segments.flatMap(segment=>run.policy.categories.map(category=>{const start=segment.text.indexOf('便签'),flag=start>=0&&category.id==='fixture-risk';return {segmentId:segment.id,categoryId:category.id,verdict:flag?'flag':'not_flagged',start:flag?start:0,end:flag?start+2:0,quote:flag?'便签':null,reason:'合成协议分类，须人工核查。'};})).reverse()};
    const transport:HttpTransport={async exchange(){onCall();return {status:200,contentType:'application/json',body:{kind:'json',value:{id:'fixture-precheck-'+index,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:80}}}};}};
    return new ModelSession(new OpenAiCompatibleLlm(transport,{model:'fixture-precheck',structuredOutput:'json_schema'}),{tenantId:binding.tenantId,connectionId:binding.execution.connectionId,modeDigest:binding.execution.modeDigest,modelIdentity:binding.execution.modelIdentity,evidence:binding.execution.evidence,maxCalls:1,timeoutMs:2000,maxInputBytes:2097152,maxOutputBytes:524288});
  };
}
