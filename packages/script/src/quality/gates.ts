import {OutlineError} from '../outline/contracts.js';
import {reviewOutlineCraft} from '../outline/outline.js';
import {ScreenplayError} from '../screenplay/contracts.js';
import type {ScreenplayContinuityPreview,ScreenplayIssue} from '../screenplay/contracts.js';
import {checkScreenplay} from '../screenplay/validate.js';
import {projectScreenplayContinuity} from '../screenplay/context.js';
import {screenplayTimingIssues} from '../screenplay/timing.js';
import {ContinuityError} from '../continuity/contracts.js';
import {captureQuality,createQualityFinding,freezeQuality} from './boundary.js';
import {validateQualityPolicy} from './catalog.js';
import {QualityError,QualityScopeSchema,QualitySubjectSchema,QualityGateReportSchema,QUALITY_MATERIAL_BYTES,QUALITY_REPORT_BYTES} from './contracts.js';
import type {QualityFinding,QualityGateReport,QualityPhase,QualitySubject} from './contracts.js';

const encoder=new TextEncoder();
const bytes=(value:unknown)=>encoder.encode(JSON.stringify(value)).byteLength;
function pointer(path:string):string{return '/'+path.split('.').map(part=>part.replaceAll('~','~0').replaceAll('/','~1')).join('/');}
function valueAt(subject:QualitySubject,path:string):{exists:boolean;value:unknown}{
  let value:unknown=subject;for(const part of path.slice(1).split('/')){const key=part.replaceAll('~1','/').replaceAll('~0','~');if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))return {exists:false,value:undefined};value=(value as Record<string,unknown>)[key];}return {exists:true,value};
}
function evidence(subject:QualitySubject,path:string){const {exists,value}=valueAt(subject,path);if(!exists)throw new QualityError('INVALID_REFERENCE','quality issue location',path);return typeof value==='string'&&value.length<=8000&&value.trim().length>0?{path,start:0,end:value.length,quote:value}:{path,start:null,end:null,quote:null};}
function threadPath(subject:Extract<QualitySubject,{kind:'screenplay'}>,thread:NonNullable<ScreenplayContinuityPreview['ledger']>['threads'][number]):string{
  if(thread.planted.episodeId===subject.draft.episodeId){const index=subject.draft.continuity.findIndex(event=>event.op==='plant'&&event.threadId===thread.id&&event.id===thread.planted.eventId);if(index>=0)return '/draft/continuity/'+index;}
  const index=subject.context.previous?.ledger.threads.findIndex(row=>row.id===thread.id)??-1;if(index>=0)return '/context/previous/ledger/threads/'+index;
  throw new QualityError('INVALID_REFERENCE','quality thread origin','continuity');
}
function scriptPath(subject:Extract<QualitySubject,{kind:'screenplay'}>,path:string,projection:ScreenplayContinuityPreview):string{
  if(path.startsWith('/rules/')||path==='/rules'||path.startsWith('/episode/')||path.startsWith('/outline/'))return '/context'+path;
  const event=/^\/continuity\/events\.(\d+)(?:\.(.*))?$/.exec(path);if(event){const candidate='/draft/continuity/'+event[1]+(event[2]?pointer(event[2]):'');return valueAt(subject,candidate).exists?candidate:'/draft/continuity/'+event[1];}
  const thread=/^\/continuity\/ledger\.threads\.(\d+)(?:\..*)?$/.exec(path);if(thread){const row=projection.ledger?.threads[Number(thread[1])];if(row)return threadPath(subject,row);}
  const candidate='/draft'+path;if(valueAt(subject,candidate).exists)return candidate;
  // The legacy reducer reports derived paths; use their actual declaration container rather than inventing a draft ledger.
  if(path==='/continuity'||path.startsWith('/continuity/'))return '/draft/continuity';
  throw new QualityError('INVALID_REFERENCE','quality screenplay location',path);
}
function phaseFor(issue:ScreenplayIssue):QualityPhase{
  if(['ACTION_TIMING','TIMING_BUDGET','NO_SPOKEN_UNITS','PLANNED_RANGE','VOICE_SEMANTICS'].includes(issue.code))return 'production';
  if(['DUPLICATE_ID','UNKNOWN_CHARACTER','SCENE_SPEAKER','UNKNOWN_LOCATION','UNKNOWN_OUTLINE_BEAT','OUTLINE_COVERAGE','UNKNOWN_SOURCE','SOURCE_QUOTE','ORIGIN_REQUIRED','CONTINUITY_REFERENCE','CONTINUITY_RULE','CONTINUITY_REVIEW'].includes(issue.code))return 'continuity';
  return 'story';
}
function timingFor(subject:Extract<QualitySubject,{kind:'screenplay'}>,issues:readonly ScreenplayIssue[]):readonly ScreenplayIssue[]{
  try{return screenplayTimingIssues(subject.context,subject.draft);}catch(error){
    // Keep the checker's already located hard error; an invalid voice/reference has no valid duration estimate to attach.
    let rejected=false;try{rejected=error instanceof ScreenplayError&&error.code==='INVALID_REFERENCE'&&issues.some(row=>row.severity==='error'&&row.path===error.path);}catch{/* Preserve unknown errors for the public safe boundary. */}
    if(rejected)return [];throw error;
  }
}
function failure(error:unknown):never{
  let known:QualityError|undefined,code:QualityError['code']='INVALID_INPUT',path='$';try{
    if(error instanceof QualityError)known=error;
    else if(error instanceof OutlineError||error instanceof ScreenplayError||error instanceof ContinuityError){if(['INVALID_INPUT','INPUT_LIMIT','INVALID_REFERENCE','INCOMPLETE','CONFLICT','FORBIDDEN','NOT_FOUND','STORAGE_FAILED'].includes(error.code))code=error.code as QualityError['code'];else code='INVALID_REFERENCE';path=error.path;}
  }catch{/* Untrusted dependency prototypes cannot supply diagnostics. */}
  if(known)throw known;throw new QualityError(code,'deterministic quality checks',path);
}
/** Free, reproducible text checks only. Source authority and human waiver decisions are separate host responsibilities. */
export function checkQualityGates(scopeInput:unknown,subjectInput:unknown,policyInput:unknown):QualityGateReport{
  const scope=captureQuality(QualityScopeSchema,scopeInput,'quality gate scope',2048),subject=captureQuality(QualitySubjectSchema,subjectInput,'quality gate subject',QUALITY_MATERIAL_BYTES),policy=validateQualityPolicy(policyInput);
  const base={version:1 as const,kind:'deterministic_quality' as const,scope,policy:{id:policy.id,revision:policy.revision},findings:[] as QualityFinding[],verdict:'needs_review' as const,evidenceScope:'text' as const,mediaQualityVerified:false as const},findings=new Map<string,QualityFinding>();let spent=bytes(base);
  function add(detail:Parameters<typeof createQualityFinding>[1]){const finding=createQualityFinding(scope,detail);if(findings.has(finding.id))return;spent+=bytes(finding)+(findings.size?1:0);if(findings.size>=65536||spent>QUALITY_REPORT_BYTES)throw new QualityError('INPUT_LIMIT','complete quality gate report','findings');findings.set(finding.id,finding);}
  try{
    const outline=subject.kind==='outline'?subject:subject.outline,prefix=subject.kind==='outline'?'/output':'/outline/output',craft=reviewOutlineCraft(outline.context,outline.output,policy.thresholds);
    for(const issue of craft.issues){const path=prefix+pointer(issue.path);add({code:'outline.'+issue.code.toLowerCase(),origin:'configured',phase:'story',waivable:true,path,severity:'major',problem:issue.detail,audienceImpact:'卡点、情绪或辅轴的安排可能影响观众对冲突进展和后续期待的理解。',suggestion:'按本项目配置逐项核对涉及分集，修改或由人类记录明确的保留理由。',ripple:['复核相关分集的钩子、情节单元、节拍与后续剧本。'],evidence:[evidence(subject,path)]});}
    if(subject.kind==='screenplay'){
      const number=subject.context.episode.number,native=subject.context.nativeContext.episodes.find(row=>row.id===subject.context.episode.id),episode=outline.output.episodes.find(row=>row.number===number);
      if(!episode||!native||native.number!==number||subject.draft.episodeId!==subject.context.episode.id)throw new QualityError('CONFLICT','quality episode binding','/context/episode');
      const checked=checkScreenplay(subject.context,subject.draft),timing=timingFor(subject,checked.issues),projection=projectScreenplayContinuity(subject.context,subject.draft);
      for(const issue of [...checked.issues,...timing]){const path=scriptPath(subject,issue.path,projection),rule=issue.code==='CONTINUITY_RULE'&&issue.collateralImpact.length===1?'.'+issue.collateralImpact[0]!.toLowerCase():'',hard=issue.severity==='error';add({code:'screenplay.'+issue.code.toLowerCase()+rule,origin:'structural',phase:phaseFor(issue),waivable:!hard,path,severity:hard?'critical':'major',problem:issue.detail,audienceImpact:issue.audienceImpact,suggestion:issue.remedy,ripple:[...issue.collateralImpact,'修订后重新核对所涉节拍、声音引用、时长和后续四账。'],evidence:[evidence(subject,path)]});}
      if(number===outline.context.episodeCount&&projection.ledger)for(const thread of projection.ledger.threads)if(thread.paidOff===null){const path=threadPath(subject,thread);add({code:'continuity.unresolved_season_thread',origin:'structural',phase:'continuity',waivable:true,path,severity:'major',problem:'完整分集方案已到末集，伏笔“'+thread.summary+'”仍无已声明回收。',audienceImpact:'观众可能无法得到此前线索的解释或情绪回报；声明不完整也需要场记人工确认。',suggestion:'核对真实正文，补充回收声明或记录明确的人类保留理由，不凭模型自报回收。',ripple:['核对埋设集、相关事实与角色知情，以及季终选择和续作交接。'],evidence:[evidence(subject,path+'/summary'),evidence(subject,path+'/payoffEpisodeId')]});}
    }
    const result=[...findings.values()],verdict=result.some(row=>!row.waivable)?'blocked':result.length?'needs_review':'clear';return freezeQuality(captureQuality(QualityGateReportSchema,{...base,findings:result,verdict},'complete quality gate report',QUALITY_REPORT_BYTES));
  }catch(error){return failure(error);}
}
