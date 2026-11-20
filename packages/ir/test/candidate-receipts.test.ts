import {expect,it} from 'vitest';
import {CandidateReceiptSchema,CandidateReceiptQuerySchema,CandidateReceiptPageSchema,type CandidateReceipt,type CandidateReceiptQuery,type CandidateReceiptPage} from '@camery/ir/candidate-receipts';
import {OutlineReceiptSchema,OutlineReceiptQuerySchema,OutlineReceiptPageSchema} from '../src/outline-adoption';
import {WorkbenchActionReceiptSchema} from '../src/workbench';
import {fixtureId as id} from './fixtures';

const issue={code:'SOURCE_DEPENDENCY',where:'/episodes/0',message:'核对来源依赖。'};
const receipt:CandidateReceipt={contractVersion:1,projectKey:'project',candidateId:id('candidate'),kind:'preparation',requestId:'application',status:'candidate',snapshotRevision:1,writeVersion:2,issueCount:0,warningCount:32768,adoption:null,rejection:null};
const query:CandidateReceiptQuery={kind:'preparation',requestId:'application',section:'warnings',limit:50};
const page:CandidateReceiptPage={contractVersion:1,projectKey:receipt.projectKey,candidateId:receipt.candidateId,kind:receipt.kind,requestId:receipt.requestId,section:'warnings',total:32768,items:[issue],nextCursor:null};

it('preserves the existing Outline receipt exports as identical neutral schema aliases',()=>{
  expect(OutlineReceiptSchema).toBe(CandidateReceiptSchema);
  expect(OutlineReceiptQuerySchema).toBe(CandidateReceiptQuerySchema);
  expect(OutlineReceiptPageSchema).toBe(CandidateReceiptPageSchema);
  expect(CandidateReceiptSchema.parse(receipt)).toEqual(OutlineReceiptSchema.parse(receipt));
  expect(CandidateReceiptQuerySchema.parse(query)).toEqual(OutlineReceiptQuerySchema.parse(query));
  expect(CandidateReceiptPageSchema.parse(page)).toEqual(OutlineReceiptPageSchema.parse(page));
});
it('preserves tens of thousands of native warnings with complete counts and bounded pages',()=>{
  const warnings=Array.from({length:32768},(_,index)=>({...issue,where:`/warnings/${index}`}));
  expect(CandidateReceiptSchema.parse(receipt).warningCount).toBe(warnings.length);
  const delivered=[];
  for(let offset=0;offset<warnings.length;offset+=50){
    const next=offset+50<warnings.length?`cursor-${offset+50}`:null;
    delivered.push(...CandidateReceiptPageSchema.parse({...page,items:warnings.slice(offset,offset+50),nextCursor:next}).items);
  }
  expect(delivered).toEqual(warnings);
  expect(WorkbenchActionReceiptSchema.safeParse({version:1,changeId:receipt.candidateId,status:'candidate',snapshotRevision:1,writeVersion:2,issues:[],warnings,adoption:null,rejection:null}).success).toBe(false);
});
it('retains the receipt budgets and strict transport shape',()=>{
  expect(CandidateReceiptSchema.parse({...receipt,issueCount:131072,warningCount:131072}).issueCount).toBe(131072);
  expect(CandidateReceiptPageSchema.parse({...page,total:131072,items:Array.from({length:50},()=>issue),nextCursor:'c'.repeat(4096)}).items).toHaveLength(50);
  for(const value of [-1,1.5,131073,Number.MAX_SAFE_INTEGER+1,Infinity,'1',null,true]){
    expect(CandidateReceiptSchema.safeParse({...receipt,warningCount:value}).success).toBe(false);
    expect(CandidateReceiptPageSchema.safeParse({...page,total:value}).success).toBe(false);
  }
  for(const extra of [{issues:[issue]},{warnings:[issue]},{actorId:id('actor')},{tenantId:'tenant'},{draft:{}}])expect(CandidateReceiptSchema.safeParse({...receipt,...extra}).success).toBe(false);
  expect(CandidateReceiptPageSchema.safeParse({...page,items:Array.from({length:51},()=>issue)}).success).toBe(false);
  for(const nextCursor of ['','c'.repeat(4097)])expect(CandidateReceiptPageSchema.safeParse({...page,nextCursor}).success).toBe(false);
});
it('uses strict decimal query selectors without null or boolean coercion',()=>{
  expect(CandidateReceiptQuerySchema.parse({...query,limit:'50',cursor:'c'.repeat(4096)})).toEqual({...query,cursor:'c'.repeat(4096)});
  for(const limit of [0,-1,51,1.5,Infinity,NaN,'','01','1.0','1e1',' 1','1\n',null,true,false])expect(CandidateReceiptQuerySchema.safeParse({...query,limit}).success).toBe(false);
  for(const cursor of ['','c'.repeat(4097),null,true])expect(CandidateReceiptQuerySchema.safeParse({...query,cursor}).success).toBe(false);
  for(const extra of [{actor:'actor'},{actorId:id('actor')},{tenantId:'tenant'},{scope:{kind:'project',id:id('project')}}]){
    expect(CandidateReceiptQuerySchema.safeParse({...query,...extra}).success).toBe(false);
    expect(CandidateReceiptPageSchema.safeParse({...page,...extra}).success).toBe(false);
  }
});
it('retains native audit values and reports candidate binding errors without source-specific language',()=>{
  const adoption={change_set_id:receipt.candidateId,actor_id:id('actor'),scope:{kind:'episode',id:id('episode')},from_revision:1,to_revision:2,at:'2026-11-20T00:00:00.000Z'};
  const rejection={actor_id:id('actor'),reason:'需要重新核对',at:adoption.at};
  expect(CandidateReceiptSchema.parse({...receipt,status:'adopted',adoption}).adoption).toEqual(adoption);
  expect(CandidateReceiptSchema.parse({...receipt,status:'rejected',rejection}).rejection).toEqual(rejection);
  const result=CandidateReceiptSchema.safeParse({...receipt,adoption:{...adoption,change_set_id:id('other')}});
  expect(result.success).toBe(false);
  if(!result.success){
    expect(result.error.issues.map(issue=>issue.message).join(' ')).toContain('candidate');
    expect(result.error.issues.map(issue=>issue.message).join(' ')).not.toMatch(/Outline|Screenplay/);
  }
});
