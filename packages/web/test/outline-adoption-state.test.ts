import {expect,it,vi} from 'vitest';
import {OutlineRunViewSchema} from '@camery/script/outline/http';
import type {OutlineRunView} from '@camery/script/outline/http';
import {captureRuleThresholds,reviewOutlineCraft} from '@camery/script/outline';
import type {OutlineReceipt} from '@camery/ir/outline-adoption';
import {outlineFixture} from '../../script/test/outline-support.js';
import {OutlineActionJournal,OutlineActionJournalError,outlineAdoptionSource,outlineDecisionFeedback,type OutlineAction} from '../src/OutlineAdoptionState.js';

const scope={tenantId:'tenant',userId:'writer',projectId:'project'},candidateId='01ARZ3NDEKTSV4RRFFQ69G5FAV',otherCandidateId='01ARZ3NDEKTSV4RRFFQ69G5FAW',hash='a'.repeat(64),at='2026-11-18T10:00:00.000Z';
const expectation={expectedSnapshotRevision:2,expectedWriteVersion:3};
const prepare=():Extract<OutlineAction,{kind:'prepare'}>=>({kind:'prepare',runId:'outline-run',command:{applicationId:'prepare-one',...expectation,runDigest:hash,briefDigest:hash,candidateDigest:hash,reviewDigest:hash,sourceDigest:hash}});
function storage(){const values=new Map<string,string>();return {values,getItem:vi.fn((key:string)=>values.get(key)??null),setItem:vi.fn((key:string,value:string)=>{values.set(key,value);}),removeItem:vi.fn((key:string)=>{values.delete(key);})};}
function saved(store:ReturnType<typeof storage>){return [...store.values.values()][0]!;}
function seed(store:ReturnType<typeof storage>,value:string){store.values.set([...store.values.keys()][0]!,value);}
function fixture(){const store=storage(),journal=new OutlineActionJournal(scope,store);return {store,journal};}
function reviewed():OutlineRunView{
  const f=outlineFixture(),{sourceRefIds,...context}=f.context,report=reviewOutlineCraft(f.context,f.output);
  return OutlineRunViewSchema.parse({runId:'outline-run',runDigest:hash,briefId:'brief',briefRevision:1,createdAt:at,candidateDigest:hash,reviewStatus:'reviewed',sourceChanged:false,state:'reviewed',task:null,
    brief:{version:1,briefId:'brief',revision:1,notes:'独立的人审大纲',...context,thresholds:captureRuleThresholds(),profiles:[{id:f.context.mainGenre,version:1,digest:hash}],digest:hash},
    source:{version:1,descriptor:{kind:'development',runId:'source',runDigest:hash,briefDigest:hash,foundationReviewDigest:hash,episodesReviewDigest:hash},material:{title:'不写入浏览器的来源正文'},references:sourceRefIds.map(id=>({id,path:id})),digest:hash},
    candidate:{digest:hash,output:f.output,report},review:{status:'reviewed',digest:hash,candidateDigest:hash,actorId:'reviewer',at,output:f.output,report,ablations:[],waivers:[]}});
}
function receipt():OutlineReceipt{return {contractVersion:1,projectKey:scope.projectId,candidateId,kind:'decision',requestId:'decision',status:'adopted',snapshotRevision:3,writeVersion:5,issueCount:0,warningCount:2,adoption:{change_set_id:candidateId,actor_id:otherCandidateId,scope:{kind:'project',id:candidateId},from_revision:2,to_revision:3,at},rejection:null};}

it('persists one exact bounded request before dispatch and restores it across a new component lifetime',()=>{
  const {store,journal}=fixture(),action=prepare(),pending=journal.begin(action);expect(store.setItem).toHaveBeenCalledTimes(1);expect(store.getItem).toHaveBeenCalled();
  action.command.expectedWriteVersion=99;expect(pending.command.expectedWriteVersion).toBe(3);expect(Object.isFrozen(pending)).toBe(true);expect(Object.isFrozen(pending.command)).toBe(true);
  expect(new OutlineActionJournal(scope,store).read()).toEqual(pending);expect(new TextEncoder().encode(saved(store)).length).toBeLessThanOrEqual(16384);
  const same=journal.begin(structuredClone(pending));expect(same).toEqual(pending);expect(store.setItem).toHaveBeenCalledTimes(1);
  expect(saved(store)).not.toContain('material');expect(saved(store)).not.toContain('token');expect(saved(store)).not.toContain('output');
});
it.each(['userId','tenantId','projectId'] as const)('isolates pending commands by actual %s',field=>{const {store,journal}=fixture();journal.begin(prepare());const other=new OutlineActionJournal({...scope,[field]:'other'},store);expect(other.read()).toBeNull();other.begin({...prepare(),runId:'other-run'});expect(journal.read()).toEqual(prepare());expect(store.values.size).toBe(2);});
it('refuses another action or changed CAS while an unknown result remains and only clears the matching request',()=>{
  const {store,journal}=fixture(),first=journal.begin(prepare()),changed={...prepare(),command:{...prepare().command,expectedWriteVersion:7}};
  expect(()=>journal.begin(changed)).toThrowError(expect.objectContaining({code:'PENDING_ACTION'}));expect(()=>journal.complete(changed)).toThrowError(expect.objectContaining({code:'PENDING_ACTION'}));expect(journal.read()).toEqual(first);
  expect(()=>journal.begin({kind:'adopt',candidateId,requestId:'other',command:expectation})).toThrowError(expect.objectContaining({code:'PENDING_ACTION'}));
  journal.complete(first);expect(journal.read()).toBeNull();expect(store.removeItem).toHaveBeenCalledTimes(1);journal.complete(first);expect(store.removeItem).toHaveBeenCalledTimes(1);
});
it.each<OutlineAction>([
  {kind:'upgrade',command:{applicationId:'upgrade-one',...expectation}},
  {kind:'adopt',candidateId,requestId:'adopt-one',command:expectation},
  {kind:'reject',candidateId,requestId:'reject-one',command:{...expectation,reason:'需要保留原来的明确拒绝理由。'}},
  {kind:'upgrade-adopt',candidateId,requestId:'upgrade-adopt',command:{...expectation,scope:{kind:'project',id:candidateId}}},
  {kind:'upgrade-reject',candidateId,requestId:'upgrade-reject',command:{...expectation,scope:{kind:'project',id:candidateId},reason:'此升级需要重新核对。'}},
])('round-trips only the strict small $kind command',action=>{const {store,journal}=fixture();expect(journal.begin(action)).toEqual(action);expect(new OutlineActionJournal(scope,store).read()).toEqual(action);journal.complete(action);expect(journal.read()).toBeNull();});
it('captures the scope before callers can reassign it and keeps delimiter-containing namespaces distinct',()=>{
  const store=storage(),owner={...scope},journal=new OutlineActionJournal(owner,store);owner.userId='different';journal.begin(prepare());expect(new OutlineActionJournal(scope,store).read()).toEqual(prepare());
  const one=new OutlineActionJournal({tenantId:'a:b',userId:'c',projectId:'d'},store),two=new OutlineActionJournal({tenantId:'a',userId:'b:c',projectId:'d'},store);one.begin(prepare());expect(two.read()).toBeNull();
});
it.each(['extra','candidate','request','scope','command','oversize','accessor','proxy','array'] as const)('refuses unsafe %s data before writing browser state',kind=>{
  const {store,journal}=fixture(),getter=vi.fn(()=>hash);let action:unknown=prepare();
  if(kind==='extra')action={...prepare(),credential:'private'};if(kind==='candidate')action={kind:'adopt',candidateId:'slug',requestId:'adopt',command:expectation};if(kind==='request')action={kind:'adopt',candidateId,requestId:'bad key',command:expectation};if(kind==='scope')action={kind:'upgrade-adopt',candidateId,requestId:'adopt',command:{...expectation,scope:{kind:'project',id:'slug'}}};if(kind==='command')action={...prepare(),command:{...prepare().command,actorId:'forged'}};if(kind==='oversize')action={...prepare(),command:{...prepare().command,sourceDigest:'x'.repeat(20000)}};if(kind==='accessor')action=Object.defineProperty(prepare(),'runId',{get:getter,enumerable:true});if(kind==='proxy')action=new Proxy({},{ownKeys(){throw new Error('private proxy');}});if(kind==='array')action=[];
  expect(()=>journal.begin(action as OutlineAction)).toThrowError(expect.objectContaining({code:'INVALID_ACTION'}));expect(store.setItem).not.toHaveBeenCalled();expect(getter).not.toHaveBeenCalled();
});
it.each(['extra','scope','json','null','oversize','nonstring','version','action'] as const)('keeps corrupt %s stored state intact and reports a safe error',kind=>{
  const {store,journal}=fixture();journal.begin(prepare());const original=JSON.parse(saved(store)) as Record<string,unknown>;
  let raw=saved(store);if(kind==='extra')raw=JSON.stringify({...original,token:'private'});if(kind==='scope')raw=JSON.stringify({...original,scope:{...scope,userId:'other'}});if(kind==='json')raw='private invalid JSON';if(kind==='null')raw='null';if(kind==='oversize')raw='x'.repeat(16385);if(kind==='version')raw=JSON.stringify({...original,version:99});if(kind==='action')raw=JSON.stringify({...original,action:{kind:'adopt',candidateId:'slug'}});
  seed(store,raw);if(kind==='nonstring')store.getItem.mockReturnValueOnce({private:true} as never);
  let failure:unknown;try{journal.read();}catch(error){failure=error;}expect(failure).toBeInstanceOf(OutlineActionJournalError);expect(failure).toMatchObject({code:'JOURNAL_CORRUPT'});expect(String(failure)).not.toContain('private');expect(store.removeItem).not.toHaveBeenCalled();expect(saved(store)).toBe(raw);
});
it.each(['get','set','remove'] as const)('redacts %s storage failures and never dispatches an unretained operation',kind=>{
  const {store,journal}=fixture();if(kind==='remove')journal.begin(prepare());const error=new Proxy({},{getPrototypeOf(){throw new Error('private storage prototype');}});
  if(kind==='get')store.getItem.mockImplementationOnce(()=>{throw error;});if(kind==='set')store.setItem.mockImplementationOnce(()=>{throw new Error('private quota error');});if(kind==='remove')store.removeItem.mockImplementationOnce(()=>{throw error;});
  let failure:unknown;try{if(kind==='remove')journal.complete(prepare());else journal.begin(prepare());}catch(error){failure=error;}expect(failure).toMatchObject({code:'JOURNAL_UNAVAILABLE'});expect(String(failure)).not.toContain('private');
});
it('requires durable readback and does not replace a different record that appears during persistence',()=>{
  const {store,journal}=fixture();store.setItem.mockImplementationOnce(()=>{});expect(()=>journal.begin(prepare())).toThrowError(expect.objectContaining({code:'JOURNAL_UNAVAILABLE'}));
  journal.begin(prepare());const newer={...prepare(),runId:'newer'};store.setItem([...store.values.keys()][0]!,JSON.stringify({version:1,scope,action:newer}));expect(()=>journal.complete(prepare())).toThrowError(expect.objectContaining({code:'PENDING_ACTION'}));expect(journal.read()).toEqual(newer);
});
it('keeps a different request written during persistence instead of claiming that the original was retained',()=>{
  const {store,journal}=fixture(),newer={...prepare(),runId:'newer'};store.setItem.mockImplementationOnce((key,value)=>{const parsed=JSON.parse(value) as Record<string,unknown>;store.values.set(key,JSON.stringify({...parsed,action:newer}));});
  expect(()=>journal.begin(prepare())).toThrowError(expect.objectContaining({code:'PENDING_ACTION'}));expect(journal.read()).toEqual(newer);expect(store.removeItem).not.toHaveBeenCalled();
});
it('detects silent removal failure and refuses malformed completion without erasing the pending identity',()=>{
  const {store,journal}=fixture(),action=journal.begin(prepare());store.removeItem.mockImplementationOnce(()=>{});expect(()=>journal.complete(action)).toThrowError(expect.objectContaining({code:'JOURNAL_UNAVAILABLE'}));expect(journal.read()).toEqual(action);
  const malformed:unknown={...action,credential:'private'};store.removeItem.mockClear();expect(()=>journal.complete(malformed as OutlineAction)).toThrowError(expect.objectContaining({code:'INVALID_ACTION'}));expect(store.removeItem).not.toHaveBeenCalled();expect(journal.read()).toEqual(action);
});
it('bounds actual UTF-8 stored bytes instead of permitting a multibyte body by code-unit length',()=>{
  const {store,journal}=fixture();journal.begin(prepare());const raw='"'+'界'.repeat(6000)+'"';expect(raw.length).toBeLessThan(16384);expect(new TextEncoder().encode(raw).length).toBeGreaterThan(16384);seed(store,raw);expect(()=>journal.read()).toThrowError(expect.objectContaining({code:'JOURNAL_CORRUPT'}));expect(store.removeItem).not.toHaveBeenCalled();
});
it.each(['tenantId','userId','projectId'] as const)('refuses stored %s substitution even when it was placed under the active scope key',field=>{
  const {store,journal}=fixture();journal.begin(prepare());seed(store,JSON.stringify({version:1,scope:{...scope,[field]:'foreign'},action:prepare()}));expect(()=>journal.read()).toThrowError(expect.objectContaining({code:'JOURNAL_CORRUPT'}));expect(store.removeItem).not.toHaveBeenCalled();
});
it('refuses invalid scope metadata without invoking accessors',()=>{const store=storage(),getter=vi.fn(()=>scope.userId);expect(()=>new OutlineActionJournal(Object.defineProperty({...scope},'userId',{get:getter,enumerable:true}),store)).toThrowError(expect.objectContaining({code:'INVALID_ACTION'}));expect(getter).not.toHaveBeenCalled();expect(store.getItem).not.toHaveBeenCalled();});

it('derives exact preparation pins only from a current internally consistent reviewed run',()=>{const run=reviewed();expect(OutlineRunViewSchema.safeParse(run).success).toBe(true);expect(outlineAdoptionSource(run)).toEqual({runDigest:hash,briefDigest:hash,candidateDigest:hash,reviewDigest:hash,sourceDigest:hash});expect(Object.isFrozen(outlineAdoptionSource(run))).toBe(true);});
it.each(['changed','candidate','review','review-state','review-kind','state','review-candidate','top-candidate','hash'] as const)('refuses %s source evidence instead of treating a candidate as adopted or reviewed',kind=>{
  const run=reviewed();if(kind==='changed')run.sourceChanged=true;if(kind==='candidate')run.candidate=null;if(kind==='review')run.review=null;if(kind==='review-state')run.reviewStatus='rejected';if(kind==='review-kind')run.review={status:'rejected',digest:hash,candidateDigest:hash,actorId:'reviewer',at,reason:'尚需修改'};if(kind==='state')run.state='reconciling';if(kind==='review-candidate'&&run.review?.status==='reviewed')run.review.candidateDigest='b'.repeat(64);if(kind==='top-candidate')run.candidateDigest='b'.repeat(64);if(kind==='hash')run.source.digest='not-a-digest';expect(outlineAdoptionSource(run)).toBeNull();
});
it('distinguishes audited decisions from rejected attempts and preserves complete message counts',()=>{
  const adopted=receipt();expect(outlineDecisionFeedback('adopt',adopted)).toMatchObject({success:true,message:'已采用到正式大纲。',error:null,issueCount:0,warningCount:2});
  const rejected={...adopted,status:'rejected' as const,adoption:null,rejection:{actor_id:otherCandidateId,reason:'需要重新核对',at}};expect(outlineDecisionFeedback('reject',rejected)).toMatchObject({success:true,error:null});
  for(const failed of [{...adopted,issueCount:1},{...adopted,adoption:null},{...adopted,kind:'preparation' as const},{...adopted,status:'conflicted' as const},{...adopted,status:'unchanged' as const},rejected])expect(outlineDecisionFeedback('adopt',failed)).toMatchObject({success:false,message:null,error:expect.stringContaining('本次采用未完成')});
  expect(outlineDecisionFeedback('reject',{...rejected,rejection:null})).toMatchObject({success:false,message:null});expect(outlineDecisionFeedback('reject',adopted)).toMatchObject({success:false,message:null});
});
