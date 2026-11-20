import {z} from 'zod';
import {digest,MethodError} from '@camery/methods';
import {captureQuality,createQualityFinding,freezeQuality} from './boundary.js';
import {validateQualityPolicy} from './catalog.js';
import {QUALITY_MATERIAL_BYTES,QualityError,QualityPhaseSchema,QualityScopeSchema} from './contracts.js';
import type {QualityFinding,QualityPhase} from './contracts.js';
import {QUALITY_REVIEW_INPUT_BYTES,QUALITY_REVIEW_OUTPUT_BYTES,QUALITY_REVIEW_PAIRS,QualityModelOutputSchema,QualityReviewBatchSchema,QualityReviewTopicSchema} from './model-contracts.js';
import type {QualityModelAssessment,QualityModelOutput,QualityReviewTopic,QualityReviewUnit} from './model-contracts.js';

type Json=QualityReviewUnit['content'];
type TopicBody=Omit<QualityReviewTopic,'phase'>;
const capturedRoots=new WeakSet<object>();
/** Reuse only this factory's immutable snapshots; the private cache is an integrity optimization, never source authority. */
export function captureQualityLogicalRoot(input:unknown):Json{
  const root=freezeQuality(captureQuality(z.json(),input,'model review logical root',QUALITY_MATERIAL_BYTES));
  if(root!==null&&typeof root==='object')capturedRoots.add(root);
  return root;
}
function logicalRoot(input:unknown):Json{
  return input!==null&&typeof input==='object'&&capturedRoots.has(input)?input as Json:captureQuality(z.json(),input,'model review logical root',QUALITY_MATERIAL_BYTES);
}
/** Original prompts request textual review; they establish no measured timing, model capacity or media quality. */
const coherence:TopicBody={id:'story-coherence',label:'故事因果与目标完整性',severity:'major',recognition:'核对人物目标、行动条件与可观察结果是否相接，转折是否由已提供的事实推动；资料没有交代的部分应标为待核对，不能自行补写成事实。',remedy:'定位断开的具体行动与后果，提出能由原稿支持的补充条件，并回查修改是否改变前后承诺。'};
const continuity:TopicBody[]=[
  {id:'continuity-cause-order',label:'事件顺序与因果承接',severity:'major',recognition:'对照已提供的时间、地点和事件顺序，核对后果是否发生在原因之后，跨场移动是否保留必要条件。',remedy:'列明发生冲突的原文位置，核对顺序或补足转换条件，并追查受影响的后续事件。'},
  {id:'continuity-knowledge-source',label:'知情与传播来源',severity:'major',recognition:'核对人物使用信息前是否已有可见获知渠道，秘密传播是否具备提供者、接收者与发生时点。',remedy:'标出缺少来源的信息使用位置，补出可观察的传播行为或调整知情时间。'},
  {id:'continuity-state-carryover',label:'人物与物件状态延续',severity:'major',recognition:'跟踪人物处境、关系、伤势、持有物和资源变化，核对上一场结果是否进入下一次行动条件。',remedy:'用原文核对状态变化的依据，修正不相容状态并检查后续依赖。'},
  {id:'continuity-thread-evidence',label:'承诺与线索的依据',severity:'major',recognition:'核对前文建立的问题、线索和承诺在本段被提起或兑现时是否仍指向原有事实，避免凭空补出关键依据。',remedy:'指出承诺与回应的具体位置，补足已有材料支持的连接，并保留尚未提供证据的未知项。'},
  {id:'continuity-voice-perspective',label:'视角与表达边界',severity:'minor',recognition:'核对叙述和人物表达是否越过已提供的观察、经验及身份边界；语言变化应有材料中的情境依据。',remedy:'引用发生变化的位置，核对表达者能够知道和观察的内容，必要时调整视角或补出情境。'},
  {id:'continuity-coverage',label:'局部材料的判断边界',severity:'major',recognition:'区分本批可见材料支持的结论与依赖未提供前后文的推断，不能把材料缺失当作已经证实的矛盾。',remedy:'在证据不足时说明需补核的事实及其可见位置，不代替未知前文生成证明。'},
];
const production:TopicBody[]=[
  {id:'production-visible-action',label:'动作与声音的可表达性',severity:'major',recognition:'核对重要信息能否由文本明确的动作、画面或声音承载，区分作者解释与现场能够表达的行为。',remedy:'标出需要落实的信息，提出具体动作或声音表达建议，并保留必要的主观叙述标记。'},
  {id:'production-space-cast',label:'空间与出场条件',severity:'major',recognition:'核对文本中人物出入、位置和互动所需的空间条件是否清楚，同场行动是否存在互相冲突的站位或出场安排。',remedy:'定位互相影响的行动，补明必要的出入与位置变化，再核对相邻场连接。'},
  {id:'production-asset-state',label:'道具与场景状态需求',severity:'major',recognition:'核对关键动作依赖的道具、服装和环境状态是否在文本中可识别，前次消耗或改变是否影响本次使用。',remedy:'把具体需求与原文行动对应，修正缺少依据的状态恢复，并注明需要人工确认的制作条件。'},
  {id:'production-timing-estimate',label:'节拍与时长假设',severity:'minor',recognition:'核对行动、对白与停顿的节拍安排；文字只能提示时长风险，不能宣称已测得表演、生成或成片用时。',remedy:'标出需试读或排演确认的段落，建议节拍调整，并将实际时长留待后续测量。'},
  {id:'production-capability-uncertainty',label:'制作能力与验证缺口',severity:'major',recognition:'核对文本是否依赖尚未验证的表演、视效、场景或生成能力；仅凭文本不能证明媒体质量或制作可行性。',remedy:'指出具体依赖及其原文依据，列出需人工或实际制作验证的条件，保留未验证状态。'},
];
export function createQualityReviewTopics(policyInput:unknown,phaseInput:unknown):QualityReviewTopic[]{
  const policy=validateQualityPolicy(policyInput),phase=captureQuality(QualityPhaseSchema,phaseInput,'review phase',256);
  const bodies=phase==='story'?[...policy.antipatterns.filter(row=>row.enabled).map(({id,label,recognition,remedy,severity})=>({id,label,recognition,remedy,severity})),coherence]:phase==='continuity'?continuity:production;
  return freezeQuality(bodies.map(row=>({...row,phase})));
}
function invalid(path:string):never{throw new QualityError('INVALID_REFERENCE','model review binding',path);}
function equalJson(left:Json,right:Json):boolean{
  if(left===right)return true;
  if(left===null||right===null||typeof left!=='object'||typeof right!=='object'||Array.isArray(left)!==Array.isArray(right))return false;
  if(Array.isArray(left)&&Array.isArray(right))return left.length===right.length&&left.every((value,index)=>equalJson(value,right[index]!));
  const a=left as Record<string,Json>,b=right as Record<string,Json>,keys=Object.keys(a);
  return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&equalJson(a[key]!,b[key]!));
}
function pointerParts(path:string):string[]{
  if(path!==''&&(!path.startsWith('/')||/~(?![01])/u.test(path)))invalid('evidence.path');
  return path===''?[]:path.slice(1).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~'));
}
function at(root:Json,path:string):Json{
  let value=root;
  for(const part of pointerParts(path)){
    if(value===null||typeof value!=='object'||!Object.hasOwn(value,part)||(Array.isArray(value)&&!/^(0|[1-9]\d*)$/.test(part)))invalid('material.path');
    value=(value as Record<string,Json>)[part]!;
  }
  return value;
}
function within(path:string,parent:string):boolean{return parent===''||path===parent||path.startsWith(parent+'/');}
function wholeBoundary(text:string,offset:number):boolean{
  return offset===0||offset===text.length||!(text.charCodeAt(offset-1)>=0xd800&&text.charCodeAt(offset-1)<=0xdbff&&text.charCodeAt(offset)>=0xdc00&&text.charCodeAt(offset)<=0xdfff);
}
function unitDigest(unit:QualityReviewUnit):string{
  try{return digest({kind:unit.kind,path:unit.path,start:unit.start,end:unit.end,content:unit.content});}
  catch(error){let limit=false;try{limit=error instanceof MethodError&&error.code==='DATA_LIMIT';}catch{/* Opaque exceptions do not supply public diagnostics. */}throw new QualityError(limit?'INPUT_LIMIT':'INVALID_INPUT','model review unit digest','units');}
}
function overlaps(a:QualityReviewUnit,b:QualityReviewUnit):boolean{
  if(a.kind==='string_slice'&&b.kind==='string_slice')return a.path===b.path&&a.start!<b.end!&&b.start!<a.end!;
  return within(a.path,b.path)||within(b.path,a.path);
}
function validateUnits(root:Json,units:QualityReviewUnit[]):void{
  const ids=new Set<string>();
  for(const [index,unit] of units.entries()){
    if(ids.has(unit.id))invalid('units.id');ids.add(unit.id);
    const actual=at(root,unit.path);
    if(unit.kind==='string_slice'){
      if(typeof actual!=='string'||unit.start===null||unit.end===null||unit.start>=unit.end||unit.end>actual.length||!wholeBoundary(actual,unit.start)||!wholeBoundary(actual,unit.end)||actual.slice(unit.start,unit.end)!==unit.content)invalid('units.slice');
    }else if(unit.start!==null||unit.end!==null||(unit.kind==='document'?unit.path!=='':unit.path==='')||!equalJson(actual,unit.content))invalid('units.content');
    if(unit.digest!==unitDigest(unit))invalid('units.digest');
    if(units.slice(0,index).some(other=>overlaps(unit,other)))invalid('units.overlap');
  }
}
function validateAssessment(root:Json,unit:QualityReviewUnit,commonPaths:string[],row:QualityModelAssessment):void{
  if(row.verdict==='clear'){
    if(row.severity!==null||row.problem!==null||row.audienceImpact!==null||row.suggestion!==null||row.ripple.length||row.evidence.length)invalid('assessments.clear');
    return;
  }
  if(row.severity===null||row.problem===null||row.audienceImpact===null||row.suggestion===null||!row.ripple.length||!row.evidence.length)invalid('assessments.issue');
  for(const evidence of row.evidence){
    const actual=at(root,evidence.path),common=commonPaths.some(path=>within(evidence.path,path));
    const visible=common||(unit.kind==='string_slice'?evidence.path===unit.path:within(evidence.path,unit.path));
    if(!visible)invalid('assessments.evidence.visibility');
    if(evidence.quote===null){if(row.verdict!=='uncertain'||evidence.start!==0||evidence.end!==0)invalid('assessments.evidence.sentinel');continue;}
    if(typeof actual!=='string'||evidence.start>=evidence.end||evidence.end>actual.length||!wholeBoundary(actual,evidence.start)||!wholeBoundary(actual,evidence.end)||actual.slice(evidence.start,evidence.end)!==evidence.quote)invalid('assessments.evidence.quote');
    if(!common&&unit.kind==='string_slice'&&(evidence.start<unit.start!||evidence.end>unit.end!))invalid('assessments.evidence.slice');
  }
}
function prepare(scopeInput:unknown,topicsInput:unknown,batchInput:unknown,rootInput:unknown,outputInput:unknown){
  const scope=captureQuality(QualityScopeSchema,scopeInput,'model review scope',2048),topics=captureQuality(z.array(QualityReviewTopicSchema).min(1).max(QUALITY_REVIEW_PAIRS),topicsInput,'model review topics',QUALITY_REVIEW_INPUT_BYTES),batch=captureQuality(QualityReviewBatchSchema,batchInput,'model review batch',QUALITY_REVIEW_INPUT_BYTES),root=logicalRoot(rootInput),output=captureQuality(QualityModelOutputSchema,outputInput,'model review output',QUALITY_REVIEW_OUTPUT_BYTES);
  if(new Set(topics.map(topic=>topic.id)).size!==topics.length||topics.some(topic=>topic.phase!==batch.phase))invalid('topics');
  if(topics.length*batch.units.length>QUALITY_REVIEW_PAIRS)throw new QualityError('INPUT_LIMIT','model review matrix','assessments');
  validateUnits(root,batch.units);
  const commonPaths=batch.common.map(row=>row.path);
  if(new Set(commonPaths).size!==commonPaths.length)invalid('common.path');
  for(const common of batch.common)if(!equalJson(at(root,common.path),common.content))invalid('common.content');
  const matrix=new Map<string,Map<string,QualityModelAssessment>>(batch.units.map(unit=>[unit.id,new Map()])),topicIds=new Set(topics.map(topic=>topic.id));
  for(const row of output.assessments){
    const entries=matrix.get(row.unitId);if(!entries||!topicIds.has(row.topicId)||entries.has(row.topicId))invalid('assessments.pair');entries.set(row.topicId,row);
  }
  const normalized:QualityModelOutput={version:1,assessments:[]};
  for(const unit of batch.units)for(const topic of topics){
    const row=matrix.get(unit.id)!.get(topic.id);if(!row)throw new QualityError('INCOMPLETE','model review matrix','assessments');
    validateAssessment(root,unit,commonPaths,row);normalized.assessments.push(row);
  }
  return {scope,topics,batch,output:freezeQuality(normalized)};
}
/** This is captured-data integrity only; the Node source reader must independently establish current-source authority. */
export function validateQualityModelOutput(scope:unknown,topics:unknown,batch:unknown,logicalRoot:unknown,output:unknown):QualityModelOutput{
  return prepare(scope,topics,batch,logicalRoot,output).output;
}
export function qualityModelFindings(scopeInput:unknown,topicsInput:unknown,batchInput:unknown,logicalRoot:unknown,outputInput:unknown):QualityFinding[]{
  const {scope,topics,batch,output}=prepare(scopeInput,topicsInput,batchInput,logicalRoot,outputInput),topicById=new Map(topics.map(topic=>[topic.id,topic])),findings:QualityFinding[]=[];
  for(const row of output.assessments){
    if(row.verdict==='clear')continue;
    const phase:QualityPhase=batch.phase,topic=topicById.get(row.topicId)!;
    findings.push(createQualityFinding(scope,{code:'model-'+digest({phase,unitId:row.unitId,topicId:row.topicId}),origin:'model',phase,waivable:true,path:row.evidence[0]!.path,severity:row.severity,problem:topic.label+'：'+row.problem,audienceImpact:row.audienceImpact,suggestion:row.suggestion,ripple:row.ripple,evidence:row.evidence.map(entry=>entry.quote===null?{...entry,start:null,end:null}:entry)}));
  }
  return freezeQuality(findings);
}
