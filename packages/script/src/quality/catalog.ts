import {DEFAULT_RULE_THRESHOLDS} from '../outline/profiles.js';
import {captureQuality,createQualityFinding,freezeQuality} from './boundary.js';
import {ANTIPATTERN_IDS,QUALITY_MATERIAL_BYTES,QUALITY_POLICY_BYTES,QUALITY_REPORT_BYTES,QualityCatalogInputSchema,QualityCatalogReportSchema,QualityError,QualityPolicySchema} from './contracts.js';
import type {AntiPattern,QualityCatalogInput,QualityCatalogReport,QualityFinding,QualityPolicy} from './contracts.js';

/** Original review prompts, not measured creative-quality facts or permission to approve a script. */
export const ORIGINAL_ANTIPATTERNS=freezeQuality([
  {id:'slow-opening',label:'进入冲突过慢',enabled:true,severity:'major',recognition:'开头连续交代背景或人物经历，却没有让人物面对一个当下必须回应的阻碍；定位真正开始行动的第一拍。',remedy:'把会改变人物处境的阻碍放到开头，用接下来的选择补足必要背景，不靠增加旁白加快表面节奏。'},
  {id:'unrealized-reward',label:'承诺的回报没有落地',enabled:true,severity:'major',recognition:'人物宣布已经反击或获胜，但资源、关系、公开信息和对手行动都没有发生可辨认的变化。',remedy:'写出结果怎样改变现场的一项具体条件，并让受影响的人作出新选择；保留得到回报所付的代价。'},
  {id:'repeated-plot',label:'同一冲突重复运转',enabled:true,severity:'major',recognition:'相邻段落重复同一目标、阻碍和解决办法，只更换说法或地点，前一次行动的结果未进入下一次冲突。',remedy:'让上一次解决办法带来新的限制、损失或公开事实，使下一段需要不同的策略，并删除没有状态变化的重复段。'},
  {id:'unearned-rescue',label:'解决办法缺少铺垫',enabled:true,severity:'major',recognition:'决定性援助、规则或证据只在危机结束时出现，之前没有可查的行动、关系或条件说明它为何可用。',remedy:'提前呈现援助得以发生的条件，说明人物为争取它做过什么，并让援助保留一个仍须自己解决的问题。'},
  {id:'unearned-advantage',label:'优势没有获取过程',enabled:true,severity:'major',recognition:'人物突然获得技能、信息或支配资源的权利，却没有获取、练习、交换或承担风险的过程与限制。',remedy:'补出获取优势的具体路径和使用边界，安排一次需要付出成本的选择，避免优势自动消除后续所有困难。'},
  {id:'weakened-opponent',label:'对手为结果放弃能力',enabled:true,severity:'major',recognition:'对手在关键处忘记此前已经掌握的信息、工具或目标，且没有新证据说明为什么改用明显无效的行动。',remedy:'先保持对手原有能力，再让主角通过可观察的准备改变条件；如果对手失误，说明符合其目标的误判依据。'},
  {id:'costless-protagonist',label:'主角选择没有代价',enabled:true,severity:'major',recognition:'人物连续得到所需结果，却没有失去时间、资源、关系或机会；失误也不改变后续行动条件。',remedy:'为关键选择指定一项实际失去的东西，让后续场景承接该损失，并保留人物仍愿意行动的理由。'},
  {id:'closed-episode',label:'单集结束切断持续问题',enabled:true,severity:'major',recognition:'本集把全部冲突、信息缺口和人物选择一并关闭，与前后集的持续目标不再有可定位的因果联系。',remedy:'完成本集已经承诺的局部结果，再让结果带出一个更具体的选择或后果；完整结局项目需人工明确豁免。'},
  {id:'decorative-genre',label:'题材元素只作标签',enabled:true,severity:'major',recognition:'删除某个题材元素后，人物目标、取得证据的路径、冲突风险和结局选择仍完全相同，只少了名词装饰。',remedy:'让该元素改变一个关键条件及其代价，或明确缩减题材承诺；用受影响的实际节拍说明修改而非补标签。'},
  {id:'unfilmable-prose',label:'画面无法承载的解释',enabled:true,severity:'minor',recognition:'动作描述主要说明作者判断、抽象心理或未被表现的历史，现场行为与声音不足以让观众获得同一信息。',remedy:'选择一个可见动作、可听声音或必要且明确的声音类型承载信息，保留人物主观声音与客观事实的区别。'},
  {id:'empty-dialogue',label:'台词没有推进信息或选择',enabled:true,severity:'minor',recognition:'连续台词只换说法确认刚说过的情绪或事实，没有新增信息、改变关系，也没有迫使任何人采取下一步。',remedy:'保留会改变听者判断或行动的句子，把其余内容交给动作或删去，并核对删句后的知情来源仍然成立。'},
  {id:'overlong-scene',label:'场景缺少阶段性变化',enabled:true,severity:'minor',recognition:'一个场景持续使用同一交流方式处理过多信息，节拍的目标、力量关系或观众正在追问的问题长期不变。',remedy:'按实际目标变化重排节拍，安排可见的结果或行动转换；是否拆场还需结合连续性、时长和制作条件审阅。'},
  {id:'repeated-cliffhanger',label:'集末只复用同一悬念方式',enabled:true,severity:'major',recognition:'相邻集反复靠同一种中断或隐瞒收尾，虽可更换台词，却没有改变观众等待的答案及下一集的行动条件。',remedy:'结合已配置的卡点轮换检查后果，选择信息、行动或两难选择中的不同推进方式，并兑现前集已作的承诺。'},
] satisfies AntiPattern[]);

/** Initial examples are explicit configuration; blacklist entries do not assert real-world name frequency. */
export function createDefaultQualityPolicy():QualityPolicy{
  return validateQualityPolicy({version:1,id:'camery-quality-initial',revision:1,label:'原创质量规则初值，需按项目核对',source:'camery-original',guidanceStatus:'unvalidated',thresholds:{...DEFAULT_RULE_THRESHOLDS},
    cliches:[
      {id:'unprepared-rescue-cue',tier:1,label:'临时救援提示语',literal:'救兵恰好赶到',mode:'exact',recognition:'字面出现临时援助提示语，仅提示核查援助是否已有铺垫，不能由一次命中断言剧情错误。',remedy:'回查此前人物行动和援助条件；若已有充分铺垫，人工记录理由后保留。'},
      {id:'deferred-counterattack-cue',tier:2,label:'推迟行动提示语',literal:'下次一定讨回',mode:'exact',recognition:'字面出现再次推迟反击的表述，需核对本集是否另有可见结果及推迟的实际原因。',remedy:'给本集一次局部行动及可观察后果，或明确推迟行动需要支付的新代价。'},
      {id:'interrupted-sentence-cue',tier:3,label:'中断话语提示语',literal:'话还没说完',mode:'exact',recognition:'字面出现中断说明，需人工判断它是否改变具体期待，不能把中断本身当作有效悬念。',remedy:'核对前一集已作承诺，保留真正推动下一步选择的信息缺口，避免只重复停顿。'},
    ],scoring:{base:10,tier1Penalty:3,tier2Penalty:1,tier3PerEpisodeLimit:1},
    naming:{blacklistedNames:['角色甲','角色乙'],blacklistedSurnames:[],blacklistedCharacters:[],surnamePrefixes:['欧阳','司马','上官','诸葛','赵','钱','孙','李','周','吴','郑','王'],distinctPrincipalSurnames:true},
    antipatterns:ORIGINAL_ANTIPATTERNS.map(row=>({...row})),
  });
}
function invalid(path:string):never{throw new QualityError('INVALID_REFERENCE','quality catalog binding',path);}
function unique(values:readonly string[],path:string):void{if(new Set(values).size!==values.length)invalid(path);}
export function validateQualityPolicy(input:unknown):QualityPolicy{
  const policy=captureQuality(QualityPolicySchema,input,'quality policy',QUALITY_POLICY_BYTES);
  unique(policy.cliches.map(row=>row.id),'cliches');unique(policy.antipatterns.map(row=>row.id),'antipatterns');
  if(ANTIPATTERN_IDS.some(id=>!policy.antipatterns.some(row=>row.id===id)))invalid('antipatterns');
  for(const field of ['blacklistedNames','blacklistedSurnames','blacklistedCharacters','surnamePrefixes'] as const)unique(policy.naming[field],'naming.'+field);
  // This literal blacklist uses Unicode code points; offsets in source findings remain UTF-16.
  if(policy.naming.blacklistedCharacters.some(value=>Array.from(value).length!==1))invalid('naming.blacklistedCharacters');
  if(policy.naming.surnamePrefixes.some(value=>value.trim()!==value))invalid('naming.surnamePrefixes');
  return freezeQuality(policy);
}
function pointer(path:string):void{if(!path.startsWith('/')||/~(?![01])/u.test(path))invalid('path');}
function capturedInput(input:unknown):QualityCatalogInput{
  const value=captureQuality(QualityCatalogInputSchema,input,'quality catalog material',QUALITY_MATERIAL_BYTES);
  for(const rows of [value.texts,value.names]){unique(rows.map(row=>row.id),'material ids');unique(rows.map(row=>row.path),'material paths');for(const row of rows)pointer(row.path);}
  const textByPath=new Map(value.texts.map(row=>[row.path,row]));for(const name of value.names){const text=textByPath.get(name.path);if(text&&(text.text!==name.name||text.episodeNumber!==name.episodeNumber))invalid('material name projection');}
  return freezeQuality(value);
}
const episodeKey=(value:number|null)=>value===null?'global':String(value);
const asciiFold=(value:string)=>value.replace(/[A-Z]/g,letter=>String.fromCharCode(letter.charCodeAt(0)+32));
type Score={episodeNumber:number|null;tier1:Set<string>;tier2:Set<string>;tier3:number};
/** Scores count literal cliche rules only; naming and semantic review topics never become a measured overall quality score. */
export function checkQualityCatalog(input:unknown,policyInput:unknown):QualityCatalogReport{
  const policy=validateQualityPolicy(policyInput),material=capturedInput(input),findings:QualityFinding[]=[],scores=new Map<string,Score>(),encoder=new TextEncoder();let findingBytes=0;
  function score(episodeNumber:number|null){const key=episodeKey(episodeNumber);let found=scores.get(key);if(!found){found={episodeNumber,tier1:new Set(),tier2:new Set(),tier3:0};scores.set(key,found);}return found;}
  function finding(detail:Parameters<typeof createQualityFinding>[1]){const result=createQualityFinding(material.scope,detail);findingBytes+=encoder.encode(JSON.stringify(result)).byteLength+(findings.length?1:0);if(findings.length>=65536||findingBytes>QUALITY_REPORT_BYTES)throw new QualityError('INPUT_LIMIT','quality catalog report','findings');findings.push(result);}
  function observation(code:string,path:string,problem:string,suggestion:string,evidence:QualityFinding['evidence'],severity:'minor'|'major'='major'){
    finding({code,origin:'configured',phase:'story',waivable:true,path,severity,problem,audienceImpact:'重复机制或不易区分的人物称呼可能使观众误读冲突、身份及后续期待；当前只是需核对的配置提示。',suggestion,ripple:['调整后核对关联台词、人物称呼、知情来源与相邻集承诺。'],evidence});
  }
  for(const text of material.texts){const totals=score(text.episodeNumber);for(const rule of policy.cliches){const folded=rule.mode==='ascii_insensitive',haystack=folded?asciiFold(text.text):text.text,needle=folded?asciiFold(rule.literal):rule.literal;let from=0;
    while(from<=haystack.length-needle.length){const start=haystack.indexOf(needle,from);if(start<0)break;const end=start+needle.length,quote=text.text.slice(start,end),evidence=[{path:text.path,start,end,quote}];
      observation(rule.id,text.path,rule.label+'：'+rule.recognition,rule.remedy,evidence,rule.tier===3?'minor':'major');
      if(rule.tier===1)totals.tier1.add(rule.id);else if(rule.tier===2)totals.tier2.add(rule.id);else{totals.tier3++;if(totals.tier3>policy.scoring.tier3PerEpisodeLimit)observation('cliche-tier3-frequency',text.path,'本集三级提示语累计 '+totals.tier3+' 次，超过配置允许的 '+policy.scoring.tier3PerEpisodeLimit+' 次；本条定位到超出频次的原文。','核对本集全部三级提示语位置，保留有具体叙事作用的表达，或由人工明确记录豁免理由。',evidence,'minor');}
      from=start+1;
    }
  }}
  const fullNames=new Map<string,QualityCatalogInput['names']>(),surnames=new Map<string,QualityCatalogInput['names']>(),surnameById=new Map<string,string>();
  for(const name of material.names){score(name.episodeNumber);const key=JSON.stringify([episodeKey(name.episodeNumber),name.name]),group=fullNames.get(key)??[];group.push(name);fullNames.set(key,group);const surname=policy.naming.surnamePrefixes.filter(prefix=>name.name.startsWith(prefix)&&prefix.length<name.name.length).sort((a,b)=>b.length-a.length)[0];if(surname){surnameById.set(name.id,surname);if(name.principal){const surnameKey=JSON.stringify([episodeKey(name.episodeNumber),surname]),principal=surnames.get(surnameKey)??[];principal.push(name);surnames.set(surnameKey,principal);}}}
  for(const name of material.names){const evidence=(start:number,end:number)=>[{path:name.path,start,end,quote:name.name.slice(start,end)}],surname=surnameById.get(name.id);
    if(policy.naming.blacklistedNames.includes(name.name))observation('naming-blacklisted-name',name.path,'人物名命中当前配置的完整名字黑名单；这不代表该名在真实作品中的流行度统计。','结合人物功能重新命名，或由人工确认保留该名的理由。',evidence(0,name.name.length));
    if(surname&&policy.naming.blacklistedSurnames.includes(surname))observation('naming-blacklisted-surname',name.path,'显式识别的姓氏“'+surname+'”命中当前配置黑名单。','核对项目命名要求后调整姓氏，联动更新人物台词、别名和关联说明。',evidence(0,surname.length));
    for(const character of policy.naming.blacklistedCharacters){let from=0;while(from<=name.name.length-character.length){const start=name.name.indexOf(character,from);if(start<0)break;observation('naming-blacklisted-character',name.path,'人物名包含配置限制的字“'+character+'”；当前限制是项目规则，并非流行度事实。','按人物辨识需求选择其他用字，或记录保留该字的人工理由。',evidence(start,start+character.length));from=start+character.length;}}
    if(!surname&&(name.principal&&policy.naming.distinctPrincipalSurnames||policy.naming.blacklistedSurnames.length>0))observation('naming-unknown-surname',name.path,'现有显式前缀配置不能确定该人物姓氏，尚不能完成重姓或姓氏黑名单检查。','由人工补充准确的姓氏前缀或核对命名规则，不按首字推测姓氏。',evidence(0,name.name.length),'minor');
    const duplicate=fullNames.get(JSON.stringify([episodeKey(name.episodeNumber),name.name]))!;if(duplicate.length>1){const other=duplicate.find(row=>row.id!==name.id)!;observation('naming-duplicate-name',name.path,'同一明确集号范围内有多个不同人物使用完整同名。','核对是否应合并同一人物身份；若确为不同人物，增加可辨认且一致的称呼或人工说明。',[...evidence(0,name.name.length),{path:other.path,start:0,end:other.name.length,quote:other.name}]);}
    if(name.principal&&surname&&policy.naming.distinctPrincipalSurnames){const principal=surnames.get(JSON.stringify([episodeKey(name.episodeNumber),surname]))!;if(principal.length>1){const other=principal.find(row=>row.id!==name.id)!;observation('naming-duplicate-principal-surname',name.path,'同一明确集号范围内有多个主要人物使用显式姓氏“'+surname+'”。','核对亲属关系及人物辨识需求，调整姓氏或记录主要人物重姓的人工理由。',[...evidence(0,surname.length),{path:other.path,start:0,end:surname.length,quote:surname}]);}}
  }
  const result={version:1 as const,kind:'configured_quality' as const,scope:material.scope,policy:{id:policy.id,revision:policy.revision},guidanceStatus:'unvalidated' as const,findings,scores:[...scores.values()].map(row=>{const raw=policy.scoring.base-policy.scoring.tier1Penalty*row.tier1.size-policy.scoring.tier2Penalty*row.tier2.size;return {episodeNumber:row.episodeNumber,raw,bounded:Math.max(0,Math.min(policy.scoring.base,raw)),tier1:row.tier1.size,tier2:row.tier2.size,tier3:row.tier3};}),requiresHumanReview:true as const,mediaQualityVerified:false as const};
  return freezeQuality(captureQuality(QualityCatalogReportSchema,result,'quality catalog report',QUALITY_REPORT_BYTES));
}
