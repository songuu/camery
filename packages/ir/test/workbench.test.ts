import {expect,it} from 'vitest';
import {fixtureId as id,changeSet} from './fixtures';
import {DevelopmentCandidatePrepareSchema,WorkbenchActionReceiptSchema,WorkbenchAdoptSchema,WorkbenchCandidateListQuerySchema,WorkbenchCandidateSummarySchema,WorkbenchPreviewSchema,WorkbenchRejectSchema,WorkbenchStateSchema,WorkbenchSubmitSchema,WorkbenchUpgradeSchema,workbenchEnvelope,WorkbenchReadQuerySchema,WorkbenchObjectRowSchema,WorkbenchObjectHistorySchema} from '../src/workbench';

const base={expectedSnapshotRevision:5,expectedWriteVersion:2};
it('keeps browser commands strict and requires complete bases, host-free source pins and deliberate decisions',()=>{
  const preparation={...base,applicationId:'application',runDigest:'a'.repeat(64),briefDigest:'b'.repeat(64),foundationReviewDigest:'c'.repeat(64),episodesReviewDigest:'d'.repeat(64)};
  expect(DevelopmentCandidatePrepareSchema.parse(preparation)).toEqual(preparation);
  for(const extra of [{tenantId:'self'},{actor:'self'},{target:{projectId:id('other')}},{profile:'secret'}])expect(DevelopmentCandidatePrepareSchema.safeParse({...preparation,...extra}).success).toBe(false);
  const scope={kind:'project',id:id('prj_demo')};expect(WorkbenchAdoptSchema.parse({...base,scope})).toEqual({...base,scope});
  for(const reason of ['','   ','\0','\ud800','x'.repeat(501)])expect(WorkbenchRejectSchema.safeParse({...base,scope,reason}).success).toBe(false);
  expect(WorkbenchRejectSchema.parse({...base,scope,reason:'补充人物的选择'}).reason).toBe('补充人物的选择');
  expect(WorkbenchUpgradeSchema.safeParse({...base,applicationId:'upgrade',autoAdopt:true}).success).toBe(false);
  for(const value of [0,-1,Number.MAX_SAFE_INTEGER+1,Infinity])expect(WorkbenchUpgradeSchema.safeParse({...base,applicationId:'upgrade',expectedWriteVersion:value}).success).toBe(false);
});
it('shares a single bounded receipt/envelope shape and keeps candidate preparation distinct from a committed result',()=>{
  const receipt={version:1,changeId:id('change'),status:'unchanged',snapshotRevision:5,writeVersion:2,issues:[],warnings:[],adoption:null,rejection:null};
  expect(workbenchEnvelope(WorkbenchActionReceiptSchema).parse({data:receipt,requestId:'request'})).toEqual({data:receipt,requestId:'request'});
  expect(WorkbenchActionReceiptSchema.safeParse({...receipt,status:'prepared'}).success).toBe(false);
  expect(WorkbenchCandidateSummarySchema.parse({contractVersion:1,projectKey:'ordinary-project',candidateId:id('change'),applicationId:'application',managed:true,status:'prepared',authorId:id('author'),authorKey:'author',createdAt:null,baseRevision:5,source:{kind:'development',runId:'run',state:'unchecked'}}).status).toBe('prepared');
  expect(workbenchEnvelope(WorkbenchActionReceiptSchema).safeParse({data:receipt,requestId:'bad\n'}).success).toBe(false);
  expect(WorkbenchStateSchema.safeParse({contractVersion:1,projectKey:'project',projectId:id('prj_demo'),schemaVersion:'0.6.0-draft',snapshotRevision:5,writeVersion:2,actorId:null,canWrite:false,canReview:false,nativePending:0,counts:[],secret:'hidden'}).success).toBe(false);
});
it('bounds metadata pagination and retains existing strict ChangeSet validation at preview and submit',()=>{
  expect(WorkbenchCandidateListQuerySchema.parse({limit:'50',runId:'run'})).toEqual({limit:50,runId:'run'});
  for(const value of [{limit:51},{limit:0},{cursor:'x'.repeat(4097)},{tenantId:'forged'}])expect(WorkbenchCandidateListQuerySchema.safeParse(value).success).toBe(false);
  const change=changeSet([{op:'update',op_id:id('op'),collection:'shots',target:id('sh_1'),set:{action:'候选'}}]);
  expect(WorkbenchPreviewSchema.parse({change,expectedSnapshotRevision:5}).change).toEqual(change);
  expect(WorkbenchSubmitSchema.parse({...base,applicationId:'manual',change}).change).toEqual(change);
  expect(WorkbenchSubmitSchema.safeParse({...base,applicationId:'manual',change:{...change,status:'adopted'}}).success).toBe(false);
  const oversized={...change,ops:Array.from({length:501},()=>change.ops[0]!)};
  expect(WorkbenchPreviewSchema.safeParse({change:oversized,expectedSnapshotRevision:5}).success).toBe(false);
  expect(WorkbenchSubmitSchema.safeParse({...base,applicationId:'manual',change:oversized}).success).toBe(false);
  expect(WorkbenchPreviewSchema.safeParse({change:{...change,ops:[{...change.ops[0],set:{action:'大'.repeat(180000)}}]},expectedSnapshotRevision:5}).success).toBe(false);
});
it('separates versioned objects from unversioned lineage and strictly bounds read selectors',()=>{
  expect(WorkbenchReadQuerySchema.parse({limit:'200',expectedRevision:'5',collection:'locks'})).toEqual({limit:200,expectedRevision:5,collection:'locks'});
  for(const query of [{limit:201},{collection:'shot_lineage'},{actor:'self'},{expectedRevision:Number.MAX_SAFE_INTEGER+1},{cursor:'x'.repeat(4097)}])expect(WorkbenchReadQuerySchema.safeParse(query).success).toBe(false);
  expect(WorkbenchObjectRowSchema.safeParse({ref:{collection:'shots',id:id('sh_1'),version:2},role:'owned',value:{id:id('sh_1'),version:1}}).success).toBe(false);
});
it('requires history values and tombstones to agree with the actual revision reference',()=>{
  const ref={collection:'shots',id:id('sh_1'),version:2};const page={contractVersion:1,projectKey:'project',projectId:id('prj_demo'),collection:'shots',objectId:id('sh_1'),snapshotRevision:6,writeVersion:4,nextCursor:null,items:[{ref,parentVersion:1,snapshotRevision:6,changeId:id('remove-change'),deleted:true,value:null}]};
  expect(WorkbenchObjectHistorySchema.parse(page).items[0]!.deleted).toBe(true);
  expect(WorkbenchObjectHistorySchema.safeParse({...page,items:[{...page.items[0],deleted:false}]}).success).toBe(false);
  expect(WorkbenchObjectHistorySchema.safeParse({...page,items:[{...page.items[0],deleted:false,value:{id:id('other'),version:2}}]}).success).toBe(false);
});
