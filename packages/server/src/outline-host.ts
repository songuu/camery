import { z } from 'zod';
import { snapshotJson } from '@camery/methods/json';
import { OutlineError } from '@camery/script/outline/contracts';
import { OUTLINE_WORKFLOW,OUTLINE_WORKFLOW_VERSION,OutlineKeySchema,enqueueOutlineTask } from '@camery/script/outline/node';
import type { OutlineStore,OutlineCatalogReader } from '@camery/script/outline/node';
import { OutlineRunListSchema } from '@camery/script/outline/http';
import type { OutlineRunSummary } from '@camery/script/outline/http';
import type { DurableStore,DurableWorker } from '@camery/durable';

export interface OutlineHostOptions {
  readonly scope:{readonly tenantId:string;readonly projectId:string};readonly workerId:string;
  readonly store:OutlineStore;readonly catalog:OutlineCatalogReader;readonly durable:Pick<DurableStore,'enqueue'|'get'>;
  readonly worker:Pick<DurableWorker,'hasWorkflow'|'runTask'>;readonly pollMs?:number;readonly runsPerRound?:number;
}
export interface OutlineHostRound {readonly visited:number;readonly executed:number;readonly errors:number}
const Scope=OutlineKeySchema.omit({runId:true});
const Settings=z.strictObject({workerId:OutlineKeySchema.shape.runId,pollMs:z.int().min(50).max(60000),runsPerRound:z.int().min(1).max(50)});
function field(input:unknown,key:string,optional=false):unknown{
  const descriptor=Object.getOwnPropertyDescriptor(input,key);
  if(optional&&descriptor===undefined)return undefined;
  if(!descriptor||!('value' in descriptor))throw new Error('Host data field');return descriptor.value;
}
// Runtime stores use prototype methods; descriptor walking captures them without evaluating accessors.
function method<T>(input:unknown,key:string):T{
  let owner:unknown=input;
  for(let depth=0;owner!==null&&depth<8;depth++){
    const descriptor=Object.getOwnPropertyDescriptor(owner,key);
    if(descriptor){if(!('value' in descriptor)||typeof descriptor.value!=='function')throw new Error('Host method');return descriptor.value.bind(input) as T;}
    owner=Object.getPrototypeOf(owner);
  }
  throw new Error('Host method missing');
}
function wait(signal:AbortSignal,milliseconds:number):Promise<void>{
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,milliseconds);signal.addEventListener('abort',done,{once:true});});
}
/** All-run scan: a reviewed or stale result may still own an unfinished paid journal. This host grants no caller authorization. */
export function createOutlineHost(options:OutlineHostOptions){
  const captured=(()=>{
    let workflowUnavailable=false;
    try{
      const scope=Object.freeze(Scope.parse(snapshotJson(field(options,'scope'),2048)));
      const pollMs=field(options,'pollMs',true),runsPerRound=field(options,'runsPerRound',true);
      const settings=Object.freeze(Settings.parse(snapshotJson({workerId:field(options,'workerId'),pollMs:pollMs===undefined?1000:pollMs,runsPerRound:runsPerRound===undefined?20:runsPerRound},2048)));
      const catalog=field(options,'catalog'),worker=field(options,'worker'),source=field(options,'store'),tasks=field(options,'durable');
      const readPage=method<OutlineCatalogReader['list']>(catalog,'list'),hasWorkflow=method<DurableWorker['hasWorkflow']>(worker,'hasWorkflow'),runTask=method<DurableWorker['runTask']>(worker,'runTask');
      const store=Object.freeze({read:method<OutlineStore['read']>(source,'read'),isCurrent:method<OutlineStore['isCurrent']>(source,'isCurrent')});
      const durable=Object.freeze({get:method<DurableStore['get']>(tasks,'get'),enqueue:method<DurableStore['enqueue']>(tasks,'enqueue')});
      if(hasWorkflow(OUTLINE_WORKFLOW,OUTLINE_WORKFLOW_VERSION)!==true){workflowUnavailable=true;throw new Error('Workflow unavailable');}
      return {scope,settings,readPage,runTask,store,durable};
    }catch{throw new OutlineError('INVALID_INPUT',workflowUnavailable?'outline host workflow unavailable':'outline host configuration','host');}
  })();
  const {scope,settings,readPage,runTask,store,durable}=captured;
  let cursor:string|undefined,remaining:OutlineRunSummary[]=[];let pageEndsScan=false,busy=false;
  async function round(signal?:AbortSignal):Promise<OutlineHostRound>{
    if(busy)throw new OutlineError('CONFLICT','outline host concurrent round','host');busy=true;let visited=0,executed=0,errors=0;
    // Stop can arrive during source lookup. Keep the captured callback but prevent a new enqueue after that stop.
    const tasks={get:durable.get,enqueue:async(input:Parameters<DurableStore['enqueue']>[0])=>{if(signal?.aborted)throw new OutlineError('CONFLICT','outline host stopped','host');return durable.enqueue(input);}};
    try{
      while(visited<settings.runsPerRound&&!signal?.aborted){
        if(!remaining.length){
          if(pageEndsScan){pageEndsScan=false;cursor=undefined;break;}
          try{
            const page=OutlineRunListSchema.parse(await readPage(Object.freeze({...scope,...(cursor?{cursor}:{})})));
            if(page.nextCursor!==null&&(page.items.length===0||page.nextCursor===cursor))throw new Error('Invalid continuation');
            remaining=page.items;cursor=page.nextCursor??undefined;pageEndsScan=page.nextCursor===null;
            if(!remaining.length){pageEndsScan=false;cursor=undefined;break;}
          }catch{throw new OutlineError('STORAGE_FAILED','outline host catalog','storage');}
        }
        if(signal?.aborted)break;
        const summary=remaining.shift()!;visited++;
        try{
          const dispatch=await enqueueOutlineTask(store,tasks,{...scope,runId:summary.runId});if(signal?.aborted)break;
          if(dispatch.state==='task'&&['queued','running','waiting'].includes(dispatch.task.status)){
            const result=await runTask({tenantId:scope.tenantId,taskId:dispatch.task.taskId},settings.workerId);if(result)executed++;
          }
        }catch{if(signal?.aborted)break;errors++;}
      }
      return Object.freeze({visited,executed,errors});
    }finally{busy=false;}
  }
  return Object.freeze({round,async run(signal:AbortSignal):Promise<{reason:'stopped';rounds:number;errors:number}>{
    let rounds=0,errors=0;while(!signal.aborted){const result=await round(signal);rounds++;errors+=result.errors;await wait(signal,settings.pollMs);}
    // The current runTask is awaited by round before pools can be closed by the entrypoint.
    return {reason:'stopped',rounds,errors};
  }});
}
