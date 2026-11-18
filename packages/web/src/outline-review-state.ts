import {z} from 'zod';
import {AblationAssessmentSchema,OUTLINE_BYTES,OutlineError,reviewOutlineCraft,validateOutline} from '@camery/script/outline';
import type {OutlineCraftReport,OutlineIssue,OutlineOutput} from '@camery/script/outline';
import {boundedOutlineSchema,OutlineConfirmSchema} from '@camery/script/outline/http';
import type {OutlineConfirm,OutlineRunView} from '@camery/script/outline/http';

export type OutlineDraftInspection={readonly valid:true;readonly issues:readonly string[];readonly bytes:number;readonly limit:number;readonly output:OutlineOutput;readonly report:OutlineCraftReport}|
  {readonly valid:false;readonly issues:readonly string[];readonly bytes:number;readonly limit:number;readonly output?:undefined;readonly report?:undefined};
/** Recheck edits against frozen run context; a structural pass never constitutes human approval. */
export function inspectOutlineDraft(view:OutlineRunView,input:unknown):OutlineDraftInspection{
  const brief=view.brief;const context={episodeCount:brief.episodeCount,targetSeconds:brief.targetSeconds,paidEpisodeNumbers:brief.paidEpisodeNumbers,
    mainGenre:brief.mainGenre,auxiliaryGenres:brief.auxiliaryGenres,sourceRefIds:view.source.references.map(reference=>reference.id)};
  try{
    const output=validateOutline(context,input);const report=reviewOutlineCraft(context,output,brief.thresholds);
    return {valid:true,issues:[],bytes:new TextEncoder().encode(JSON.stringify(output)).length,limit:OUTLINE_BYTES,output,report};
  }catch(error){
    const issue=error instanceof OutlineError?error.code==='INPUT_LIMIT'?'完整五件套超过 512 KiB，请精简后再确认。':
      error.code==='INVALID_REFERENCE'?`引用或条目顺序不正确，请检查 ${error.path}。`:
      error.code==='INCOMPLETE'?`集数、条目或主角参与尚不完整，请检查 ${error.path}。`:
      `请补齐必填字段，并检查字段长度与条目数量（${error.path}）。`:'无法检查五件套字段，请重新载入记录后重试。';
    return {valid:false,issues:[issue],bytes:0,limit:OUTLINE_BYTES};
  }
}
const Assessments=boundedOutlineSchema(z.array(AblationAssessmentSchema).max(2));
/** A participating auxiliary axis resolves its ablation proposal; label-only participation needs an explicit exception. */
export function outlineRequiredIssues(report:OutlineCraftReport,output:OutlineOutput,ablations:unknown):readonly OutlineIssue[]|null{
  const result=Assessments.safeParse(ablations);if(!result.success)return null;
  const byGenre=new Map(result.data.map(item=>[item.genre,item]));const auxiliary=output.recipe.auxiliaryGenres;
  if(byGenre.size!==result.data.length||byGenre.size!==auxiliary.length||result.data.some(item=>!auxiliary.includes(item.genre)))return null;
  const required:OutlineIssue[]=[];
  for(const issue of report.issues){
    if(issue.code!=='ABLATION_REVIEW'){required.push(issue);continue;}
    const ablation=output.recipe.ablations[Number(issue.path.split('.').at(-1))];
    const assessment=ablation&&byGenre.get(ablation.genre);if(!assessment)return null;
    if(assessment.judgment==='label_only')required.push(issue);
  }
  return required;
}
/** Produce only the user's exact, fully located decision; authority and freshness are checked again by the server. */
export function outlineDecision(view:OutlineRunView,input:unknown,ablations:unknown,waivers:unknown):OutlineConfirm|null{
  if(view.sourceChanged||view.review!==null||view.reviewStatus!==null||view.state==='stale'||!view.candidate||view.candidateDigest!==view.candidate.digest)return null;
  const inspection=inspectOutlineDraft(view,input);if(!inspection.valid)return null;
  const parsed=OutlineConfirmSchema.safeParse({candidateDigest:view.candidate.digest,output:inspection.output,ablations,waivers});if(!parsed.success)return null;
  const required=outlineRequiredIssues(inspection.report,inspection.output,parsed.data.ablations);if(required===null)return null;
  const expected=new Set(required.map(issue=>issue.id)),actual=new Set(parsed.data.waivers.map(waiver=>waiver.issueId));
  if(actual.size!==parsed.data.waivers.length||actual.size!==expected.size||parsed.data.waivers.some(waiver=>!expected.has(waiver.issueId)))return null;
  return parsed.data;
}
