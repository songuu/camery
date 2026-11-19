import {ComplianceError,LiteralReportSchema,PolicySchema,POLICY_BYTES,REPORT_BYTES} from './contracts.js';
import type {Finding,LiteralReport,Policy} from './contracts.js';
import {capture,captureCorpus,freeze} from './boundary.js';

function invalid(path:string):never{throw new ComplianceError('INVALID_REFERENCE','precheck policy',path);}
export function validatePolicy(input:unknown):Policy{
  const policy=capture(PolicySchema,input,'precheck policy',POLICY_BYTES),categories=new Set<string>(),rules=new Set<string>();
  for(const [i,category] of policy.categories.entries()){if(categories.has(category.id))invalid(`categories.${i}.id`);categories.add(category.id);}
  for(const [i,rule] of policy.rules.entries()){
    if(rules.has(rule.id))invalid(`rules.${i}.id`);rules.add(rule.id);
    if(!categories.has(rule.categoryId))invalid(`rules.${i}.categoryId`);
    if(new Set(rule.fields).size!==rule.fields.length)invalid(`rules.${i}.fields`);
  }
  return freeze(policy);
}
// General Unicode case folding may change UTF-16 length; only this ASCII transform preserves source positions.
function asciiFold(text:string):string{return text.replace(/[A-Z]/g,character=>character.toLowerCase());}
const encoder=new TextEncoder();
const bytes=(value:unknown):number=>encoder.encode(JSON.stringify(value)).byteLength;
/** Literal configuration is data, not a legal clearance or executable regular expression. */
export function checkLiteralRules(policyInput:unknown,corpusInput:unknown):LiteralReport{
  const policy=validatePolicy(policyInput),corpus=captureCorpus(corpusInput),categories=new Map(policy.categories.map(category=>[category.id,category]));
  const rules=policy.rules.map(rule=>({rule,needle:rule.mode==='ascii_insensitive'?asciiFold(rule.literal):rule.literal})),findings:Finding[]=[];
  const report:LiteralReport={version:1,kind:'advisory_precheck',authority:'unverified_configuration',policy:{id:policy.id,revision:policy.revision},episodeId:corpus.episodeId,coveredSegments:corpus.segments.map(segment=>segment.id),findings,requiresHumanReview:true};
  let reportBytes=bytes(report);
  if(reportBytes>REPORT_BYTES)throw new ComplianceError('INPUT_LIMIT','literal precheck report','report');
  for(const segment of corpus.segments){
    let folded:string|undefined;
    for(const {rule,needle} of rules){
      if(!rule.fields.includes(segment.field))continue;
      const text=rule.mode==='ascii_insensitive'?(folded??=asciiFold(segment.text)):segment.text;
      for(let start=text.indexOf(needle);start!==-1;start=text.indexOf(needle,start+1)){
        if(findings.length>=65536)throw new ComplianceError('INPUT_LIMIT','literal precheck report','findings.length');
        const end=start+needle.length,finding:Finding={id:'literal:'+JSON.stringify([rule.id,segment.id,start,end]),origin:'literal',ruleId:rule.id,categoryId:rule.categoryId,risk:categories.get(rule.categoryId)!.risk,segmentId:segment.id,path:segment.path,start,end,quote:segment.text.slice(start,end),reason:rule.label,uncertain:false};
        // Spend each full finding before retaining it; a prefix can never be returned as complete coverage.
        const nextBytes=reportBytes+bytes(finding)+(findings.length?1:0);
        if(nextBytes>REPORT_BYTES)throw new ComplianceError('INPUT_LIMIT','literal precheck report','report');
        findings.push(finding);reportBytes=nextBytes;
      }
    }
  }
  return freeze(capture(LiteralReportSchema,report,'literal precheck report',REPORT_BYTES));
}
