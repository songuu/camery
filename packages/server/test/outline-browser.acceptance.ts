/** Explicit browser gate: real Nest/auth/domain HTTP with in-memory SQL protocol and synthetic model, never a PG/quality claim. */
import {fork} from 'node:child_process';
import {resolve} from 'node:path';
import {expect,it} from 'vitest';
import {createOutlineWorkflow} from '@camery/script/outline/node';
import type {OutlineRunKey} from '@camery/script/outline/node';
import {createApplication} from '../src/app.js';
import {outlineHttpFixture,outlineApps} from './outline-http-support.js';
import {workflowJournal} from '../../script/test/workflow-support.js';
it('operates full outline editing, original-ID ACK retries and recovered human audits in Chromium',async()=>{
  const f=await outlineHttpFixture('admin',{large:true});await f.app.close();
  f.output.adaptation.logline='<img src=x onerror="globalThis.outlineXss=1">';
  const key=(runId:string):OutlineRunKey=>({...f.key,runId});
  async function summary(runId:string){const p=await f.store.read(key(runId));return {runId,runDigest:p.run.digest,briefId:p.run.brief.briefId,briefRevision:p.run.brief.revision,createdAt:p.run.createdAt,candidateDigest:p.candidate?.digest??null,reviewStatus:p.review?.status??null};}
  f.catalog.summary.mockImplementation(input=>summary(input.runId));
  f.catalog.list.mockImplementation(async()=>({items:await Promise.all(f.db.data.runs.map(row=>summary(String(row.run_id)))),nextCursor:null}));
  f.briefs.list.mockImplementation(async()=>{const ids=[...new Set(f.db.data.briefs.map(row=>String(row.brief_id)))];return {items:await Promise.all(ids.map(async briefId=>{const s=await f.store.getBrief({tenantId:f.key.tenantId,projectId:f.key.projectId,briefId});return {briefId,revision:s.brief.revision,notesPreview:s.brief.notes.slice(0,240),actorId:s.actorId,createdAt:s.createdAt};})),nextCursor:null};});
  const {tenantId:_tenant,projectId:_project,...source}=f.source.descriptor;
  f.sources.list.mockImplementation(async input=>({items:input.kind===source.kind?[{source,createdAt:f.run.createdAt}]:[],nextCursor:null}));
  const enqueue=f.tasks.enqueue.getMockImplementation()!;
  f.tasks.enqueue.mockImplementation(async input=>{const task=await enqueue(input);if(task.status!=='succeeded'){
    const result=await createOutlineWorkflow(f).run(input.input,workflowJournal({tenantId:task.tenantId,taskId:task.taskId}).context());
    const done={...task,status:'succeeded' as const,output:result};f.saved.set(task.taskId,done);return done;
  }return task;});
  const app=await createApplication({tenantId:f.key.tenantId,store:f.sessions,frontendDirectory:resolve('../web/dist'),outlines:{store:f.store,catalog:f.catalog,briefs:f.briefs,sources:f.sources,tasks:f.tasks,presetFor:f.presetFor,now:f.now}});
  outlineApps.push(app);await app.listen(0,'127.0.0.1');
  const child=fork(resolve('../../scripts/outline-browser.mjs'),[await app.getUrl()],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});let diagnostic='';child.stdout?.on('data',data=>{diagnostic+=String(data);});child.stderr?.on('data',data=>{diagnostic+=String(data);});
  child.on('message',(value:unknown)=>{const message=value as {id:number;action:string};
    if(message.action==='stale')f.db.state.current=false;
    else if(message.action==='current')f.db.state.current=true;
    else if(message.action==='no-text')f.presetFor.mockReturnValue(null);
    else if(message.action==='viewer')f.sessions.lookup.mockResolvedValue({tenantId:f.key.tenantId,userId:'http-human',sessionId:'outline-session',grants:[{projectId:f.key.projectId,role:'viewer'}]});
    child.send({type:'ack',id:message.id});
  });
  try{const code=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Owned browser process exceeded its acceptance deadline'));},150000);child.once('exit',code=>{clearTimeout(timer);resolve(code);});child.once('error',error=>{clearTimeout(timer);reject(error);});});expect(code,diagnostic).toBe(0);expect(f.sessionFor).toHaveBeenCalledTimes(1);expect(f.allocate).toHaveBeenCalledTimes(1);expect(f.db.data.reviews).toHaveLength(1);console.log(diagnostic.trim());}
  finally{if(child.exitCode===null)child.kill();await app.close();}
},180000);
