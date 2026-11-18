import { vi } from 'vitest';
import type { Role,SessionIdentity,SessionStore } from '@camery/access';
import type { DurableStore,Task } from '@camery/durable';
import type { OutlineCatalogReader,OutlineBriefCatalogReader,OutlineSourceCatalogReader } from '@camery/script/outline/node';
import { createOutlineWorkflow,outlineTaskReference,OUTLINE_WORKFLOW,OUTLINE_WORKFLOW_VERSION } from '@camery/script/outline/node';
import type { OutlinePreset } from '../src/outline-options.js';
import { createApplication } from '../src/app.js';
import { outlineWorkflowFixture } from '../../script/test/outline-workflow-support.js';
import { workflowJournal } from '../../script/test/workflow-support.js';

export const outlineHeaders={authorization:`Bearer cmry_${'b'.repeat(43)}`};
export const outlineBase='/api/v1/projects/project/outlines';
export const outlineApps:Awaited<ReturnType<typeof createApplication>>[]=[];
/** Real domain store/audit and adapter protocol, with explicit synthetic response and HTTP-human fixture only. */
export async function outlineHttpFixture(role:Role='admin',options:{ready?:boolean;large?:boolean}={}){
  const f=await outlineWorkflowFixture();
  if(options.large){
    const asset=f.output.assets[0]!,decision=f.output.adaptation.decisions[0]!;
    f.output.assets=Array.from({length:128},(_,index)=>({...structuredClone(asset),id:`asset-${index}`,description:'d'.repeat(1000),narrativeRole:'r'.repeat(1000)}));
    f.output.adaptation.decisions=Array.from({length:128},(_,index)=>({...structuredClone(decision),id:`decision-${index}`,reason:'r'.repeat(1000)}));
  }
  const journal=workflowJournal(f.task);
  const result=options.ready?await createOutlineWorkflow(f).run(outlineTaskReference(f.run),journal.context()):null;
  const originalStart=f.store.start.bind(f.store),originalReview=f.store.review.bind(f.store);
  const store={putBrief:vi.spyOn(f.store,'putBrief'),getBrief:vi.spyOn(f.store,'getBrief'),start:vi.spyOn(f.store,'start'),read:vi.spyOn(f.store,'read'),isCurrent:vi.spyOn(f.store,'isCurrent'),saveCandidate:vi.spyOn(f.store,'saveCandidate'),review:vi.spyOn(f.store,'review'),reject:vi.spyOn(f.store,'reject')};
  const saved=new Map<string,Task>();
  const tasks={get:vi.fn<DurableStore['get']>(async key=>{const task=saved.get(key.taskId);return task?.tenantId===key.tenantId?task:null;}),enqueue:vi.fn<DurableStore['enqueue']>(async input=>{
    const existing=saved.get(input.taskId);if(existing)return existing;
    const task:Task={...input,status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null};saved.set(task.taskId,task);return task;
  })};
  const catalog={list:vi.fn<OutlineCatalogReader['list']>(async()=>({items:[],nextCursor:null})),summary:vi.fn<OutlineCatalogReader['summary']>(async()=>({runId:f.run.runId,runDigest:f.run.digest,briefId:f.brief.briefId,briefRevision:f.brief.revision,createdAt:f.run.createdAt,candidateDigest:null,reviewStatus:null}))};
  const briefs={list:vi.fn<OutlineBriefCatalogReader['list']>(async()=>({items:[],nextCursor:null}))};
  const sources={list:vi.fn<OutlineSourceCatalogReader['list']>(async()=>({items:[],nextCursor:null}))};
  const presetFor=vi.fn<()=>OutlinePreset|null>(()=>({execution:f.execution,label:'测试大纲模型'}));
  const sessions={lookup:vi.fn(async()=>({tenantId:f.key.tenantId,userId:'http-human',sessionId:'outline-session',grants:[{projectId:f.key.projectId,role}]} as SessionIdentity|null)),revoke:vi.fn(async()=>{})} satisfies SessionStore;
  const now=vi.fn(()=>f.host.at);
  const application={tenantId:f.key.tenantId,store:sessions,outlines:{store:f.store,catalog,briefs,sources,tasks,presetFor,now}};
  const app=await createApplication(application);outlineApps.push(app);
  const {tenantId:_tenant,projectId:_project,...selection}=f.source.descriptor;
  const startBody=(runId=f.key.runId)=>({runId,briefId:f.brief.briefId,expectedRevision:f.brief.revision,expectedBriefDigest:f.brief.digest,source:structuredClone(selection)});
  const {tenantId:_putTenant,projectId:_putProject,actorId:_actor,...publicPut}=f.put;
  const briefBody=(briefId='saved-draft')=>({...publicPut,briefId,expectedRevision:0});
  const task=(status:Task['status']='queued'):Task=>({...f.task,workflow:OUTLINE_WORKFLOW,version:OUTLINE_WORKFLOW_VERSION,input:outlineTaskReference(f.run),maxAttempts:3,availableAt:null,status,attempts:0,fence:0,owner:null,leaseUntil:null,output:status==='succeeded'?result:null,error:'private provider credential'});
  const confirmBody=async()=>{const candidate=(await f.progress()).candidate;if(!candidate)throw new Error('Fixture needs a generated candidate');return {candidateDigest:candidate.digest,output:structuredClone(candidate.output),ablations:[{genre:'suspense' as const,judgment:'participates' as const,reason:'测试人工核对查证改变主线反击。'}],waivers:[]};};
  return {...f,app,journal,result,storeSpies:store,saved,tasks,catalog,briefs,sources,presetFor,sessions,now,startBody,briefBody,task,confirmBody,originalStart,originalReview};
}
