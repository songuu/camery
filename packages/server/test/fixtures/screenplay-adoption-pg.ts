import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {upgradeV05Package,upgradeV06Package,upgradeV07Package} from '@camery/ir';
import {PostgresVersionStore} from '@camery/versioning/node';
import {PostgresOutlineStore,outlineCallId,outlineAdoptionSource,createOutlineSourceGuard,prepareOutlineMappingDraft,finalizeOutlineChangeSet} from '@camery/script/outline/node';
import {PostgresScreenplayStore,createScreenplayCandidate} from '@camery/script/screenplay/node';
import {fixtureId as id,makePackage} from '../../../ir/test/fixtures.js';
import {createDevelopmentSourceFixture,createOutlineProposal} from '../../../script/test/outline-source-pg-support.js';
import {screenplayFixture} from '../../../script/test/screenplay-support.js';
import {ProjectIdentityRegistrar,PostgresProjectIdentityStore} from '../../src/projects/identity-map.js';
import {PostgresScreenplayProjectIntents} from '../../src/projects/screenplay-intent-store.js';
import {PostgresScreenplayAdoptionSource} from '../../src/projects/screenplay-adoption-source.js';
import {ScreenplayAdoptionApplication} from '../../src/projects/screenplay-adoption-application.js';

/** Synthetic writing only; all source reviews, snapshots, identities and native proofs below use real PG. */
export async function screenplayAdoptionPgFixture(pool:Pool,lineCount?:number){
  const tag=randomUUID(),scope={tenantId:'screenplay-host-'+tag,projectId:'project'},upstream=await createDevelopmentSourceFixture(pool,scope),outline=new PostgresOutlineStore(pool),key={...scope,runId:'outline'};
  const put={...scope,briefId:'outline',expectedRevision:0,actorId:'editor',notes:'核对完整分集来源。',episodeCount:3,targetSeconds:90,paidEpisodeNumbers:[3],mainGenre:'rebirth-revenge',auxiliaryGenres:['suspense']};
  const brief=(await outline.putBrief(put)).brief,execution={connectionId:'outline-source-fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture/outline',evidence:'synthetic_replay',modelTier:'balanced',currency:'CNY',reservation:{tokens:300,costMicros:0},limits:{steps:1,tokens:300,costMicros:0}};
  const run=await outline.start({...key,briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest,source:upstream.descriptor,execution}),proposal=await createOutlineProposal(run.source,{brief,callId:outlineCallId(key)});
  await outline.saveCandidate(key,proposal.candidate);const review=await outline.review(key,{candidateDigest:proposal.candidate.digest,output:proposal.output,ablations:proposal.review.ablations,waivers:proposal.review.waivers},proposal.host),progress=await outline.read(key),source=outlineAdoptionSource(key,progress);
  const head=upgradeV07Package(upgradeV06Package(upgradeV05Package(makePackage())));for(const [field,value] of Object.entries(head))if(Array.isArray(value))(head as unknown as Record<string,unknown>)[field]=[];
  head.project.id=id(tag);head.project.source_ids=[];head.project.rights_status='unknown';head.project.scope={label:'SC共享定稿宿主真实PG',expected_episode_count:0,expected_scene_count:0,expected_required_beat_count:0};
  const target={tenantId:id(tag+'-tenant'),projectId:head.project.id},outlineActor={kind:'user' as const,id:id(tag+'-outline-editor')},locals=(group:string,rows:readonly {id:string}[])=>rows.map(row=>({localId:row.id,id:id(tag+group+row.id)}));
  const identities={...scope,target,owner:{runId:run.runId,runDigest:run.digest},planId:id(tag+'-plan'),characters:locals('char',review.output.characters),beats:locals('beat',review.output.beats),episodes:review.output.episodes.map(row=>({number:row.number,episodeId:id(tag+'-episode-'+row.number),planId:id(tag+'-ep-plan-'+row.number)})),assets:locals('asset',review.output.assets),plotUnits:locals('unit',review.output.plotUnits),decisions:locals('decision',review.output.adaptation.decisions)};
  const draft=prepareOutlineMappingDraft({progress,source,identities,reviewer:{key:review.actorId,id:outlineActor.id},head}),request=finalizeOutlineChangeSet({draft,changeSetId:id(tag+'-outline-change'),author:outlineActor,operationIds:draft.operations.map(row=>({slot:row.slot,id:id(tag+'outline-op-'+row.slot)}))}),versions=new PostgresVersionStore(pool);
  await versions.initialize(target,head);const pending=await versions.submit(target,request),adopted=await versions.adoptGuarded(target,request.id,{actor:outlineActor,scope:{kind:'project',id:target.projectId},at:proposal.host.at,authorize:()=>true,expectation:{expectedSnapshotRevision:pending.state.head.revision.number,expectedWriteVersion:pending.writeVersion}},createOutlineSourceGuard(outline,source));if(adopted.status!=='adopted')throw new Error('Actual fixture Outline adoption failed');
  const domainHost={scope,actor:{kind:'human' as const,id:'editor'},at:'2026-11-20T09:00:00.000Z',authorize:()=>true},scripts=new PostgresScreenplayStore(pool,outline),rules=screenplayFixture().context.rules,episodeId=identities.episodes[0]!.episodeId;
  const view=await scripts.describeSource({scope,target,episodeId,rules},domainHost),script=structuredClone(screenplayFixture().draft),speaker=view.context.characters[0]!.id;
  script.episodeId=episodeId;script.scenes[0]!.characterIds=[speaker];script.openingHook!.type=view.context.outline.openingHook.type;script.closingHook!.type=view.context.outline.cliffhanger.type;
  for(const beat of script.scenes[0]!.beats){beat.outlineBeatIds=view.context.outline.beats.map(row=>row.ref.id);for(const line of beat.lines)line.speakerId=speaker;}
  if(lineCount!==undefined){const spoken=script.scenes[0]!.beats.find(beat=>beat.lines.length>0)!;const template=spoken.lines[0]!;spoken.lines=Array.from({length:lineCount},(_,index)=>({...template,id:'capacity-line-'+index,text:'核对线索。'}));}
  const evidence={event:{kind:'beat' as const,id:'action-0'},quote:script.scenes[0]!.beats[0]!.summary};
  script.continuity=[{id:'assert-note',op:'assert_fact',factId:'note',kind:'fact',text:'逐字核对的事实。',evidence},{id:'learn-note',op:'learn',characterId:speaker,factId:'note',source:{kind:'witness'},evidence},{id:'state-note',op:'set_character',value:{characterId:speaker,summary:'核对线索后继续追查。',appearance:null,spot:null,holding:[]},evidence},{id:'plant-origin',op:'plant',threadId:'origin',summary:'线索的来处。',payoffEpisodeId:identities.episodes[1]!.episodeId,evidence}];
  const sourceKey={...scope,candidateId:'screenplay'},prepared=await scripts.prepare({key:sourceKey,target,expectedSnapshotRevision:view.source.native.snapshotRevision,expectedPackageDigest:view.source.native.packageDigest,rules,draft:script},domainHost),check=createScreenplayCandidate(scope,view.context,script);
  const reviewed=await scripts.review(sourceKey,{candidateDigest:prepared.preparation.candidate.digest,draft:script,waivers:check.issues.filter(row=>row.severity==='warning').map(row=>({issueId:row.id,reason:'明确的合成验收逐项豁免。'}))},domainHost);
  const registrar=new ProjectIdentityRegistrar(pool);await registrar.registerTenant({tenantId:scope.tenantId,irTenantId:target.tenantId});await registrar.registerProject({...scope,irProjectId:target.projectId});
  const principals={operator:{kind:'user' as const,id:id(tag+'-operator')},other:{kind:'user' as const,id:id(tag+'-other')}};
  for(const [key,principal] of Object.entries(principals))await registrar.registerPrincipal({tenantId:scope.tenantId,kind:'user',key,irActorId:principal.id});
  const mapped=new PostgresProjectIdentityStore(pool),intents=new PostgresScreenplayProjectIntents(pool),reader=new PostgresScreenplayAdoptionSource({pool,scripts,outline});let allocations=0;
  const newId=()=>{allocations++;return id(randomUUID());},options={tenantId:scope.tenantId,identities:mapped,versions,intents,source:reader,scripts,newId,now:()=> '2026-11-20T09:00:00.000Z'},application=new ScreenplayAdoptionApplication(options);
  const command={applicationId:'finalization',sourceCandidateId:sourceKey.candidateId,preparationDigest:reviewed.preparation.digest,reviewDigest:reviewed.review!.digest,expectedSnapshotRevision:adopted.state.head.revision.number,expectedWriteVersion:adopted.writeVersion};
  return {scope,target,sourceKey,reviewed,principals,mapped,intents,reader,scripts,outline,versions,options,application,command,put,newId,allocations:()=>allocations};
}
