import { expect,it } from 'vitest';
import { z } from 'zod';
import { captureOutlineBrief } from '../src/outline/node/brief.js';
import { reviewOutlineCraft } from '../src/outline/outline.js';
import { outlineFixture } from './outline-support.js';
import * as http from '../src/outline/http.js';

const h='a'.repeat(64),at='2026-11-17T14:00:00.000Z';
const selection={kind:'development' as const,runId:'original',runDigest:h,briefDigest:h,foundationReviewDigest:h,episodesReviewDigest:h};
function fixture(){
  const f=outlineFixture(),{sourceRefIds:_refs,...context}=f.context;
  const {tenantId:_tenant,projectId:_project,...brief}=captureOutlineBrief({tenantId:'tenant',projectId:'project',briefId:'adaptation',revision:1,notes:'保留共同记忆的冲突。',...context});
  const report=reviewOutlineCraft(f.context,f.output,brief.thresholds);
  const source={version:1 as const,descriptor:selection,material:{title:'停钟之夜'},references:f.context.sourceRefIds.map(id=>({id,path:'/story'})),digest:h};
  const summary={runId:'outline',runDigest:h,briefId:brief.briefId,briefRevision:1,createdAt:at,candidateDigest:h,reviewStatus:null};
  const task={status:'succeeded' as const,resultState:'candidate' as const,reason:null};
  const view={...summary,sourceChanged:false,state:'awaiting_review' as const,task,brief,source,candidate:{digest:h,output:f.output,report},review:null};
  const confirm={candidateDigest:h,output:f.output,ablations:[{genre:'suspense' as const,judgment:'participates' as const,reason:'查证改变反击条件。'}],waivers:[]};
  return {...f,brief,source,summary,task,view,confirm,report};
}
function largeOutput(){
  const output=outlineFixture().output,asset=output.assets[0]!,decision=output.adaptation.decisions[0]!;
  output.assets=Array.from({length:128},(_,index)=>({...structuredClone(asset),id:`asset-${index}`,description:'d'.repeat(1000),narrativeRole:'r'.repeat(1000)}));
  output.adaptation.decisions=Array.from({length:128},(_,index)=>({...structuredClone(decision),id:`decision-${index}`,reason:'r'.repeat(1000)}));
  return output;
}
it('provides strict browser requests without allowing a caller to set scope, execution or human identity',()=>{
  const f=fixture(),{version:_v,revision:_r,profiles:_p,digest:_d,...write}=f.brief;
  const command={...write,expectedRevision:0};expect(http.OutlineBriefWriteSchema.parse(command)).toEqual(command);
  const start={runId:'outline',briefId:'adaptation',expectedRevision:1,expectedBriefDigest:h,source:selection};expect(http.OutlineStartSchema.parse(start)).toEqual(start);
  expect(http.OutlineConfirmSchema.parse(f.confirm)).toEqual(f.confirm);expect(http.OutlineRejectSchema.parse({reason:'需要重写冲突。'})).toEqual({reason:'需要重写冲突。'});
  for(const field of ['tenantId','projectId','actorId','at','execution','model','authorize','approved']){
    for(const [schema,value] of [[http.OutlineBriefWriteSchema,command],[http.OutlineStartSchema,start],[http.OutlineConfirmSchema,f.confirm],[http.OutlineRejectSchema,{reason:'需要重写。'}]] as const)
      expect(schema.safeParse({...value,[field]:'forged'}).success,field).toBe(false);
  }
  for(const field of ['revision','profiles','digest'])expect(http.OutlineBriefWriteSchema.safeParse({...command,[field]:1}).success).toBe(false);
});
it('offers both exact source selections while rejecting embedded scope, receipts and unrecognized source kinds',()=>{
  expect(http.OutlineSourceSelectionSchema.parse(selection)).toEqual(selection);
  const bible={kind:'bible',runId:'bible',runDigest:h,documentId:'book',revision:1,sourceDigest:h,reviewDigest:h};
  expect(http.OutlineSourceSelectionSchema.parse(bible)).toEqual(bible);
  for(const extra of [{tenantId:'other'},{projectId:'other'},{model:{providerRequestId:'forged'}},{review:{approved:true}},{execution:{}}])
    for(const source of [selection,bible])expect(http.OutlineSourceSelectionSchema.safeParse({...source,...extra}).success).toBe(false);
  for(const source of [{...bible,kind:'url'},{...bible,revision:0},{...bible,reviewDigest:'bad'},{...selection,episodesReviewDigest:undefined}])
    expect(http.OutlineSourceSelectionSchema.safeParse(source).success).toBe(false);
});
it('validates bounded queries, exact decimal revisions and model capabilities without implicit model availability',()=>{
  expect(http.OutlineReadBriefQuerySchema.parse({revision:'2'})).toEqual({revision:2});expect(http.OutlineReadBriefQuerySchema.parse({})).toEqual({});
  for(const revision of ['0','01','-1','1.5','1e2','9007199254740992','1\n'])expect(http.OutlineReadBriefQuerySchema.safeParse({revision}).success).toBe(false);
  for(const schema of [http.OutlineListQuerySchema,http.OutlineBriefListQuerySchema]){
    expect(schema.parse({cursor:'abc'})).toEqual({cursor:'abc'});expect(schema.safeParse({cursor:'x'.repeat(513)}).success).toBe(false);expect(schema.safeParse({tenantId:'tenant'}).success).toBe(false);
  }
  expect(http.OutlineSourceListQuerySchema.parse({kind:'bible'})).toEqual({kind:'bible'});expect(http.OutlineSourceListQuerySchema.safeParse({}).success).toBe(false);
  expect(http.OutlineCapabilitiesSchema.parse({canStart:false,modelLabel:null,budget:null,defaultEpisodeCount:10})).toEqual({canStart:false,modelLabel:null,budget:null,defaultEpisodeCount:10,formalAdoption:false});
  expect(http.OutlineCapabilitiesSchema.safeParse({canStart:true,modelLabel:'fixture',budget:{currency:'CNY',tokens:300,costMicros:10},defaultEpisodeCount:10,formalAdoption:false}).success).toBe(true);
  expect(http.OutlineCapabilitiesSchema.safeParse({canStart:false,modelLabel:null,budget:null,defaultEpisodeCount:3}).success).toBe(false);
});
it('round trips complete public briefs, bounded metadata pages, status and reviewed/rejected details',()=>{
  const f=fixture(),brief={brief:f.brief,actorId:'editor',createdAt:at};expect(http.OutlineBriefViewSchema.parse(brief)).toEqual(brief);
  const summary={briefId:'adaptation',revision:1,notesPreview:' '.repeat(120),actorId:'editor',createdAt:at};
  expect(http.OutlineBriefListSchema.parse({items:[summary],nextCursor:null})).toEqual({items:[summary],nextCursor:null});
  expect(http.OutlineRunListSchema.parse({items:[f.summary],nextCursor:'cursor'})).toEqual({items:[f.summary],nextCursor:'cursor'});
  expect(http.OutlineSourceListSchema.parse({items:[{source:selection,createdAt:at}],nextCursor:null})).toEqual({items:[{source:selection,createdAt:at}],nextCursor:null});
  expect(http.OutlineRunViewSchema.parse(f.view)).toEqual(f.view);
  const review={status:'reviewed' as const,digest:h,candidateDigest:h,actorId:'editor',at,output:f.output,report:f.report,ablations:f.confirm.ablations,waivers:[]};
  expect(http.OutlineRunViewSchema.parse({...f.view,reviewStatus:'reviewed',state:'reviewed',review})).toMatchObject({review});
  const rejected={status:'rejected',digest:h,candidateDigest:h,actorId:'editor',at,reason:'需要更明确的反击。'};
  expect(http.OutlineRunViewSchema.parse({...f.view,reviewStatus:'rejected',state:'rejected',review:rejected})).toMatchObject({review:rejected});
  for(const [schema,item] of [[http.OutlineBriefListSchema,summary],[http.OutlineRunListSchema,f.summary],[http.OutlineSourceListSchema,{source:selection,createdAt:at}]] as const)
    expect(schema.safeParse({items:Array.from({length:21},()=>item),nextCursor:null}).success).toBe(false);
});
it.each(['not_dispatched','queued','running','waiting','reconciling','blocked','failed','cancelled','awaiting_review','reviewed','rejected','stale'])('preserves explicit %s business status',state=>{
  const {view}=fixture();const {brief:_b,source:_s,candidate:_c,review:_r,...status}=view;
  expect(http.OutlineStatusSchema.parse({...status,state}).state).toBe(state);
});
it('rejects raw execution, task errors and receipt fields at every public response boundary',()=>{
  const f=fixture();
  for(const field of ['execution','model','receipt','error','tenantId','projectId'])expect(http.OutlineRunViewSchema.safeParse({...f.view,[field]:'private'}).success).toBe(false);
  expect(http.OutlineRunViewSchema.safeParse({...f.view,brief:{...f.brief,tenantId:'tenant'}}).success).toBe(false);
  expect(http.OutlineRunViewSchema.safeParse({...f.view,candidate:{...f.view.candidate,model:{}}}).success).toBe(false);
  expect(http.OutlineTaskViewSchema.safeParse({...f.task,error:'private'}).success).toBe(false);
  expect(http.OutlineTaskViewSchema.safeParse({...f.task,reason:'private failure with spaces'}).success).toBe(false);
});
it('captures unknown JSON before any public schema can execute an accessor or follow a cycle',()=>{
  const f=fixture();
  const samples:[z.ZodType,unknown][]=[
    [http.OutlineBriefWriteSchema,{expectedRevision:0}], [http.OutlineSourceSelectionSchema,selection], [http.OutlineStartSchema,{runId:'outline'}],
    [http.OutlineConfirmSchema,f.confirm],[http.OutlineRejectSchema,{reason:'拒绝。'}], [http.OutlineCapabilitiesSchema,{}],
    [http.OutlineBriefSchemaPublic,f.brief], [http.OutlineBriefViewSchema,{brief:f.brief}], [http.OutlineBriefSummarySchema,{}], [http.OutlineBriefListSchema,{items:[]}],
    [http.OutlineSourceSummarySchema,{source:selection}],[http.OutlineSourceListSchema,{items:[]}],[http.OutlineSourceViewSchema,f.view.source],
    [http.OutlineRunSummarySchema,f.summary],[http.OutlineRunListSchema,{items:[]}],[http.OutlineTaskViewSchema,f.task],[http.OutlineStatusSchema,{}],
    [http.OutlineRunViewSchema,f.view],[http.OutlineCraftReportSchema,f.report],[http.OutlineListQuerySchema,{}], [http.OutlineBriefListQuerySchema,{}],
    [http.OutlineSourceListQuerySchema,{kind:'bible'}],[http.OutlineReadBriefQuerySchema,{}],
  ];
  for(const [schema,value] of samples){
    let invoked=false;const hostile=Object.defineProperty({...value as object},'private',{enumerable:true,get(){invoked=true;throw new Error('private getter');}});
    expect(()=>schema.safeParse(hostile)).not.toThrow();expect(schema.safeParse(hostile).success).toBe(false);expect(invoked).toBe(false);
    const cycle:{self?:unknown}={};cycle.self=cycle;expect(()=>schema.safeParse(cycle)).not.toThrow();expect(schema.safeParse(cycle).success).toBe(false);
    expect(schema.safeParse(Object.assign(Object.create({inherited:'private'}),value)).success).toBe(false);
  }
});
it('accepts complete output over the old 256KiB transport without truncation and independently enforces 512KiB output',()=>{
  const f=fixture(),output=largeOutput(),confirm={...f.confirm,output};
  expect(Buffer.byteLength(JSON.stringify(output))).toBeGreaterThan(262144);expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(524288);
  expect(http.OutlineConfirmSchema.parse(confirm)).toEqual(confirm);expect(http.OutlineRunViewSchema.parse({...f.view,candidate:{...f.view.candidate,output}}).candidate?.output).toEqual(output);
  const asset=output.assets[0]!;output.assets=Array.from({length:256},(_,i)=>({...asset,id:`large-${i}`}));
  expect(Buffer.byteLength(JSON.stringify(output))).toBeGreaterThan(524288);
  expect(http.OutlineConfirmSchema.safeParse({...f.confirm,output}).success).toBe(false);expect(http.OutlineRunViewSchema.safeParse({...f.view,candidate:{...f.view.candidate,output}}).success).toBe(false);
});
it('accepts complete reports and details above small or two-MiB envelopes while bounding source and each output',()=>{
  const f=fixture(),output=largeOutput();
  const report={...f.report,issues:Array.from({length:400},(_,i)=>({id:`ABLATION_REVIEW:beats.${i}`,code:'ABLATION_REVIEW',path:`beats.${i}`,episodeNumbers:[1],detail:'审'.repeat(1000)}))};
  expect(Buffer.byteLength(JSON.stringify(report))).toBeGreaterThan(65536);expect(http.OutlineCraftReportSchema.parse(report)).toEqual(report);
  const review={status:'reviewed' as const,digest:h,candidateDigest:h,actorId:'editor',at,output,report,ablations:f.confirm.ablations,waivers:[]};
  const detail={...f.view,state:'reviewed',reviewStatus:'reviewed',source:{...f.source,material:{text:'x'.repeat(300000)}},candidate:{digest:h,output,report},review};
  expect(Buffer.byteLength(JSON.stringify(detail))).toBeGreaterThan(2097152);expect(http.OutlineRunViewSchema.parse(detail)).toEqual(detail);
  expect(http.OutlineSourceViewSchema.safeParse({...f.source,material:{text:'x'.repeat(524288)}}).success).toBe(false);
  expect(http.OutlineRunViewSchema.safeParse({...detail,source:{...f.source,material:{text:'x'.repeat(524288)}}}).success).toBe(false);
});
it('retains all four hundred explicit human reasons in a legal confirm envelope',()=>{
  const f=fixture(),waivers=Array.from({length:400},(_,i)=>({issueId:`LATE_STAKES:episodes.${i}`,reason:'审'.repeat(1000)}));
  const confirm={...f.confirm,output:largeOutput(),waivers};
  expect(Buffer.byteLength(JSON.stringify(confirm))).toBeGreaterThan(1048576);expect(Buffer.byteLength(JSON.stringify(confirm))).toBeLessThanOrEqual(2097152);
  expect(http.OutlineConfirmSchema.parse(confirm)).toEqual(confirm);
  expect(http.OutlineConfirmSchema.safeParse({...confirm,waivers:[...waivers,waivers[0]]}).success).toBe(false);
  expect(http.OutlineConfirmSchema.safeParse({...confirm,ablations:Array.from({length:3},()=>f.confirm.ablations[0])}).success).toBe(false);
});
it('checks UTF8 bytes before structure at each operation limit and never exposes rejected payload content',()=>{
  expect(http.OUTLINE_HTTP_SMALL_BYTES).toBe(65536);expect(http.OUTLINE_HTTP_CONFIRM_BYTES).toBe(2097152);expect(http.OUTLINE_HTTP_DETAIL_BYTES).toBe(6291456);
  const bounded=http.boundedOutlineSchema(z.json(),20);expect(bounded.parse('审'.repeat(6))).toBe('审'.repeat(6));expect(bounded.safeParse('审'.repeat(7)).success).toBe(false);
  for(const [schema,limit] of [[http.OutlineStartSchema,65536],[http.OutlineConfirmSchema,2097152],[http.OutlineRunViewSchema,6291456]] as const){
    const rejected=schema.safeParse({private:'x'.repeat(limit)});expect(rejected.success).toBe(false);
    if(!rejected.success){expect(rejected.error.issues[0]?.message).toBe('Outline transport data limit');expect(JSON.stringify(rejected.error)).not.toContain('xxx');}
  }
});
