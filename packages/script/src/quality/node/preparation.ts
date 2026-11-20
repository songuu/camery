import {z} from 'zod';
import {Id,Hash,Integer} from '../../contracts.js';
import {QualityScopeSchema,QualityGateReportSchema,QualityCatalogReportSchema,QualityFindingSchema,QualityError,QUALITY_REPORT_BYTES} from '../contracts.js';
import {captureQuality,createQualityFinding,freezeQuality} from '../boundary.js';
import {validateQualityPolicy,checkQualityCatalog} from '../catalog.js';
import {checkQualityGates} from '../gates.js';
import {projectQualityCatalogInput} from '../projection.js';
import {validateQualitySource} from './source.js';
import {qualityDigest,equalQualityData} from './data.js';

export const QualityPreparationSchema=z.strictObject({version:z.literal(1),scope:QualityScopeSchema,policyDigest:Hash,gates:QualityGateReportSchema,catalog:QualityCatalogReportSchema,unknownRoles:z.array(QualityFindingSchema).max(16384),summary:z.strictObject({digest:Hash,nonWaivable:Integer.max(65536),waivable:Integer.max(65536)}),digest:Hash});
export type QualityPreparation=z.infer<typeof QualityPreparationSchema>;
/** All free checks finish before a model request is eligible; this does not prove repository authority. */
export function prepareQualityChecks(taskIdInput:unknown,sourceInput:unknown,policyInput:unknown):QualityPreparation{
  const taskId=captureQuality(Id,taskIdInput,'quality task',256),source=validateQualitySource(sourceInput),policy=validateQualityPolicy(policyInput),scope={...source.scope,taskId,objectId:source.objectId,sourceDigest:source.digest};
  const gates=checkQualityGates(scope,source.subject,policy),catalog=checkQualityCatalog(projectQualityCatalogInput(scope,source.subject,source.subject.kind==='screenplay'?source.names:undefined),policy);
  const unknownRoles=source.unknownPrincipalIds.map(id=>{
    if(source.subject.kind!=='screenplay')throw new QualityError('CONFLICT','quality principal role','subject');
    const index=source.subject.context.characters.findIndex(row=>row.id===id),character=source.subject.context.characters[index];if(!character)throw new QualityError('INVALID_REFERENCE','quality principal role','characters');
    const path='/context/characters/'+index+'/name';return createQualityFinding(scope,{code:'naming.principal-role-unknown',origin:'configured',phase:'story',waivable:true,path,severity:'major',problem:'人物“'+character.name+'”的主要人物职责尚未在实际来源中确认。',audienceImpact:'无法完整核对主要人物重姓，可能增加观众识别人物的负担。',suggestion:'由人类在实际人物来源中确认主角、对手或配角职责，或逐项记录本次保留理由。',ripple:['确认职责后重新核对本集参与者、起名冲突和后续角色引用。'],evidence:[{path,start:0,end:character.name.length,quote:character.name}]});
  });
  const findings=[...gates.findings,...catalog.findings,...unknownRoles];if(findings.length>65536||new Set(findings.map(row=>row.id)).size!==findings.length)throw new QualityError('INPUT_LIMIT','complete free quality findings','findings');
  const summary={digest:qualityDigest(findings,QUALITY_REPORT_BYTES),nonWaivable:findings.filter(row=>!row.waivable).length,waivable:findings.filter(row=>row.waivable).length},body={version:1 as const,scope,policyDigest:qualityDigest(policy),gates,catalog,unknownRoles,summary};
  return freezeQuality(captureQuality(QualityPreparationSchema,{...body,digest:qualityDigest(body,QUALITY_REPORT_BYTES)},'free quality preparation',QUALITY_REPORT_BYTES));
}
export function validateQualityPreparation(taskId:unknown,source:unknown,policy:unknown,input:unknown){const stored=captureQuality(QualityPreparationSchema,input,'stored quality preparation',QUALITY_REPORT_BYTES),actual=prepareQualityChecks(taskId,source,policy);if(!equalQualityData(actual,stored))throw new QualityError('CONFLICT','free quality preparation binding','preparation');return actual;}
export function qualityFreeFindings(input:QualityPreparation){return [...input.gates.findings,...input.catalog.findings,...input.unknownRoles];}
