import {expect,it} from 'vitest';
import {createVersionState,submitChangeSet,adoptChangeSet} from '@camery/versioning';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';
import {ChangeSetV06,SCHEMA_VERSION} from '@camery/ir';
import {projectCandidateDetail,projectPreview} from '../src/projects/projection.js';
import type {CandidateIntent,ProjectActionReceipt} from '../src/projects/intent-contracts.js';
import {mappingFixture} from '../../script/test/development-mapping-fixture.js';
function command(){return changeSet([{op:'update',op_id:id('projection-op'),collection:'shots',target:id('sh_1'),set:{action:'候选动作'}}],{id:id('projection-change'),base_revisions:[{id:id('sh_1'),version:1}]});}
function intent():CandidateIntent{const request=command();return {version:1,scope:{tenantId:'tenant',projectId:'project'},applicationId:'application',actor:{kind:'user',key:'editor',id:request.author.id},target:{tenantId:id('tenant'),projectId:id('prj_demo')},commandDigest:'a'.repeat(64),source:{kind:'manual'},expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1},changeId:request.id,request,digest:'b'.repeat(64),businessDigest:'c'.repeat(64),createdAt:'2026-11-17T06:00:00.000Z'};}
function options(){const request=intent();return {projectKey:'project',state:submitChangeSet(createVersionState(makePackage()),request.request).state,writeVersion:2,candidateId:request.changeId,intent:request,preparation:null,canReview:true};}
it('projects the historical candidate baseline rather than treating later head changes as deletions or candidate content',()=>{
  const context=options();const old=structuredClone(context.state);const newer=submitChangeSet(context.state,changeSet([{op:'update',op_id:id('newer-op'),collection:'shots',target:id('sh_2'),set:{action:'后来正式采用'}}],{id:id('newer-change'),base_revisions:[{id:id('sh_2'),version:5}]}));
  context.state=adoptChangeSet(newer.state,id('newer-change'),{actor:{kind:'user',id:id('reviewer')},scope:{kind:'project',id:id('prj_demo')},at:'2026-11-17T07:00:00.000Z',authorize:()=>true}).state;
  const result=projectCandidateDetail(context);expect(result.status).toBe('candidate');expect(result.differences).toHaveLength(1);expect(result.differences[0]).toMatchObject({collection:'shots',id:id('sh_1'),kind:'replace',after:{action:'候选动作'}});expect(result.differences[0]!.before).toEqual(old.head.shots.find(row=>row.id===id('sh_1')));expect(result.canAdopt).toBe(true);expect(context.state.head.shots.find(row=>row.id===id('sh_2'))?.action).toBe('后来正式采用');
});
it('attributes an adopted change only to its actual adoption base when another candidate was adopted first',()=>{
  const context=options();const other=submitChangeSet(context.state,changeSet([{op:'update',op_id:id('adopted-other-op'),collection:'shots',target:id('sh_2'),set:{action:'另一候选的正式修改'}}],{id:id('adopted-other'),base_revisions:[{id:id('sh_2'),version:5}]}));
  const authority={actor:{kind:'user' as const,id:id('reviewer')},scope:{kind:'project' as const,id:id('prj_demo')},at:'2026-11-17T07:00:00.000Z',authorize:()=>true};
  const first=adoptChangeSet(other.state,id('adopted-other'),authority);const second=adoptChangeSet(first.state,context.candidateId,authority);expect(second.status).toBe('adopted');
  const detail=projectCandidateDetail({...context,state:second.state,writeVersion:5});expect(detail.differences.map(row=>row.id)).toEqual([id('sh_1')]);expect(detail.differences[0]!.after).toMatchObject({action:'候选动作'});
});
it('exposes native candidates without inventing source authority and never adopts a merely prepared intent',()=>{
  const context=options();const native=projectCandidateDetail({...context,intent:null});expect(native).toMatchObject({managed:false,applicationId:null,source:{kind:'unmanaged'},canAdopt:false,canReject:false,blockingReasons:['SOURCE_POLICY_MISSING']});
  const prepared=projectCandidateDetail({...context,state:createVersionState(makePackage())});expect(prepared).toMatchObject({status:'prepared',canAdopt:false,canReject:false,baseWriteVersion:1,differences:[]});
  expect(()=>projectCandidateDetail({...context,candidateId:id('missing'),intent:null})).toThrowError(expect.objectContaining({code:'NOT_FOUND'}));
});
it('uses verified development intent metadata and fails closed on unavailable source while preserving rejection',async()=>{
  const f=await mappingFixture();const context=options();const source={kind:'development' as const,mapperVersion:1 as const,source:f.source,identities:f.identities,reviewers:f.reviewers};const development={...context.intent!,source};
  const unavailable=projectCandidateDetail({...context,intent:development});expect(unavailable).toMatchObject({source:{kind:'development',runId:f.source.runId,state:'unavailable'},canAdopt:false,canReject:true});expect(unavailable.blockingReasons).toContain('SOURCE_UNAVAILABLE');
  expect(projectCandidateDetail({...context,intent:development,sourceState:'current'}).canAdopt).toBe(true);expect(projectCandidateDetail({...context,intent:development,sourceState:'stale'}).canAdopt).toBe(false);
  const receipt:ProjectActionReceipt={version:1,changeId:context.candidateId,status:'unchanged',snapshotRevision:5,writeVersion:2,issues:[],warnings:[],adoption:null,rejection:null};
  expect(projectCandidateDetail({...context,state:createVersionState(makePackage()),intent:{...development,request:null},preparation:receipt,sourceState:'current'})).toMatchObject({status:'unchanged',canAdopt:false,canReject:false,differences:[],preparation:receipt});
});
it('shows an explicit schema transition even when an upgrade changes no content objects',()=>{
  const state=createVersionState(makePackage());const request=ChangeSetV06.parse({...changeSet([]),schema_version:SCHEMA_VERSION,id:id('upgrade-projection'),ops:[{op:'upgrade_schema',op_id:id('upgrade-op'),from:'0.5.0-draft',to:SCHEMA_VERSION}]});const result=submitChangeSet(state,request);const projected=projectPreview({state,writeVersion:1,result});
  expect(projected.differences).toContainEqual({collection:'projects',id:state.head.project.id,kind:'replace',before:{schema_version:'0.5.0-draft'},after:{schema_version:SCHEMA_VERSION}});expect(projected.status).toBe('candidate');expect(projected.snapshotRevision).toBe(5);
});
it('returns preview failures without fabricating a candidate or mutating the live state',()=>{
  const state=createVersionState(makePackage());const before=structuredClone(state);const result=submitChangeSet(state,{});expect(projectPreview({state,writeVersion:1,result})).toMatchObject({status:'rejected',snapshotRevision:5,writeVersion:1,differences:[],issues:result.issues});expect(state).toEqual(before);
});
it('keeps complete differences when preview idempotently reuses an existing stored candidate',()=>{
  const context=options();const result=submitChangeSet(context.state,context.intent!.request);expect(result.state).toBe(context.state);
  const projected=projectPreview({state:context.state,writeVersion:2,result,candidateId:context.candidateId});expect(projected.differences).toHaveLength(1);expect(projected.differences[0]!.after).toMatchObject({action:'候选动作'});
});
it('refuses to present an already adopted request as a fresh preview',()=>{
  const context=options();const result=adoptChangeSet(context.state,context.candidateId,{actor:{kind:'user',id:id('reviewer')},scope:{kind:'project',id:id('prj_demo')},at:'2026-11-17T07:00:00.000Z',authorize:()=>true});expect(result.status).toBe('adopted');
  expect(()=>projectPreview({state:context.state,writeVersion:2,result,candidateId:context.candidateId})).toThrowError(expect.objectContaining({code:'CONFLICT'}));
});
it('rejects oversized differences rather than returning a misleading truncated review',()=>{
  const context=options();const preview=context.state.changes[0]!.preview!;preview.characters=Array.from({length:501},(_,index)=>({...preview.characters[0]!,id:id(`many-characters-${index}`)}));
  expect(()=>projectCandidateDetail(context)).toThrowError(expect.objectContaining({code:'INPUT_LIMIT'}));
});
