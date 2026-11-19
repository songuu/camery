import {z} from 'zod';
import {capture,freeze} from '../boundary.js';
import {AssessmentSchema,ComplianceError,Hash,Id,Integer,Text} from '../contracts.js';
import type {Assessment} from '../contracts.js';
import {hash} from './data.js';

export const EVALUATION_DATASET_BYTES=8388608,EVALUATION_PREDICTION_BYTES=16777216,EVALUATION_REPORT_BYTES=33554432,EVALUATION_MAX_PAIRS=65536;
const Label=z.strictObject({segmentId:Id,categoryId:Id,flagged:z.boolean()});
const EvaluationCase=z.strictObject({id:Id,sourceDigest:Hash,policyDigest:Hash,labels:z.array(Label).min(1).max(EVALUATION_MAX_PAIRS)});
export const EvaluationDatasetSchema=z.strictObject({version:z.literal(1),id:Id,revision:Integer.min(1),evidence:z.enum(['synthetic_fixture','provided_labels']),labelReference:Text(2000),cases:z.array(EvaluationCase).min(1).max(1024)});
export type EvaluationDataset=z.infer<typeof EvaluationDatasetSchema>;
export const EvaluationPredictionSchema=z.strictObject({caseId:Id,sourceDigest:Hash,policyDigest:Hash,assessments:z.array(AssessmentSchema).max(EVALUATION_MAX_PAIRS)});
export type EvaluationPrediction=z.infer<typeof EvaluationPredictionSchema>;
export const EvaluationPredictionsSchema=z.array(EvaluationPredictionSchema).max(1024);
export const EvaluationFractionSchema=z.strictObject({numerator:Integer,denominator:Integer.min(1)});
export type EvaluationFraction=z.infer<typeof EvaluationFractionSchema>;
const Counts=z.strictObject({labelled:Integer,predicted:Integer,missing:Integer,uncertain:Integer,tp:Integer,fp:Integer,fn:Integer,tn:Integer,uncertainPositive:Integer,uncertainNegative:Integer,missingPositive:Integer,missingNegative:Integer});
export const EvaluationMetricsSchema=Counts.extend({unresolvedNegative:Integer,coverageComplete:z.boolean(),confirmedRecall:EvaluationFractionSchema.nullable(),triageRecall:EvaluationFractionSchema.nullable(),precision:EvaluationFractionSchema.nullable(),coverage:EvaluationFractionSchema});
export type EvaluationMetrics=z.infer<typeof EvaluationMetricsSchema>;
export const EvaluationReportSchema=z.strictObject({version:z.literal(1),kind:z.literal('metrics_only'),productionRecallVerified:z.literal(false),dataset:EvaluationDatasetSchema.omit({version:true,cases:true}),datasetDigest:Hash,predictionsDigest:Hash,total:EvaluationMetricsSchema,cases:z.array(EvaluationMetricsSchema.extend({caseId:Id,sourceDigest:Hash,policyDigest:Hash})).min(1).max(1024),categories:z.array(EvaluationMetricsSchema.extend({policyDigest:Hash,categoryId:Id})).min(1).max(32768)});
export type EvaluationReport=z.infer<typeof EvaluationReportSchema>;
type Counters=z.infer<typeof Counts>;
const pair=(first:string,second:string)=>JSON.stringify([first,second]);
const empty=():Counters=>({labelled:0,predicted:0,missing:0,uncertain:0,tp:0,fp:0,fn:0,tn:0,uncertainPositive:0,uncertainNegative:0,missingPositive:0,missingNegative:0});
function invalid(path:string):never{throw new ComplianceError('INVALID_REFERENCE','evaluation binding',path);}
function rate(numerator:number,denominator:number):EvaluationFraction|null{return denominator===0?null:{numerator,denominator};}
function metrics(counts:Counters):EvaluationMetrics{
  const positives=counts.tp+counts.fn;
  // Unknown negatives are not credited as TN; labelled = TP + FP + FN + TN + unresolvedNegative.
  return {...counts,unresolvedNegative:counts.missingNegative+counts.uncertainNegative,coverageComplete:counts.missing===0,confirmedRecall:rate(counts.tp,positives),triageRecall:rate(counts.tp+counts.uncertainPositive,positives),precision:rate(counts.tp,counts.tp+counts.fp),coverage:{numerator:counts.predicted,denominator:counts.labelled}};
}
function evidence(row:Assessment,path:string):void{
  // No source body is present: exact quotations and currentness must be established by the upstream classification validator.
  if(row.verdict==='not_flagged'){if(row.start!==0||row.end!==0||row.quote!==null)invalid(path);}
  else if(row.quote===null||row.start>=row.end||row.end-row.start!==row.quote.length)invalid(path);
}
function observe(counts:Counters,flagged:boolean,prediction:Assessment|undefined):void{
  counts.labelled++;
  if(!prediction){counts.missing++;if(flagged){counts.fn++;counts.missingPositive++;}else counts.missingNegative++;return;}
  counts.predicted++;
  if(prediction.verdict==='flag'){if(flagged)counts.tp++;else counts.fp++;}
  else if(prediction.verdict==='uncertain'){counts.uncertain++;if(flagged){counts.fn++;counts.uncertainPositive++;}else counts.uncertainNegative++;}
  else if(flagged)counts.fn++;else counts.tn++;
}
/** Mathematical metrics only: supplied provenance tags cannot establish human signoff, production recall or legal clearance. */
export function evaluatePrecheck(datasetInput:unknown,predictionsInput:unknown):EvaluationReport{
  const dataset=capture(EvaluationDatasetSchema,datasetInput,'evaluation dataset',EVALUATION_DATASET_BYTES),predictions=capture(EvaluationPredictionsSchema,predictionsInput,'evaluation predictions',EVALUATION_PREDICTION_BYTES),cases=new Map<string,{row:z.infer<typeof EvaluationCase>;labels:Map<string,z.infer<typeof Label>>}>();let labelled=0;
  for(const [index,row]of dataset.cases.entries()){
    if(cases.has(row.id))invalid(`cases.${index}.id`);const labels=new Map<string,z.infer<typeof Label>>(),categories=new Set<string>();
    for(const [position,label]of row.labels.entries()){const key=pair(label.segmentId,label.categoryId);if(labels.has(key))invalid(`cases.${index}.labels.${position}`);labels.set(key,label);categories.add(label.categoryId);}
    if(categories.size>32)throw new ComplianceError('INPUT_LIMIT','evaluation case categories',`cases.${index}.labels`);
    labelled+=row.labels.length;if(labelled>EVALUATION_MAX_PAIRS)throw new ComplianceError('INPUT_LIMIT','evaluation dataset','labels');cases.set(row.id,{row,labels});
  }
  const predicted=new Map<string,Map<string,Assessment>>();
  for(const [index,prediction]of predictions.entries()){
    const actual=cases.get(prediction.caseId);if(!actual||predicted.has(prediction.caseId))invalid(`predictions.${index}.caseId`);
    if(actual.row.sourceDigest!==prediction.sourceDigest||actual.row.policyDigest!==prediction.policyDigest)throw new ComplianceError('CONFLICT','evaluation source or policy',`predictions.${index}`);
    const rows=new Map<string,Assessment>();for(const [position,row]of prediction.assessments.entries()){const key=pair(row.segmentId,row.categoryId);if(!actual.labels.has(key)||rows.has(key))invalid(`predictions.${index}.assessments.${position}`);evidence(row,`predictions.${index}.assessments.${position}`);rows.set(key,row);}
    // Unique case/pair membership bounds valid predictions by the already bounded label set.
    predicted.set(prediction.caseId,rows);
  }
  const total=empty(),categoryCounts=new Map<string,{policyDigest:string;categoryId:string;counts:Counters}>();
  const caseMetrics=dataset.cases.map(row=>{const counts=empty(),rows=predicted.get(row.id);for(const label of row.labels){const key=pair(row.policyDigest,label.categoryId);let category=categoryCounts.get(key);if(!category){category={policyDigest:row.policyDigest,categoryId:label.categoryId,counts:empty()};categoryCounts.set(key,category);}const prediction=rows?.get(pair(label.segmentId,label.categoryId));observe(total,label.flagged,prediction);observe(counts,label.flagged,prediction);observe(category.counts,label.flagged,prediction);}return {caseId:row.id,sourceDigest:row.sourceDigest,policyDigest:row.policyDigest,...metrics(counts)};});
  const normalizedPredictions=dataset.cases.flatMap(row=>{const rows=predicted.get(row.id);return rows?[{caseId:row.id,sourceDigest:row.sourceDigest,policyDigest:row.policyDigest,assessments:row.labels.flatMap(label=>{const prediction=rows.get(pair(label.segmentId,label.categoryId));return prediction?[prediction]:[];})}]:[];});
  const {version:_version,cases:_cases,...identity}=dataset,report={version:1 as const,kind:'metrics_only' as const,productionRecallVerified:false as const,dataset:identity,datasetDigest:hash(dataset,EVALUATION_DATASET_BYTES),predictionsDigest:hash(normalizedPredictions,EVALUATION_PREDICTION_BYTES),total:metrics(total),cases:caseMetrics,categories:[...categoryCounts.values()].map(row=>({policyDigest:row.policyDigest,categoryId:row.categoryId,...metrics(row.counts)}))};
  return freeze(capture(EvaluationReportSchema,report,'evaluation report',EVALUATION_REPORT_BYTES));
}
