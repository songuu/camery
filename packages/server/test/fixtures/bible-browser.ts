/** Local browser protocol fixture only: no provider, credentials, database or real-user acceptance. */
import { resolve } from 'node:path';
import type { SessionIdentity,SessionStore } from '@camery/access';
import { BibleError,captureSource,confirmBible,rejectBibleCandidate } from '@camery/bible';
import { bibleRunDigest,projectBibleRun } from '@camery/bible/node';
import type { BibleProgress,BibleStore,BibleRun } from '@camery/bible/node';
import { reviewFixture } from '../../../bible/test/review-support.js';
import { createApplication } from '../../src/app.js';

const fixture=reviewFixture();
const execution={connectionId:'browser-protocol-fixture',modeDigest:'a'.repeat(64),modelIdentity:'synthetic-browser-fixture',evidence:'synthetic_replay' as const,modelTier:'economy' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:100,tokens:10000,costMicros:0}};
const states=new Map<string,BibleProgress>();
function make(runId:string):BibleProgress{
  const run:BibleRun={tenantId:'tenant',projectId:'project',runId,source:captureSource(fixture.source),plan:fixture.plan,method:fixture.candidate.method,execution,digest:bibleRunDigest(fixture.plan,fixture.candidate.method,execution),createdAt:new Date().toISOString()};
  return {run,records:fixture.candidate.records,candidate:fixture.candidate,review:null};
}
states.set('review-fixture',make('review-fixture'));
let role:'admin'|'viewer'|'none'='admin';let revoked=false;
const sessions:SessionStore={lookup:async()=>revoked?null:{tenantId:'tenant',userId:'browser-human',sessionId:'browser-session',grants:role==='none'?[]:[{projectId:'project',role}]} as SessionIdentity,revoke:async()=>{revoked=true;}};
function read(runId:string){const found=states.get(runId);if(!found)throw new BibleError('NOT_FOUND','browser run');return found;}
const store:BibleStore={
  start:async(input:unknown)=>{const runId=(input as {runId:string}).runId;const found=states.get(runId)??make(runId);states.set(runId,found);return found.run;},
  read:async key=>read(key.runId),isCurrent:async()=>true,
  materialize:async()=>fixture.candidate,saveChunk:async(_key,record)=>record,
  confirm:async(key,decision,host)=>{const progress=read(key.runId);const review=confirmBible(fixture.source,fixture.candidate,decision,host);states.set(key.runId,{...progress,review});return review;},
  reject:async(key,reason,host)=>{const progress=read(key.runId);const review=rejectBibleCandidate(fixture.source,fixture.candidate,reason,host);states.set(key.runId,{...progress,review});return review;},
};
function summary(progress:BibleProgress){const view=projectBibleRun(progress,true,null);const {runId,createdAt,source,completedChunks,totalChunks,candidateDigest,reviewStatus,sourceChanged}=view;return {runId,createdAt,source,completedChunks,totalChunks,candidateDigest,reviewStatus,sourceChanged};}
const app=await createApplication({tenantId:'tenant',store:sessions,frontendDirectory:resolve(import.meta.dirname,'../../../web/dist'),
  sources:{novels:{read:async()=>({snapshot:{tenantId:'tenant',projectId:'project',documentId:'book',revision:1,text:fixture.source.document.text,batches:[],title:'雾港来信（浏览器协议夹具）'},document:fixture.source.document,checkpoint:null}),
    append:async()=>{throw new Error('Fixture upload is disabled');},checkpoint:async()=>{throw new Error('Fixture checkpoint is disabled');}},
    scripts:{list:async()=>({items:[{documentId:'book',title:'雾港来信（浏览器协议夹具）',kind:'novel',format:'novel',revision:1}],nextCursor:null}),
      read:async()=>{throw new Error('Fixture script is disabled');},import:async()=>{throw new Error('Fixture script is disabled');}}},
  bibles:{store,catalog:{list:async()=>({items:[...states.values()].map(summary).reverse(),nextCursor:null}),summary:async key=>({summary:summary(read(key.runId)),nextChunkId:null})},
    tasks:{get:async()=>null,enqueue:async()=>{throw new Error('A ready fixture never enqueues model work');}},
    presetFor:()=>({method:fixture.candidate.method,execution,label:'合成协议夹具 · 非真实模型'})}});
await app.listen(0,'127.0.0.1');
process.send?.({type:'ready',url:await app.getUrl()});
process.on('message',(message:unknown)=>{
  const command=message as {id:number;action:string};
  if(command.action==='forbid')role='none';
  else if(command.action==='revoke')revoked=true;
  else if(command.action==='restore'){role='admin';revoked=false;}
  else if(command.action==='viewer'){role='viewer';revoked=false;}
  else if(command.action==='reset'){states.clear();states.set('review-fixture',make('review-fixture'));role='admin';revoked=false;}
  process.send?.({type:'ack',id:command.id});
});
async function stop(){await app.close();process.exit(0);}
process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
