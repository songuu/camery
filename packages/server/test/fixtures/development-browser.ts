/** Browser protocol fixture: real Nest/HTTP and domain validators, typed in-memory storage, no PostgreSQL or real model inference. */
import {resolve} from 'node:path';
import type {SessionIdentity,SessionStore} from '@camery/access';
import {MethodRegistry,MethodRunner,createStructuredGenerationExecutor} from '@camery/methods';
import {captureBrief,DevelopmentError,generateFoundation,generateEpisodes,reviewFoundation,reviewEpisodes,rejectDevelopment,validateFoundationCandidate,validateEpisodeCandidate} from '@camery/script';
import {PutBriefSchema,StartRunSchema,developmentMethodPins,developmentRunDigest,developmentStageCallId,projectDevelopmentStatus} from '@camery/script/node';
import type {DevelopmentProgress,DevelopmentRun,DevelopmentRunKey,DevelopmentStore,StoredDevelopmentBrief} from '@camery/script/node';
import type {DurableStore,Task} from '@camery/durable';
import {protocolTransport,sessionFactory} from '../../../script/test/workflow-pg-support.js';
import {createApplication} from '../../src/app.js';

const execution={connectionId:'browser-protocol',modeDigest:'a'.repeat(64),modelIdentity:'synthetic-browser-model',evidence:'synthetic_replay' as const,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:2,tokens:200,costMicros:0}};
const methods=developmentMethodPins();const registry=new MethodRegistry();
// Register the exact method assets supplied by the ordinary runtime; the pins above remain its binding authority.
import {createOriginalFoundationMethodPack,createOriginalEpisodesMethodPack} from '@camery/script';
registry.register(createOriginalFoundationMethodPack());registry.register(createOriginalEpisodesMethodPack());
const states=new Map<string,DevelopmentProgress>();const briefs=new Map<string,StoredDevelopmentBrief[]>();const tasks=new Map<string,Task>();
let role:'admin'|'viewer'|'none'='admin';let revoked=false;let modelEnabled=true;let modelCalls=0;let lastRun:DevelopmentRunKey|null=null;
const copy=<T,>(value:T):T=>structuredClone(value);
const identity=(key:{tenantId:string;projectId:string;briefId?:string;runId?:string})=>JSON.stringify([key.tenantId,key.projectId,key.briefId??key.runId]);
const sessions:SessionStore={lookup:async()=>revoked?null:{tenantId:'tenant',userId:'browser-human',sessionId:'browser-session',grants:role==='none'?[]:[{projectId:'project',role},{projectId:'project-two',role}]} as SessionIdentity,revoke:async()=>{revoked=true;}};
function progress(key:DevelopmentRunKey){const found=states.get(identity(key));if(!found)throw new DevelopmentError('NOT_FOUND','browser run');return found;}
function history(key:{tenantId:string;projectId:string;briefId:string}){return briefs.get(identity(key))??[];}
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
function current(key:DevelopmentRunKey){const run=progress(key).run;return history({...key,briefId:run.brief.briefId}).at(-1)?.brief.digest===run.brief.digest;}
const store:DevelopmentStore={
  async putBrief(input){const command=PutBriefSchema.parse(input);const key=identity(command);const rows=briefs.get(key)??[];const {expectedRevision,actorId,...fields}=command;const brief=captureBrief({...fields,revision:expectedRevision+1});const prior=rows[expectedRevision];
    if(prior){if(prior.brief.digest===brief.digest&&prior.actorId===actorId)return copy(prior);throw new DevelopmentError('CONFLICT','browser brief revision');}
    if(rows.length!==expectedRevision)throw new DevelopmentError('CONFLICT','browser brief revision');const value={brief,actorId,createdAt:new Date().toISOString()};rows.push(value);briefs.set(key,rows);return copy(value);},
  async getBrief(key){const rows=history(key);const found=key.revision?rows[key.revision-1]:rows.at(-1);if(!found)throw new DevelopmentError('NOT_FOUND','browser brief');return copy(found);},
  async start(input){const command=StartRunSchema.parse(input);const key=identity({tenantId:command.tenantId,projectId:command.projectId,runId:command.runId});const found=states.get(key);if(found){if(found.run.brief.briefId!==command.briefId||found.run.brief.revision!==command.expectedRevision||found.run.brief.digest!==command.expectedBriefDigest)throw new DevelopmentError('CONFLICT','browser run retry');return copy(found.run);}
    const brief=history(command).at(-1)?.brief;if(!brief||brief.revision!==command.expectedRevision||brief.digest!==command.expectedBriefDigest)throw new DevelopmentError('CONFLICT','browser current brief');
    const body={tenantId:command.tenantId,projectId:command.projectId,runId:command.runId,brief,methods:command.methods,execution:command.execution};const run:DevelopmentRun={...body,digest:developmentRunDigest(body),createdAt:new Date().toISOString()};states.set(key,{run,foundation:{candidate:null,review:null},episodes:{candidate:null,review:null}});lastRun={tenantId:run.tenantId,projectId:run.projectId,runId:run.runId};return copy(run);},
  async read(key){return copy(progress(key));},isCurrent:async key=>current(key),
  async saveCandidate(key,candidate){const found=progress(key);const old=found[candidate.stage].candidate;if(old){if(old.digest!==candidate.digest)throw new DevelopmentError('CONFLICT','browser candidate');return copy(old);}
    if(candidate.model.callId!==developmentStageCallId(key,candidate.stage))throw new DevelopmentError('INVALID_EVIDENCE','browser model binding');
    const value=candidate.stage==='foundation'?validateFoundationCandidate(found.run.brief,candidate):validateEpisodeCandidate(found.run.brief,found.foundation.review?.status==='reviewed'?found.foundation.review:(()=>{throw new DevelopmentError('INCOMPLETE','browser foundation review');})(),candidate);Object.assign(found[candidate.stage],{candidate:value});return copy(value);},
  async review(key,stage,decision,host){const found=progress(key);const candidate=found[stage].candidate;if(!candidate)throw new DevelopmentError('NOT_FOUND','browser candidate');const prior=found[stage].review;
    if(prior){const input=decision as {candidateDigest:string;output:unknown};if(prior.status==='reviewed'&&prior.actorId===host.actor.id&&prior.candidateDigest===input.candidateDigest&&same(prior.output,input.output)){if(host.authorize({actorId:host.actor.id,brief:found.run.brief,stage,action:'development:review'})!==true)throw new DevelopmentError('FORBIDDEN','browser review');return copy(prior);}throw new DevelopmentError('CONFLICT','browser review retry');}
    if(!current(key))throw new DevelopmentError('CONFLICT','browser stale review');
    const result=stage==='foundation'?reviewFoundation(found.run.brief,found.foundation.candidate!,decision,host):reviewEpisodes(found.run.brief,found.foundation.review?.status==='reviewed'?found.foundation.review:(()=>{throw new DevelopmentError('INCOMPLETE','browser foundation review');})(),found.episodes.candidate!,decision,host);Object.assign(found[stage],{review:result});return copy(result);},
  async reject(key,stage,reason,host){const found=progress(key);const candidate=found[stage].candidate;if(!candidate)throw new DevelopmentError('NOT_FOUND','browser candidate');if(found[stage].review)throw new DevelopmentError('CONFLICT','browser review retry');const result=rejectDevelopment(found.run.brief,candidate,reason,host,found.foundation.review?.status==='reviewed'?found.foundation.review:undefined);Object.assign(found[stage],{review:result});return copy(result);},
};
const durable:Pick<DurableStore,'get'|'enqueue'>={
  async get(key){return copy(tasks.get(key.taskId)??null);},
  async enqueue(input){const prior=tasks.get(input.taskId);if(prior)return copy(prior);const ref=input.input as {projectId:string;runId:string;stage:'foundation'|'episodes'};const key={tenantId:input.tenantId,projectId:ref.projectId,runId:ref.runId};const found=progress(key);
    const model=await sessionFactory(protocolTransport(()=>{modelCalls++;}))({tenantId:key.tenantId,projectId:key.projectId,execution:found.run.execution},{tenantId:key.tenantId,taskId:input.taskId});const runner=new MethodRunner(registry,[createStructuredGenerationExecutor(model)]);const context={tenantId:key.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,idempotencyKey:developmentStageCallId(key,ref.stage),signal:new AbortController().signal};
    const candidate=ref.stage==='foundation'?await generateFoundation({brief:found.run.brief,method:found.run.methods.foundation,runner,context}):await generateEpisodes({brief:found.run.brief,foundation:found.foundation.review?.status==='reviewed'?found.foundation.review:(()=>{throw new DevelopmentError('INCOMPLETE','browser foundation review');})(),method:found.run.methods.episodes,runner,context});await store.saveCandidate(key,candidate);
    const task:Task={...input,status:'succeeded',attempts:1,fence:1,owner:null,leaseUntil:null,output:{state:'candidate',stage:ref.stage,digest:candidate.digest},error:null};tasks.set(input.taskId,task);return copy(task);},
};
function summary(found:DevelopmentProgress){const key={tenantId:found.run.tenantId,projectId:found.run.projectId,runId:found.run.runId};const view=projectDevelopmentStatus(found,current(key),{foundation:null,episodes:null});const {runId,briefId,briefRevision,createdAt,sourceChanged,foundationCandidateDigest,foundationReviewStatus,episodesCandidateDigest,episodesReviewStatus}=view;return {runId,briefId,briefRevision,createdAt,sourceChanged,foundationCandidateDigest,foundationReviewStatus,episodesCandidateDigest,episodesReviewStatus};}
const app=await createApplication({tenantId:'tenant',store:sessions,frontendDirectory:resolve(import.meta.dirname,'../../../web/dist'),
  sources:{novels:{read:async()=>{throw new Error('Browser source fixture has no documents');},append:async()=>{throw new Error('Browser source imports disabled');},checkpoint:async()=>{throw new Error('Browser source checkpoints disabled');}},scripts:{list:async()=>({items:[],nextCursor:null}),read:async()=>{throw new Error('Browser script imports disabled');},import:async()=>{throw new Error('Browser script imports disabled');}}},
  development:{store,tasks:durable,presetFor:projectId=>modelEnabled&&['project','project-two'].includes(projectId)?{methods,execution,label:'浏览器合成协议夹具 · 非真实模型'}:null,
    // Array.from follows Unicode code points, matching PostgreSQL left(text,120), rather than splitting a surrogate pair.
    briefs:{list:async key=>({items:[...briefs.values()].map(rows=>rows.at(-1)!).filter(value=>value.brief.tenantId===key.tenantId&&value.brief.projectId===key.projectId).map(value=>({briefId:value.brief.briefId,revision:value.brief.revision,ideaPreview:Array.from(value.brief.idea).slice(0,120).join(''),actorId:value.actorId,createdAt:value.createdAt})).sort((a,b)=>a.briefId.localeCompare(b.briefId)).slice(0,20),nextCursor:null})},
    catalog:{list:async key=>({items:[...states.values()].filter(value=>value.run.tenantId===key.tenantId&&value.run.projectId===key.projectId).reverse().slice(0,20).map(summary),nextCursor:null}),summary:async key=>summary(progress(key))}}});
await app.listen(0,'127.0.0.1');process.send?.({type:'ready',url:await app.getUrl()});
process.on('message',(message:unknown)=>{void(async()=>{const command=message as {id:number;action:string};
  if(command.action==='reset'){states.clear();briefs.clear();tasks.clear();role='admin';revoked=false;modelEnabled=true;modelCalls=0;lastRun=null;}
  else if(command.action==='forbid')role='none';else if(command.action==='viewer')role='viewer';else if(command.action==='revoke')revoked=true;else if(command.action==='restore'){role='admin';revoked=false;}
  else if(command.action==='no-model')modelEnabled=false;else if(command.action==='model')modelEnabled=true;
  else if(command.action==='stale-last'&&lastRun){const run=progress(lastRun).run;const latest=history({...lastRun,briefId:run.brief.briefId}).at(-1)!.brief;await store.putBrief({tenantId:lastRun.tenantId,projectId:lastRun.projectId,briefId:latest.briefId,expectedRevision:latest.revision,actorId:'browser-human',idea:latest.idea+'（已更新）',episodeCount:latest.episodeCount,targetSeconds:latest.targetSeconds});}
  else if(command.action==='unknown-last'&&lastRun){const task=[...tasks.values()].find(value=>value.input&&typeof value.input==='object'&&!Array.isArray(value.input)&&value.input['runId']===lastRun!.runId);if(task){task.status='reconciling';task.output=null;}}
  else if(command.action==='stop'){await app.close();process.exit(0);}
  process.send?.({type:'ack',id:command.id,stats:{modelCalls,runIds:[...states.values()].map(value=>value.run.runId),briefIds:[...briefs.values()].map(rows=>rows.at(-1)!.brief.briefId)}});
})().catch(error=>{process.send?.({type:'fixture-error',message:String(error)});});});
const stop=()=>{void app.close().then(()=>process.exit(0));};process.once('SIGTERM',stop);process.once('SIGINT',stop);
