import {FoundationOutputSchema,EpisodeOutputSchema} from '@camery/script/contracts';
import type {FoundationOutput} from '@camery/script/contracts';
import type {z} from 'zod';
import {boundedDevelopmentSchema,DevelopmentFoundationConfirmSchema,DevelopmentEpisodesConfirmSchema} from '@camery/script/http';
import type {DevelopmentRunView} from '@camery/script/http';
type Brief=Pick<DevelopmentRunView['brief'],'episodeCount'>;
export function developmentDraft<T>(output:T):T{return structuredClone(output);}
const unique=(ids:readonly string[])=>new Set(ids).size===ids.length;
const references=(ids:readonly string[],available:Set<string>)=>unique(ids)&&ids.every(id=>available.has(id));
function fields<T>(schema:z.ZodType<T>,input:unknown,limit:number){
  const result=boundedDevelopmentSchema(schema).safeParse(input);
  if(!result.success)return {valid:false,issues:['请补齐必填内容，并检查字段长度与条目数量。'],bytes:0,limit};
  const bytes=new TextEncoder().encode(JSON.stringify(result.data)).length;
  return {valid:bytes<=limit,issues:bytes>limit?[`完整内容超过 ${limit/1024} KiB，请精简后再确认。`]:[],bytes,limit};
}
export function inspectFoundationDraft(input:unknown){
  const base=fields(FoundationOutputSchema,input,32768);if(!base.valid)return base;
  const output=FoundationOutputSchema.parse(input);const characters=new Set(output.characters.map(c=>c.id));const rules=new Set(output.world.rules.map(r=>r.id));const issues:string[]=[];
  if(![output.characters,output.world.rules,output.relationships,output.openQuestions].every(rows=>unique(rows.map(row=>row.id))))issues.push('同类条目的标识重复，请重新添加冲突条目。');
  if(!references(output.mainline.characterIds,characters)||!references(output.mainline.ruleIds,rules))issues.push('主线引用了已删除的人物或规则，请重新选择。');
  if(output.relationships.some(r=>r.from===r.to||!characters.has(r.from)||!characters.has(r.to)))issues.push('人物关系必须连接两位不同且仍存在的人物。');
  if(!output.characters.some(c=>c.function==='protagonist'&&output.mainline.characterIds.includes(c.id)))issues.push('请在主线中选择至少一位主角。');
  return {...base,valid:issues.length===0,issues};
}
export function inspectEpisodeDraft(input:unknown,brief:Brief,foundation:FoundationOutput){
  const base=fields(EpisodeOutputSchema,input,65536);if(!base.valid)return base;
  const output=EpisodeOutputSchema.parse(input);const characters=new Set(foundation.characters.map(c=>c.id));const rules=new Set(foundation.world.rules.map(r=>r.id));const issues:string[]=[];
  if(output.episodes.length!==brief.episodeCount||output.episodes.some((ep,index)=>ep.number!==index+1))issues.push(`需保留连续的第 1–${brief.episodeCount} 集，请核对集数与顺序。`);
  if(output.episodes.some(ep=>!references(ep.characterIds,characters)||!references(ep.ruleIds,rules)))issues.push('分集引用了已删除或重复的人物/规则，请重新选择。');
  if(!output.episodes.some(ep=>ep.characterIds.some(id=>foundation.characters.some(c=>c.id===id&&c.function==='protagonist'))))issues.push('整季至少一集需要主角参与。');
  return {...base,valid:issues.length===0,issues};
}
export function developmentDecision(stage:'foundation'|'episodes',candidateDigest:string,output:unknown,brief:Brief,foundation:FoundationOutput){
  const inspection=stage==='foundation'?inspectFoundationDraft(output):inspectEpisodeDraft(output,brief,foundation);if(!inspection.valid)return null;
  const parsed=stage==='foundation'?boundedDevelopmentSchema(DevelopmentFoundationConfirmSchema).safeParse({candidateDigest,output}):boundedDevelopmentSchema(DevelopmentEpisodesConfirmSchema).safeParse({candidateDigest,output});
  return parsed.success?parsed.data:null;
}
