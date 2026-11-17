import { DevelopmentError } from '@camery/script';
import { developmentMethodPins,executionForDevelopment,type DevelopmentWorkflowOptions } from '@camery/script/node';
import { ModelSession,canonical } from '@camery/methods';
import { NodeHttpTransport,OpenAiCompatibleLlm } from '@camery/model-modes';
import type { DevelopmentPreset } from './development-options.js';
import type { DevelopmentDeploymentConfig } from './development-config.js';

export interface DevelopmentModelRuntime {
  readonly presetFor:(projectId:string)=>DevelopmentPreset|null;readonly sessionFor:DevelopmentWorkflowOptions['sessionFor'];
}
/** Capture one trusted project/profile. Construction and session creation perform no remote request. */
export function createDevelopmentModelRuntime(config:DevelopmentDeploymentConfig):DevelopmentModelRuntime{
  const {tenantId,projectId,text}=config;
  if(!text)return Object.freeze({presetFor:()=>null,sessionFor:async()=>{throw new DevelopmentError('INCOMPLETE','text model unavailable');}});
  const execution=executionForDevelopment({connectionId:text.connectionId,modelIdentity:text.modelIdentity,modeDigest:text.modeDigest,
    evidence:'live_model',modelTier:'balanced',currency:text.currency,reservation:text.reservation,...(text.pricing?{pricing:text.pricing}:{}),limits:text.limits});
  const preset=Object.freeze({methods:developmentMethodPins(),execution,label:text.label});
  const transport=new NodeHttpTransport({tenantId,connectionId:text.connectionId,baseUrl:text.baseUrl,timeoutMs:text.timeoutMs,maxInFlight:1,
    allowPrivateNetworks:text.allowPrivateNetworks,allowInsecureHttp:text.allowInsecureHttp,
    auth:{scheme:'Bearer',credentialRef:'development-text',resolveSecret:async()=>text.token}});
  const client=new OpenAiCompatibleLlm(transport,{model:text.modelIdentity,structuredOutput:text.structuredOutput});
  return Object.freeze({presetFor:(requested:string)=>requested===projectId?preset:null,
    sessionFor:async(binding:Parameters<DevelopmentWorkflowOptions['sessionFor']>[0],task:Parameters<DevelopmentWorkflowOptions['sessionFor']>[1])=>{
      if(binding.tenantId!==tenantId||binding.projectId!==projectId||task.tenantId!==tenantId||canonical(binding.execution)!==canonical(execution))throw new DevelopmentError('CONFLICT','text execution binding');
      return new ModelSession(client,{tenantId,connectionId:text.connectionId,modeDigest:text.modeDigest,modelIdentity:text.modelIdentity,evidence:'live_model',maxCalls:1,timeoutMs:text.timeoutMs});
    }});
}
