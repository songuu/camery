import { z } from 'zod';
import { DevelopmentError } from '@camery/script';
import { DEVELOPMENT_STAGE_WORKFLOW,DEVELOPMENT_STAGE_WORKFLOW_VERSION,DEVELOPMENT_REDO_WORKFLOW_VERSION,enqueueNextDevelopmentTask,RunKeySchema } from '@camery/script/node';
import type { DevelopmentStore,DevelopmentCatalogReader } from '@camery/script/node';
import { DevelopmentRunListSchema,type DevelopmentRunSummary } from '@camery/script/http';
import type { DurableStore,DurableWorker } from '@camery/durable';

export interface DevelopmentHostOptions {
  readonly scope:{readonly tenantId:string;readonly projectId:string};readonly workerId:string;
  readonly store:DevelopmentStore;readonly catalog:DevelopmentCatalogReader;readonly durable:Pick<DurableStore,'enqueue'|'get'>;
  readonly worker:Pick<DurableWorker,'hasWorkflow'|'runTask'>;readonly pollMs?:number;readonly runsPerRound?:number;
}
const Settings=z.strictObject({workerId:RunKeySchema.shape.runId,pollMs:z.int().min(50).max(60000),runsPerRound:z.int().min(1).max(50)});
export interface DevelopmentHostRound {readonly visited:number;readonly executed:number;readonly errors:number}
function wait(signal:AbortSignal,milliseconds:number):Promise<void>{
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,milliseconds);signal.addEventListener('abort',done,{once:true});});
}
/** Fair bounded all-run scan: a reviewed/stale business row may still own a paid unfinished physical task. */
export function createDevelopmentHost(options:DevelopmentHostOptions){
  const {tenantId,projectId}=RunKeySchema.pick({tenantId:true,projectId:true}).parse(options.scope);
  const settings=Settings.parse({workerId:options.workerId,pollMs:options.pollMs??1000,runsPerRound:options.runsPerRound??20});
  const readPage=options.catalog.list.bind(options.catalog);const runTask=options.worker.runTask.bind(options.worker);const store=options.store;const durable=options.durable;
  if(!options.worker.hasWorkflow(DEVELOPMENT_STAGE_WORKFLOW,DEVELOPMENT_STAGE_WORKFLOW_VERSION)||!options.worker.hasWorkflow(DEVELOPMENT_STAGE_WORKFLOW,DEVELOPMENT_REDO_WORKFLOW_VERSION))throw new DevelopmentError('INVALID_INPUT','development host workflow unavailable');
  let cursor:string|undefined;let remaining:DevelopmentRunSummary[]=[];let pageEndsScan=false;let busy=false;
  async function round(signal?:AbortSignal):Promise<DevelopmentHostRound>{
    if(busy)throw new DevelopmentError('CONFLICT','development host concurrent round');busy=true;let visited=0;let executed=0;let errors=0;
    try{
      while(visited<settings.runsPerRound&&!signal?.aborted){
        if(!remaining.length){
          if(pageEndsScan){pageEndsScan=false;cursor=undefined;break;}
          const page=DevelopmentRunListSchema.parse(await readPage({tenantId,projectId,...(cursor?{cursor}:{})}));remaining=page.items;cursor=page.nextCursor??undefined;pageEndsScan=page.nextCursor===null;
          if(!remaining.length){if(page.nextCursor!==null)throw new DevelopmentError('STORAGE_FAILED','empty development catalog continuation');pageEndsScan=false;cursor=undefined;break;}
        }
        const summary=remaining.shift()!;visited++;
        try{
          const dispatch=await enqueueNextDevelopmentTask(store,durable,{tenantId,projectId,runId:summary.runId});if(signal?.aborted)break;
          if(dispatch.state==='task'&&['queued','running','waiting'].includes(dispatch.task.status)){
            const result=await runTask({tenantId,taskId:dispatch.task.taskId},settings.workerId);if(result)executed++;
          }
        }catch{errors++;}
      }
      return Object.freeze({visited,executed,errors});
    }finally{busy=false;}
  }
  return Object.freeze({round,async run(signal:AbortSignal):Promise<{reason:'stopped';rounds:number;errors:number}>{
    let rounds=0;let errors=0;while(!signal.aborted){const result=await round(signal);rounds++;errors+=result.errors;await wait(signal,settings.pollMs);}
    // Await the active attempt before returning, so the entrypoint can close both pools without interrupting a paid journal tail.
    return {reason:'stopped',rounds,errors};
  }});
}
