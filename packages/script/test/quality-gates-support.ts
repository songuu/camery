import {ANTIPATTERN_IDS} from '../src/quality/contracts.js';
import type {QualityPolicy,QualityScope,QualitySubject} from '../src/quality/contracts.js';
import {outlineFixture} from './outline-support.js';
import {screenplayFixture} from './screenplay-support.js';

/** Synthetic rule configuration and pure domain data; no actual adoption or human-authority claim. */
export function qualityGateFixture(){
  const scope:QualityScope={tenantId:'quality-tenant',projectId:'quality-project',taskId:'quality-task',objectId:'quality-subject',sourceDigest:'a'.repeat(64)},outline=outlineFixture();
  const policy:QualityPolicy={version:1,id:'gate-fixture',revision:1,label:'仅机械闸门测试',source:'camery-original',guidanceStatus:'unvalidated',thresholds:{repeatedCliffhangerWindow:3,lowEmotionWindow:3,lowEmotionBelow:6,openingHookBySecond:3,stakesBySecond:10},cliches:[],scoring:{base:10,tier1Penalty:3,tier2Penalty:1,tier3PerEpisodeLimit:1},naming:{blacklistedNames:[],blacklistedSurnames:[],blacklistedCharacters:[],surnamePrefixes:[],distinctPrincipalSurnames:false},antipatterns:ANTIPATTERN_IDS.map(id=>({id,label:'测试 '+id,enabled:true,recognition:'只检验配置结构。',remedy:'人工复核。',severity:'major'}))};
  const subject:QualitySubject={kind:'outline',...outline};return {scope,policy,subject,outline};
}
export function qualityScreenplayFixture(episodeNumber=1,episodeCount=3){
  const f=qualityGateFixture(),script=screenplayFixture(episodeNumber),outline=outlineFixture();
  outline.context.episodeCount=episodeCount;outline.context.paidEpisodeNumbers=[];outline.output.episodes=outline.output.episodes.slice(0,episodeCount).map(row=>({...row,paidBreakpoint:false}));outline.output.beats=outline.output.beats.slice(0,episodeCount);
  const ids=outline.output.beats.map(row=>row.id);outline.output.recipe.signatureScenes[0]!.beatIds=[ids[0]!];outline.output.recipe.ablations[0]!.affectedBeatIds=[ids[0]!];outline.output.assets[0]!.beatIds=[...ids];outline.output.plotUnits[0]!.episodeNumbers=outline.output.episodes.map(row=>row.number);outline.output.plotUnits[0]!.beatIds=[...ids];
  const subject:Extract<QualitySubject,{kind:'screenplay'}>={kind:'screenplay',context:script.context,draft:script.draft,outline};return {...f,...script,subject};
}
