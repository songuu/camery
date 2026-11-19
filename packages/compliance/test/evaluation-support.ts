import type {Assessment} from '../src/contracts.js';

/** Synthetic labels only; their hashes bind fixture identities, never real source or legal authority. */
export function evaluationFixture(){
  const caseOne={id:'case-one',sourceDigest:'a'.repeat(64),policyDigest:'b'.repeat(64),labels:[{segmentId:'positive',categoryId:'fixture-category',flagged:true},{segmentId:'negative',categoryId:'fixture-category',flagged:false}]},caseTwo={id:'case-two',sourceDigest:'c'.repeat(64),policyDigest:'b'.repeat(64),labels:[{segmentId:'second-positive',categoryId:'fixture-category',flagged:true},{segmentId:'second-negative',categoryId:'fixture-category',flagged:false}]};
  const dataset={version:1 as const,id:'fixture-dataset',revision:1,evidence:'synthetic_fixture' as 'synthetic_fixture'|'provided_labels',labelReference:'Synthetic protocol labels, not a signed production benchmark.',cases:[caseOne,caseTwo]};
  const assessment=(segmentId:string,verdict:Assessment['verdict'],categoryId='fixture-category'):Assessment=>({segmentId,categoryId,verdict,start:0,end:verdict==='not_flagged'?0:1,quote:verdict==='not_flagged'?null:'例',reason:'合成评估预测。'});
  const predictions=dataset.cases.map(row=>({caseId:row.id,sourceDigest:row.sourceDigest,policyDigest:row.policyDigest,assessments:row.labels.map(label=>assessment(label.segmentId,label.flagged?'flag':'not_flagged',label.categoryId))}));
  return {dataset,predictions,assessment};
}
