import {expect} from 'vitest';
import {digest} from '@camery/methods';
import type {Json} from '@camery/model-modes';
import type {QualitySource} from '../src/quality/node/source.js';
import type {QualityReviewPlan} from '../src/quality/node/plan.js';
import {qualityDigest} from '../src/quality/node/data.js';
import type {QualityReviewUnit} from '../src/quality/model-contracts.js';
import {SCREENPLAY_DRAFT_BYTES} from '../src/screenplay/contracts.js';

export type PlanScreenplaySource=QualitySource&{subject:Extract<QualitySource['subject'],{kind:'screenplay'}>};
/** Rehashed captured-data fixtures prove pure partition integrity only, never actual-source authority or PostgreSQL acceptance. */
export function copyPlanScreenplaySource(source:QualitySource):PlanScreenplaySource{if(source.subject.kind!=='screenplay')throw new Error('Plan fixture must be screenplay');return structuredClone(source) as PlanScreenplaySource;}
export function rehashPlanSource<T extends QualitySource>(source:T):T{const {digest:_digest,...body}=source;return {...source,digest:qualityDigest(body)};}
export function addPlanReferences(source:QualitySource,count=5,text='a'.repeat(131069)+'😀'+'b'.repeat(170000)+'\t\n"\\/~😀'.repeat(8000)):PlanScreenplaySource{
  const raw=copyPlanScreenplaySource(source);
  for(let index=0;index<count;index++)raw.subject.context.references.push({id:'plan-reference-'+index,path:'/reference/~escaped/'+index,kind:'original_development',text,quotes:[]});
  return rehashPlanSource(raw);
}
export function fillPlanDraftCommon(source:QualitySource,character='"'):PlanScreenplaySource{
  const raw=copyPlanScreenplaySource(source),draft=raw.subject.draft,beat=draft.scenes.flatMap(scene=>scene.beats).find(beat=>beat.lines.length)!,sample=beat.lines[0]!;
  // Preserve original referenced lines and approach the draft cap; actual method encoding decides whether common still fits.
  let index=0;for(;;){const line={...sample,id:'plan-common-line-'+index++,text:''},available=SCREENPLAY_DRAFT_BYTES-100-Buffer.byteLength(JSON.stringify(draft))-Buffer.byteLength(JSON.stringify(line))-1,characters=Math.min(8000,Math.floor(available/(Buffer.byteLength(JSON.stringify(character))-2)));if(characters<1)break;beat.lines.push({...line,text:character.repeat(characters)});}
  return rehashPlanSource(raw);
}
function escapePointer(key:string):string{return key.replaceAll('~','~0').replaceAll('/','~1');}
function descendants(root:Json,path:string):{path:string;value:Json}[]{
  if(root===null||typeof root!=='object'||!Object.keys(root).length)return [{path,value:root}];
  return Object.entries(root).flatMap(([key,value])=>descendants(value,path+'/'+escapePointer(key)));
}
function at(root:Json,path:string):Json{let value=root;for(const part of path.slice(1).split('/'))value=(value as Record<string,Json>)[part.replaceAll('~1','/').replaceAll('~0','~')]!;return value;}
function within(path:string,parent:string):boolean{return path===parent||path.startsWith(parent+'/');}
/** Independently walks every residual leaf and empty container; coverage must have no gaps or duplicates across batches. */
export function expectCompletePlanCoverage(plan:QualityReviewPlan):void{
  for(const role of Object.values(plan.phases)){
    const units=role.batches.flatMap(batch=>batch.units),root=plan.root as Record<string,Json>,residual=plan.source.subject.kind==='screenplay'?['context','upstream']:['upstream'];
    expect(new Set(units.map(unit=>unit.id)).size).toBe(units.length);
    if(units.length===1&&units[0]!.kind==='document'){expect(units[0]!.path).toBe('');expect(units[0]!.content).toEqual(plan.root);expect(role.batches[0]!.common).toEqual([]);continue;}
    for(const unit of units){expect(residual.some(key=>within(unit.path,'/'+key))).toBe(true);const actual=at(plan.root,unit.path),{kind,path,start,end,content}=unit;expect(unit.digest).toBe(digest({kind,path,start,end,content}));if(kind==='string_slice'){expect(typeof actual).toBe('string');expect(content).toBe((actual as string).slice(start!,end!));expect((content as string).isWellFormed()).toBe(true);}else expect(content).toEqual(actual);}
    const leaves=residual.flatMap(key=>descendants(root[key]!,'/'+key));
    for(const leaf of leaves){const parent=units.filter(unit=>unit.kind!=='string_slice'&&within(leaf.path,unit.path)),slices=units.filter(unit=>unit.kind==='string_slice'&&unit.path===leaf.path).sort((a,b)=>a.start!-b.start!);if(parent.length){expect(parent).toHaveLength(1);expect(slices).toHaveLength(0);}else{expect(typeof leaf.value).toBe('string');expect(slices.length).toBeGreaterThan(0);let next=0;for(const slice of slices){expect(slice.start).toBe(next);next=slice.end!;}expect(next).toBe((leaf.value as string).length);expect(slices.map(slice=>slice.content as string).join('')).toBe(leaf.value);}}
    const commonKeys=Object.keys(root).filter(key=>!residual.includes(key)).sort();
    for(const batch of role.batches)expect(batch.common).toEqual(commonKeys.map(key=>({path:'/'+escapePointer(key),content:root[key]!})));
  }
}
export function allPlanUnits(plan:QualityReviewPlan):QualityReviewUnit[]{return plan.phases.story.batches.flatMap(batch=>batch.units);}
