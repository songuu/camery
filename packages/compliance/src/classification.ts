import {capture,captureCorpus,freeze,validateCapturedSegments} from './boundary.js';
import {BatchSchema,ComplianceError,FindingSchema,MODEL_BATCH_PAIRS,MODEL_BATCH_SEGMENTS,MODEL_INPUT_BYTES,MODEL_OUTPUT_BYTES,ModelOutputSchema} from './contracts.js';
import type {Assessment,Batch,Finding,ModelOutput} from './contracts.js';
import {validatePolicy} from './rules.js';

const pairKey=(segmentId:string,categoryId:string)=>JSON.stringify([segmentId,categoryId]);
function invalid(path:string):never{throw new ComplianceError('INVALID_REFERENCE','classification evidence',path);}
function capturedBatch(input:unknown):Batch{
  const batch=capture(BatchSchema,input,'classification batch',MODEL_INPUT_BYTES);
  validateCapturedSegments(batch.segments);return freeze(batch);
}
/** No source text is summarized: every stable segment belongs to exactly one bounded classification request. */
export function createClassificationBatches(policyInput:unknown,corpusInput:unknown):Batch[]{
  const policy=validatePolicy(policyInput),corpus=captureCorpus(corpusInput),width=Math.min(MODEL_BATCH_SEGMENTS,Math.floor(MODEL_BATCH_PAIRS/policy.categories.length));
  const batches:Batch[]=[];for(let offset=0;offset<corpus.segments.length;offset+=width)batches.push({version:1,index:batches.length,segments:corpus.segments.slice(offset,offset+width)});
  return freeze(batches);
}
function boundary(text:string,index:number):boolean{
  if(index===0||index===text.length)return true;
  const before=text.charCodeAt(index-1),after=text.charCodeAt(index);
  return !(before>=0xd800&&before<=0xdbff&&after>=0xdc00&&after<=0xdfff);
}
/** Complete matrix integrity only. No not_flagged response is a legal approval or a quality guarantee. */
export function validateClassification(policyInput:unknown,batchInput:unknown,outputInput:unknown):ModelOutput{
  const policy=validatePolicy(policyInput),batch=capturedBatch(batchInput),output=capture(ModelOutputSchema,outputInput,'classification output',MODEL_OUTPUT_BYTES),expected=batch.segments.length*policy.categories.length;
  if(expected>MODEL_BATCH_PAIRS)throw new ComplianceError('INPUT_LIMIT','classification matrix','batch');
  if(output.assessments.length!==expected)throw new ComplianceError('INCOMPLETE','classification matrix','assessments');
  const segments=new Map(batch.segments.map(row=>[row.id,row])),categories=new Set(policy.categories.map(row=>row.id)),pairs=new Map<string,Assessment>();
  for(const [index,row]of output.assessments.entries()){
    const path=`assessments.${index}`,segment=segments.get(row.segmentId),key=pairKey(row.segmentId,row.categoryId);
    if(!segment||!categories.has(row.categoryId)||pairs.has(key))invalid(path);
    if(row.verdict==='not_flagged'){
      if(row.start!==0||row.end!==0||row.quote!==null)invalid(path+'.emptyEvidence');
    }else if(row.quote===null||row.start>=row.end||row.end>segment.text.length||!boundary(segment.text,row.start)||!boundary(segment.text,row.end)||segment.text.slice(row.start,row.end)!==row.quote)invalid(path+'.quote');
    pairs.set(key,row);
  }
  // A stable matrix order makes equivalent provider orderings replay identically without changing the original receipt DTO.
  const assessments=batch.segments.flatMap(segment=>policy.categories.map(category=>{const row=pairs.get(pairKey(segment.id,category.id));if(!row)throw new ComplianceError('INCOMPLETE','classification matrix','assessments');return row;}));
  return freeze({version:1,assessments});
}
export function classificationFindings(policyInput:unknown,batchInput:unknown,outputInput:unknown):Finding[]{
  const policy=validatePolicy(policyInput),batch=capturedBatch(batchInput),output=validateClassification(policy,batch,outputInput),segments=new Map(batch.segments.map(row=>[row.id,row])),categories=new Map(policy.categories.map(row=>[row.id,row]));
  const findings:Finding[]=[];for(const row of output.assessments){if(row.verdict==='not_flagged')continue;const segment=segments.get(row.segmentId)!,category=categories.get(row.categoryId)!;
    findings.push(capture(FindingSchema,{id:`model:${batch.index}:${pairKey(row.segmentId,row.categoryId)}`,origin:'model',ruleId:null,categoryId:row.categoryId,risk:category.risk,segmentId:segment.id,path:segment.path,start:row.start,end:row.end,quote:row.quote!,reason:row.reason,uncertain:row.verdict==='uncertain'},'classification finding',16384));
  }
  return freeze(findings);
}
