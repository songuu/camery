import { createServer } from 'node:http';
import { expect,it } from 'vitest';
import type { OutlineDeploymentConfig } from '../src/outline-config.js';
import { createOutlineModelRuntime } from '../src/outline-runtime.js';
const config:OutlineDeploymentConfig={tenantId:'tenant',projectId:'project',outlineDatabaseUrl:'unused',taskDatabaseUrl:'unused',workerId:'worker',pollMs:50,runsPerRound:1,
  text:{label:'协议模型',baseUrl:'https://models.example/v1',connectionId:'outline-text',modelIdentity:'fixture-model',modeDigest:'a'.repeat(64),structuredOutput:'json_schema',timeoutMs:1000,
    allowPrivateNetworks:false,allowInsecureHttp:false,token:'fixture-token',currency:'CNY',reservation:{tokens:300,costMicros:10},pricing:{inputMicrosPerMillionTokens:100,outputMicrosPerMillionTokens:100},limits:{steps:1,tokens:300,costMicros:10}}};
const task={tenantId:'tenant',taskId:'outline-task'};
it('keeps no-text recovery available without granting a new start preset',async()=>{
  const ready=createOutlineModelRuntime(config),empty=createOutlineModelRuntime({...config,text:null});expect(empty.presetFor('project')).toBeNull();expect(ready.presetFor('other')).toBeNull();
  await expect(empty.sessionFor({tenantId:'tenant',projectId:'project',execution:ready.presetFor('project')!.execution},task)).rejects.toMatchObject({code:'INCOMPLETE'});
});
it('captures a fixed full profile before sessions and refuses changed scope, prices or limits',async()=>{
  const supplied={...config,text:{...config.text!,reservation:{...config.text!.reservation}}},runtime=createOutlineModelRuntime(supplied),execution=runtime.presetFor('project')!.execution;
  supplied.text!.reservation.tokens=1000;supplied.text!.token='changed';expect(runtime.presetFor('project')?.execution.reservation.tokens).toBe(300);
  for(const binding of [{tenantId:'other',projectId:'project',execution},{tenantId:'tenant',projectId:'other',execution},
    {tenantId:'tenant',projectId:'project',execution:{...execution,limits:{...execution.limits,tokens:301}}},
    {tenantId:'tenant',projectId:'project',execution:{...execution,pricing:{inputMicrosPerMillionTokens:101,outputMicrosPerMillionTokens:100}}}])await expect(runtime.sessionFor(binding,task)).rejects.toMatchObject({code:'CONFLICT'});
  await expect(runtime.sessionFor({tenantId:'tenant',projectId:'project',execution},{...task,tenantId:'other'})).rejects.toMatchObject({code:'CONFLICT'});
  const session=await runtime.sessionFor({tenantId:'tenant',projectId:'project',execution},task);expect(session.callsUsed).toBe(0);expect(session.profile).toMatchObject({tenantId:'tenant',connectionId:'outline-text',evidence:'live_model'});
  expect(Object.isFrozen(execution.reservation)).toBe(true);
});
it('rejects hostile runtime data without evaluating accessors or exposing secrets',async()=>{
  let invoked=false;expect(()=>createOutlineModelRuntime(Object.defineProperty({...config},'text',{enumerable:true,get(){invoked=true;throw new Error('private-secret');}}))).toThrow('INVALID_INPUT');expect(invoked).toBe(false);
  const runtime=createOutlineModelRuntime(config),execution=runtime.presetFor('project')!.execution;
  await expect(runtime.sessionFor(Object.defineProperty({tenantId:'tenant',projectId:'project',execution},'execution',{enumerable:true,get(){invoked=true;throw new Error('private-secret');}}),task)).rejects.toThrow('CONFLICT');expect(invoked).toBe(false);
  const {pricing:_pricing,...unpriced}=config.text!;expect(createOutlineModelRuntime({...config,text:unpriced}).presetFor('project')!.execution.pricing).toBeUndefined();
});
it.each(['json_schema','json_object'] as const)('uses one actual %s HTTP request for a legal large input/output and never retries completed invalid responses',async structuredOutput=>{
  let calls=0;const authorizations:(string|undefined)[]=[],sizes:number[]=[];
  const output={ok:true,text:'x'.repeat(300000)};const server=createServer((request,response)=>{void(async()=>{
    calls++;authorizations.push(request.headers.authorization);const chunks:Buffer[]=[];for await(const part of request)chunks.push(part as Buffer);sizes.push(Buffer.concat(chunks).length);
    response.setHeader('content-type','application/json');response.end(JSON.stringify({id:'outline-http-'+calls,choices:[{finish_reason:calls===1?'stop':'length',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:150,completion_tokens:80}}));
  })().catch(()=>response.destroy(new Error('Owned HTTP protocol fixture failed')));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Missing owned HTTP port');
  try{
    const runtime=createOutlineModelRuntime({...config,text:{...config.text!,structuredOutput,baseUrl:`http://127.0.0.1:${address.port}/v1`,allowPrivateNetworks:true,allowInsecureHttp:true}}),execution=runtime.presetFor('project')!.execution;
    const make=()=>runtime.sessionFor({tenantId:'tenant',projectId:'project',execution},task),session=await make();expect(calls).toBe(0);
    const input={messages:[{role:'user' as const,content:'x'.repeat(1100000)}],outputSchema:{name:'fixture',schema:{type:'object',properties:{ok:{type:'boolean'},text:{type:'string'}},required:['ok','text'],additionalProperties:false}},validate:(value:unknown)=>JSON.stringify(value)===JSON.stringify(output)};
    const context={tenantId:'tenant',connectionId:'outline-text',modeDigest:'a'.repeat(64),idempotencyKey:'fixture-call',signal:new AbortController().signal};
    expect(await session.complete(input,context)).toMatchObject({value:output,receipt:{providerRequestId:'outline-http-1',usage:{inputTokens:150,outputTokens:80}}});expect(sizes[0]).toBeGreaterThan(1048576);
    await expect(session.complete(input,context)).rejects.toMatchObject({code:'MODEL_KEY_REUSE'});expect(calls).toBe(1);
    await expect((await make()).complete(input,{...context,idempotencyKey:'invalid-completed'})).rejects.toMatchObject({outcome:'completed'});expect(calls).toBe(2);expect(authorizations).toEqual(['Bearer fixture-token','Bearer fixture-token']);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
