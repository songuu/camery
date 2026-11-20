import {QualityError,QUALITY_REPORT_BYTES} from '../contracts.js';
import {captureQuality} from '../boundary.js';
import {validateQualityReview} from '../state.js';
import {QualityPreparationSchema} from './preparation.js';
import {validateQualitySource,qualitySourceReference} from './source.js';
import {QualityKeySchema,QualityBatchAddressSchema,QualityCycleSchema,qualityCycleMaterial,validateQualityRun,qualityBatchCallId} from './state.js';
import {prepareQualityReviewAt} from './plan.js';
import {validateQualityReviewedBatch} from './generation.js';
import {qualityDigest,equalQualityData} from './data.js';

function fail():never{throw new QualityError('STORAGE_FAILED','quality progress protocol','progress');}
function own(input:unknown,key:string):unknown{if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return fail();const descriptor=Object.getOwnPropertyDescriptor(input,key);if(!descriptor||!('value'in descriptor))return fail();return descriptor.value;}
function items(input:unknown):unknown[]{if(!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype)return fail();const descriptors=Object.getOwnPropertyDescriptors(input) as unknown as Record<string,PropertyDescriptor>,length=descriptors['length']?.value as unknown;if(typeof length!=='number'||!Number.isInteger(length)||length<1||length>2||Reflect.ownKeys(descriptors).length!==length+1)return fail();return Array.from({length},(_,index)=>{const descriptor=descriptors[String(index)];if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)return fail();return descriptor.value as unknown;});}
/** Captures full source/result components independently, never under the smaller Durable reference envelope. This is not database authority. */
export function captureQualityBatchProgress(keyInput:unknown,addressInput:unknown,input:unknown){
  try{
    const key=captureQuality(QualityKeySchema,keyInput,'quality progress key',2048),address=captureQuality(QualityBatchAddressSchema,addressInput,'quality progress address',256),cycles=items(own(input,'cycles')),firstSource=validateQualitySource(own(cycles[0],'source')),run=validateQualityRun(key,own(input,'run'),firstSource),stateInput=own(input,'state'),state=validateQualityReview(stateInput,own(stateInput,'digest'));if(!equalQualityData(state.definition,run.initialState.definition)||state.projection.cycles.length!==cycles.length)return fail();
    const materials=cycles.map((selected,index)=>{
      const record=captureQuality(QualityCycleSchema,own(selected,'record'),'quality progress cycle',524288),material=qualityCycleMaterial(key,own(selected,'source'),run.policy),preparation=captureQuality(QualityPreparationSchema,own(selected,'preparation'),'quality progress preparation',QUALITY_REPORT_BYTES),{digest,...body}=record,active=state.projection.cycles[index];
      if(record.number!==index+1||!equalQualityData(record.key,key)||record.runDigest!==run.digest||qualityDigest(body)!==digest||record.sourceDigest!==material.source.digest||record.preparationDigest!==material.preparation.digest||!equalQualityData(record.manifests,material.manifests)||!equalQualityData(preparation,material.preparation)||record.actorId!==run.authorId||!active||!equalQualityData(active.source,qualitySourceReference(material.source))||!equalQualityData(active.gates,material.preparation.summary)||index===0&&(record.sourceDigest!==run.initialSourceDigest||record.preparationDigest!==run.initialPreparationDigest))return fail();
      for(const stage of active.stages){const manifest=material.manifests?.[stage.phase];if(!manifest||stage.manifestDigest!==manifest.digest||stage.expectedBatches!==manifest.count||stage.completedBatches!==manifest.count)return fail();}
      return Object.freeze({record,...material});
    }),selected=materials[address.cycle-1];if(!selected?.plan)return fail();const {record,...material}=selected,active=state.projection.cycles[address.cycle-1]!;
    const previous=['story','continuity','production'].indexOf(address.phase);if(active.stages.length<previous)throw new QualityError('INCOMPLETE','preceding quality stages','progress');const prepared=prepareQualityReviewAt(selected.plan,address.cycle,address.phase,address.index,active.stages.slice(0,previous).map(stage=>stage.digest)),resultInput=own(input,'result'),result=resultInput===null?null:validateQualityReviewedBatch(prepared,resultInput);
    if(result){const model=result.model,execution=run.reviewers[address.phase].execution;if(model.callId!==qualityBatchCallId(key,address.cycle,address.phase,address.index)||model.connectionId!==execution.connectionId||model.modeDigest!==execution.modeDigest||model.modelIdentity!==execution.modelIdentity||model.evidence!==execution.evidence)return fail();}
    return Object.freeze({run,address,material:Object.freeze({record,...material}),state,prepared,result});
  }catch(error){let known=false;try{known=error instanceof QualityError;}catch{/* Unknown store prototypes and private diagnostics never escape. */}if(known)throw error;return fail();}
}
