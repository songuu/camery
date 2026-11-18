import { z } from 'zod';
import { Id } from '@camery/script/contracts';
import { OutlineError } from '@camery/script/outline/contracts';
import { outlineExecution } from '@camery/script/outline/node';
import type { OutlineWorkflowOptions } from '@camery/script/outline/node';
import { ModelSession,canonical } from '@camery/methods';
import { snapshotJson } from '@camery/methods/json';
import { NodeHttpTransport,OpenAiCompatibleLlm } from '@camery/model-modes';
import type { OutlinePreset } from './outline-options.js';
import type { OutlineDeploymentConfig } from './outline-config.js';

export interface OutlineModelRuntime {
  readonly presetFor:(projectId:string)=>OutlinePreset|null;readonly sessionFor:OutlineWorkflowOptions['sessionFor'];
}
const Scope=z.strictObject({tenantId:Id,projectId:Id});
const Binding=Scope.extend({execution:z.unknown()});
const Task=z.strictObject({tenantId:Id,taskId:Id});
/** Capture a trusted deployment once; neither runtime construction nor session construction makes a provider request. */
export function createOutlineModelRuntime(config:OutlineDeploymentConfig):OutlineModelRuntime {
  try{
    const supplied=snapshotJson(config,65536),{tenantId,projectId}=Scope.parse({tenantId:supplied.tenantId,projectId:supplied.projectId}),text=supplied.text;
    if(!text)return Object.freeze({presetFor:()=>null,sessionFor:async()=>{throw new OutlineError('INCOMPLETE','text model unavailable','configuration');}});
    const execution=outlineExecution({connectionId:text.connectionId,modelIdentity:text.modelIdentity,modeDigest:text.modeDigest,evidence:'live_model',modelTier:'balanced',currency:text.currency,
      reservation:text.reservation,...(text.pricing?{pricing:text.pricing}:{}),limits:text.limits});
    const profile=canonical(execution),preset=Object.freeze({execution,label:text.label});
    const transport=new NodeHttpTransport({tenantId,connectionId:text.connectionId,baseUrl:text.baseUrl,timeoutMs:text.timeoutMs,maxInFlight:1,
      // Canonical session input is capped at 2MiB; reserve bounded wire framing for the pinned adapter/schema.
      maxRequestBytes:2097152+65536,
      allowPrivateNetworks:text.allowPrivateNetworks,allowInsecureHttp:text.allowInsecureHttp,
      auth:{scheme:'Bearer',credentialRef:'outline-text',resolveSecret:async()=>text.token}});
    const client=new OpenAiCompatibleLlm(transport,{model:text.modelIdentity,structuredOutput:text.structuredOutput});
    return Object.freeze({presetFor:(requested:string)=>requested===projectId?preset:null,
      sessionFor:async(binding:Parameters<OutlineWorkflowOptions['sessionFor']>[0],task:Parameters<OutlineWorkflowOptions['sessionFor']>[1])=>{
        try{
          const request=Binding.parse(snapshotJson(binding,8192)),identity=Task.parse(snapshotJson(task,2048));
          // Exact trusted profile includes prices/reservations/limits, so a stored or request-supplied replacement cannot resize the call.
          if(request.tenantId!==tenantId||request.projectId!==projectId||identity.tenantId!==tenantId||canonical(request.execution)!==profile)throw new Error('Profile mismatch');
          return new ModelSession(client,{tenantId,connectionId:text.connectionId,modeDigest:text.modeDigest,modelIdentity:text.modelIdentity,evidence:'live_model',maxCalls:1,
            timeoutMs:text.timeoutMs,maxInputBytes:2097152,maxOutputBytes:524288});
        }catch{throw new OutlineError('CONFLICT','text execution binding','configuration');}
      }});
  }catch{throw new OutlineError('INVALID_INPUT','text runtime','configuration');}
}
