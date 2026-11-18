import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {MethodRegistry,MethodRunner,ModelSession,createStructuredGenerationExecutor} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {generateOutline,outlineContext} from '../src/outline/node/generation.js';
import {createOutlineMethodPack} from '../src/outline/node/method-assets.js';
import {PostgresOutlineStore} from '../src/outline/node/store.js';
import {outlineCallId} from '../src/outline/node/persistence-contracts.js';
import {outlineAdoptionSource} from '../src/outline/node/formal-source.js';
import {reviewOutlineCraft} from '../src/outline/outline.js';
import type {OutlineOutput} from '../src/outline/contracts.js';
import {outlineFixture} from './outline-support.js';
import {createBibleSourceFixture,createDevelopmentSourceFixture} from './outline-source-pg-support.js';

function outputFor(count:number,reference:string,capacity:boolean):OutlineOutput{
  const output=outlineFixture().output,character=output.characters[0]!,beat=output.beats[0]!,episode=output.episodes[0]!,asset=output.assets[0]!,unit=output.plotUnits[0]!,decision=output.adaptation.decisions[0]!;
  const origin={kind:'adapted' as const,sourceRefIds:[reference]},perEpisode=capacity?5:1;
  output.characters=Array.from({length:capacity?64:1},(_,i)=>({...structuredClone(character),id:`character-${i}`,name:`Character ${i}`,function:i===0?'protagonist':'supporting',desire:'goal',obstacle:'opposition',arc:'change',origin}));
  output.beats=Array.from({length:count*perEpisode},(_,i)=>({...structuredClone(beat),id:`beat-${i}`,episodeNumber:Math.floor(i/perEpisode)+1,order:i%perEpisode+1,characterIds:['character-0'],goal:'goal',conflict:'conflict',turn:'turn',consequence:'consequence',origin}));
  output.episodes=Array.from({length:count},(_,i)=>{const beats=output.beats.slice(i*perEpisode,(i+1)*perEpisode).map(row=>row.id);return {...structuredClone(episode),number:i+1,title:`Episode ${i+1}`,synopsis:'A choice changes the next conflict.',beatIds:beats,openingHook:{...episode.openingHook,beatId:beats[0]!},stakes:{...episode.stakes,beatId:beats[0]!},cliffhanger:{...episode.cliffhanger,type:(['choice','partial_reveal','identity_near'] as const)[i%3]!,beatId:beats.at(-1)!},paidBreakpoint:i+1===count};});
  output.assets=Array.from({length:capacity?256:1},(_,i)=>({...structuredClone(asset),id:`asset-${i}`,name:`Prop ${i}`,description:'prop',narrativeRole:'changes choice',characterId:null,beatIds:[`beat-${i%output.beats.length}`],origin,propStates:[{beatId:`beat-${i%output.beats.length}`,before:'intact',after:'broken',reason:'conflict'}]}));
  output.plotUnits=Array.from({length:count},(_,i)=>({...structuredClone(unit),id:`unit-${i}`,episodeNumbers:[i+1],beatIds:output.episodes[i]!.beatIds,pressure:'pressure',escalation:'escalation',reversal:'reversal',release:'release',nextCrisis:'crisis'}));
  output.adaptation.decisions=Array.from({length:capacity?128:1},(_,i)=>({...structuredClone(decision),id:`decision-${i}`,reason:'Keep a causal choice.',sourceRefIds:[reference]}));
  output.recipe.signatureScenes[0]!.beatIds=[output.beats.at(-1)!.id];output.recipe.ablations[0]!.affectedBeatIds=[output.beats[0]!.id];
  output.seasonEngine.characterIds=['character-0'];output.seasonEngine.plotUnitIds=output.plotUnits.map(row=>row.id);
  if(capacity){
    // Fill typed prose up to the unchanged output boundary, rather than an opaque padding field.
    for(const row of output.assets){const remaining=500000-Buffer.byteLength(JSON.stringify(output));if(remaining<=0)break;row.description+='x'.repeat(Math.min(1000-row.description.length,remaining));}
    for(const row of output.beats){const remaining=500000-Buffer.byteLength(JSON.stringify(output));if(remaining<=0)break;row.goal+='x'.repeat(Math.min(500-row.goal.length,remaining));}
  }
  return output;
}

/** Actual source and Outline PG stores, one explicit synthetic adapter call per run and a stored human audit. */
export async function outlineIdentityPgFixture(pool:Pool,owned:string[],options:{kind?:'development'|'bible';count?:number;capacity?:boolean;review?:boolean}={}){
  const scope={tenantId:'outline-local-identities-'+randomUUID(),projectId:'project'};owned.push(scope.tenantId);
  const upstream=options.kind==='bible'?await createBibleSourceFixture(pool,scope):await createDevelopmentSourceFixture(pool,scope);
  const target={tenantId:id('formal-tenant-'+scope.tenantId),projectId:id('formal-project-'+scope.tenantId)},store=new PostgresOutlineStore(pool);
  const put={...scope,briefId:'adaptation',expectedRevision:0,actorId:'registry-editor',notes:'保留已审阅来源的因果选择。',episodeCount:options.count??3,targetSeconds:90,paidEpisodeNumbers:[options.count??3],mainGenre:'rebirth-revenge',auxiliaryGenres:['suspense']};
  let brief=(await store.putBrief(put)).brief,calls=0;
  const execution={connectionId:'outline-identity-fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture/outline-identities',evidence:'synthetic_replay' as const,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:300,costMicros:0},limits:{steps:1,tokens:300,costMicros:0}};
  async function start(runId:string,reviewed=true,capacity=false){
    const key={...scope,runId},run=await store.start({...key,briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest,source:upstream.descriptor,execution});
    const output=outputFor(brief.episodeCount,run.source.references[0]!.id,capacity),registry=new MethodRegistry(),method=registry.register(createOutlineMethodPack());
    const session=new ModelSession(new OpenAiCompatibleLlm({async exchange(){calls++;return {status:200,contentType:'application/json',body:{kind:'json',value:{id:'outline-identities',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:150,completion_tokens:80}}}};}},{model:'fixture-outline-identities',structuredOutput:'json_schema'}),{tenantId:scope.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:execution.modelIdentity,evidence:'synthetic_replay',maxCalls:1,maxInputBytes:2097152,maxOutputBytes:524288,timeoutMs:2000});
    const candidate=await generateOutline({brief,source:run.source,method,runner:new MethodRunner(registry,[createStructuredGenerationExecutor(session)]),context:{tenantId:scope.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,idempotencyKey:outlineCallId(key),signal:new AbortController().signal}});await store.saveCandidate(key,candidate);
    const host={...scope,actor:{kind:'human' as const,id:'registry-editor'},at:'2026-11-18T05:00:00.000Z',authorize:()=>true};
    const edited=structuredClone(candidate.output);edited.adaptation.title='实际PG人工修改的大纲';
    const report=reviewOutlineCraft(outlineContext(brief,run.source),edited,brief.thresholds);
    const review=reviewed?await store.review(key,{candidateDigest:candidate.digest,output:edited,ablations:[{genre:'suspense',judgment:'participates',reason:'模拟人工确认辅助轴参与主线。'}],waivers:report.issues.filter(row=>row.code!=='ABLATION_REVIEW').map(row=>({issueId:row.id,reason:'人工逐项确认保留。'}))},host):null;
    const progress=await store.read(key),source=review?outlineAdoptionSource(key,progress):{...key,runDigest:run.digest,briefDigest:brief.digest,candidateDigest:candidate.digest,reviewDigest:'f'.repeat(64),sourceDigest:run.source.digest};
    return {key,run,source,progress,review,candidate};
  }
  const initial=await start('outline',options.review!==false,options.capacity===true);
  async function next(runId:string,count:number){brief=(await store.putBrief({...put,expectedRevision:brief.revision,episodeCount:count,paidEpisodeNumbers:[count]})).brief;return start(runId);}
  return {...initial,scope,target,store,upstream,put,next,calls:()=>calls};
}
