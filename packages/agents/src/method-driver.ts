import { z } from 'zod';
import { canonical, digest, freeze, jsonCopy, ModelReceiptSchema, Pin, prepareStructuredGenerationRequest } from '@camery/methods';
import type { MethodPin, MethodRegistry, MethodRunner, ModelSession } from '@camery/methods';
import type { Outcome } from '@camery/model-modes';
import { AgentError, AgentRegistry, BudgetSchema, Name, ReservationSchema, ToolRegistry } from './registry.js';
import type { DecisionContext, DecisionDriver, DecisionRequest } from './runtime.js';
import type { ModelDriverOptions } from './model-driver.js';
import { PricingSchema, meterModelUsage } from './metering.js';

const Options=z.strictObject({modelTier:z.enum(['economy','balanced','quality']),currency:BudgetSchema.shape.currency,reservation:ReservationSchema,pricing:PricingSchema.optional()});
const Profile=z.strictObject({tenantId:Name,connectionId:Name,modeDigest:z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),modelIdentity:Name,evidence:z.enum(['live_model','synthetic_replay'])});
const Execution=z.strictObject({status:z.literal('candidate'),method:Pin,output:z.json(),trace:z.array(z.strictObject({tool:z.literal('method.generate'),effect:z.enum(['paid','read']),network:z.boolean(),evidence:z.enum(['live_model','synthetic_replay']),status:z.literal('completed'),modelCall:ModelReceiptSchema})).length(1)});

/** One pinned method completion inside an Agent decision: no extra model request or rewritten receipt. */
export function createMethodDecisionDriver(agents:AgentRegistry,tools:ToolRegistry,suppliedAgent:MethodPin,methods:MethodRegistry,suppliedMethod:MethodPin,runner:Pick<MethodRunner,'run'>,suppliedProfile:ModelSession['profile'],options:ModelDriverOptions):DecisionDriver {
  const pin=freeze(jsonCopy(suppliedAgent));const agent=agents.resolve(pin);const method=freeze(jsonCopy(suppliedMethod));const pack=methods.resolve(method);
  const parsed=Options.safeParse(jsonCopy(options));const profile=Profile.safeParse(jsonCopy(suppliedProfile));
  if(!parsed.success||!profile.success||agent.tools.length!==0||typeof tools.toMcp!=='function'||agent.methods.length!==1||canonical(agent.methods[0])!==canonical(method)
    ||pack.manifest.tool!=='method.generate'||parsed.data.modelTier!==agent.modelTier||parsed.data.modelTier!==pack.manifest.modelTier
    ||parsed.data.currency!==agent.budget.currency||canonical(agent.outputSchema)!==canonical(pack.manifest.outputSchema)||typeof runner.run!=='function')throw new AgentError('INVALID_METHOD_DRIVER','not_sent');
  const config=freeze(parsed.data);const model=freeze(profile.data);const live=model.evidence==='live_model';const run=runner.run.bind(runner);
  if(config.reservation.tokens===0)throw new AgentError('MISSING_TOKEN_RESERVATION','not_sent');
  if(live&&(!config.pricing||config.pricing.inputMicrosPerMillionTokens>0||config.pricing.outputMicrosPerMillionTokens>0)&&config.reservation.costMicros===0)throw new AgentError('MISSING_COST_RESERVATION','not_sent');
  const prepare=(original:Readonly<DecisionRequest>,supplied:Readonly<DecisionContext>)=>{
    try {
      const input=jsonCopy(original);const context=Object.freeze({tenantId:supplied.tenantId,taskId:supplied.taskId,idempotencyKey:supplied.idempotencyKey,signal:supplied.signal});
      const objects=z.array(Name).max(1000).safeParse(input.trusted.objectIds);
      if(context.tenantId!==model.tenantId||!Name.safeParse(context.taskId).success||!Name.safeParse(context.idempotencyKey).success||!(context.signal instanceof AbortSignal)
        ||canonical(input.trusted.agent)!==canonical(pin)||input.trusted.instructions!==agent.instructions||canonical(input.trusted.tools)!=='[]'
        ||!objects.success||new Set(objects.data).size!==objects.data.length||!Array.isArray(input.observations)||input.observations.length!==0)throw new Error();
      const request=prepareStructuredGenerationRequest(pack,input.untrustedSource);
      freeze(input.untrustedSource);
      return {input:input.untrustedSource,context,inputDigest:digest({messages:request.messages,outputSchema:request.outputSchema}),validate:request.validate};
    } catch {throw new AgentError('INVALID_DRIVER_REQUEST',live?'not_sent':'not_applicable');}
  };
  const driver:DecisionDriver={identity:model.modelIdentity,digest:digest({protocol:'method-decision-v1',agent:pin,method,model,config}),evidence:model.evidence,currency:config.currency,reservation:config.reservation,
    model:{tenantId:model.tenantId,connectionId:model.connectionId,modeDigest:model.modeDigest,modelIdentity:model.modelIdentity,modelTier:config.modelTier,receiptOutput:'finish-output' as const,...(config.pricing?{pricing:config.pricing}:{})},
    requestDigest(original,context){return prepare(original,context).inputDigest;},
    async decide(original,supplied){
      const prepared=prepare(original,supplied);
      // Runner failures retain their actual sent/unknown/completed classification and are never repaired here.
      const result=await run(method,prepared.input,{tenantId:model.tenantId,connectionId:model.connectionId,modeDigest:model.modeDigest,idempotencyKey:prepared.context.idempotencyKey,signal:prepared.context.signal});
      let outcome:Outcome='unknown';
      try {
        const execution=Execution.safeParse(jsonCopy(result));if(!execution.success)throw new Error();
        const trace=execution.data.trace[0]!;const receipt=trace.modelCall;
        if(canonical(execution.data.method)!==canonical(method)||trace.effect!==(live?'paid':'read')||trace.network!==live||trace.evidence!==model.evidence
          ||receipt.tenantId!==model.tenantId||receipt.connectionId!==model.connectionId||receipt.modeDigest!==model.modeDigest||receipt.modelIdentity!==model.modelIdentity
          ||receipt.evidence!==model.evidence||receipt.callId!==prepared.context.idempotencyKey||receipt.inputDigest!==prepared.inputDigest||receipt.outputDigest!==digest(execution.data.output))throw new Error();
        outcome=live?'completed':'not_applicable';
        if(prepared.context.signal.aborted)throw new AgentError('ABORTED',outcome);
        if(prepared.validate(execution.data.output)!==true)throw new Error();
        return freeze({action:{kind:'finish' as const,output:execution.data.output},usage:meterModelUsage(receipt.usage,config.pricing,live).usage,modelCall:receipt});
      } catch(error) {
        if(error instanceof AgentError)throw error;
        throw new AgentError('INVALID_METHOD_DECISION',outcome);
      }
    },
  };
  return Object.freeze(driver);
}
