import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {adoptChangeSet,createVersionState,submitChangeSet} from '@camery/versioning';
import type {StoryboardPackage,StoryboardPackageV08} from '@camery/ir';
import {screenplayNativeFixture} from './screenplay-native-support.js';
import {captureContinuityContext} from '../src/continuity/context.js';
import {createContinuityCandidate} from '../src/continuity/node/candidate.js';
import {continuityDigest} from '../src/continuity/node/digest.js';
import type {ContinuityPrevious} from '../src/continuity/node/persistence-contracts.js';
import {createScreenplayCandidate,reviewScreenplayCandidate} from '../src/screenplay/node/review.js';
import {prepareScreenplayNativeMapping} from '../src/screenplay/node/native-mapping.js';
import {screenplayNativeAdoptionFacts} from '../src/screenplay/node/native-adoption.js';
import {readScreenplayNativeAdoption,readScreenplayHandoff} from '../src/screenplay/node/handoff.js';
import {SCREENPLAY_CANDIDATE_BYTES,SCREENPLAY_CONTEXT_BYTES,ScreenplayError} from '../src/screenplay/contracts.js';
import type {ScreenplaySourceView} from '../src/screenplay/node/source.js';

const ports=vi.hoisted(()=>({binding:vi.fn(),receipt:vi.fn(),current:vi.fn(),ledger:vi.fn()}));
vi.mock('../src/screenplay/node/native-records.js',async importOriginal=>({...await importOriginal<typeof import('../src/screenplay/node/native-records.js')>(),readScreenplayNativeBinding:ports.binding,readScreenplayNativeReceipt:ports.receipt}));
vi.mock('../src/screenplay/node/source.js',async importOriginal=>({...await importOriginal<typeof import('../src/screenplay/node/source.js')>(),readScreenplaySource:ports.current}));
vi.mock('../src/continuity/node/source.js',async importOriginal=>({...await importOriginal<typeof import('../src/continuity/node/source.js')>(),resolveContinuityNativePredecessor:ports.ledger}));
beforeEach(()=>{vi.clearAllMocks();ports.binding.mockReset();ports.receipt.mockReset();ports.current.mockReset();ports.ledger.mockReset().mockResolvedValue(null);});

/** Trusted protocol ports plus actual pure native adoption; separate PG tests establish SQL and role authority. */
async function fixture(fullLedger=false){
  const original=await screenplayNativeFixture(),draft=structuredClone(original.draft);
  if(fullLedger){const evidence={event:{kind:'beat' as const,id:draft.scenes[0]!.beats[0]!.id},quote:draft.scenes[0]!.beats[0]!.summary},characterId=draft.scenes[0]!.characterIds[0]!;
    draft.continuity=[{id:'fact',op:'assert_fact',factId:'note',kind:'fact',text:'场记确认的本集便签事实。',evidence},{id:'learn',op:'learn',characterId,factId:'note',source:{kind:'witness'},evidence},{id:'state',op:'set_character',value:{characterId,summary:'核对事实后继续行动。',appearance:null,spot:null,holding:[]},evidence},{id:'plant',op:'plant',threadId:'sender',summary:'追查便签寄件人。',payoffEpisodeId:null,evidence}];
  }
  const candidate=createScreenplayCandidate(original.scope,original.context,draft),review=reviewScreenplayCandidate(original.context,candidate,{candidateDigest:candidate.digest,draft,waivers:candidate.issues.filter(row=>row.severity==='warning').map(row=>({issueId:row.id,reason:'人工明确核对。'}))},original.host),mapping=prepareScreenplayNativeMapping({head:original.head,context:original.context,candidate,review,target:original.target,changeId:original.mapping.request.id,author:original.author,ids:original.ids});
  const command={key:original.key,target:original.target,expectedSnapshotRevision:original.head.revision.number,expectedPackageDigest:original.progress.preparation.source.native.packageDigest,rules:original.context.rules,draft,authorId:original.host.actor.id},preparationBody={...original.progress.preparation,candidate,commandDigest:continuityDigest(command,SCREENPLAY_CONTEXT_BYTES)};delete (preparationBody as {digest?:string}).digest;
  const progress={preparation:{...preparationBody,digest:continuityDigest(preparationBody,SCREENPLAY_CONTEXT_BYTES)},review,current:false};
  const body={version:1 as const,key:original.key,mapping,ids:original.ids},binding={...body,digest:continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)},pending=submitChangeSet(createVersionState(original.head),mapping.request);
  if(pending.status!=='candidate')throw new Error('Expected actual pure native screenplay candidate');
  const adopted=adoptChangeSet(pending.state,mapping.request.id,{actor:original.author,scope:{kind:'episode',id:original.context.episode.id},at:original.host.at,authorize:()=>true});if(adopted.status!=='adopted')throw new Error('Expected actual pure native locked screenplay');
  const receiptBody=screenplayNativeAdoptionFacts(binding,{...adopted,writeVersion:3}),receipt={...receiptBody,digest:continuityDigest(receiptBody,SCREENPLAY_CANDIDATE_BYTES)};
  const audit=adopted.state.adoptions.find(row=>row.change_set_id===mapping.request.id)!,change=adopted.state.changes.find(row=>row.request.id===mapping.request.id)!,ids=new Set(mapping.request.ops.flatMap(op=>op.op==='add'?[op.value['id']]:op.op==='lock'?[op.lock_id]:[]));
  const snapshots=new Map<number,StoryboardPackage>([[original.head.revision.number,structuredClone(original.head)],[receipt.toRevision,structuredClone(adopted.state.head)]]),rows={changes:[{status:change.status,record:structuredClone(change)}],adoptions:[{from_revision:String(audit.from_revision),to_revision:String(audit.to_revision),record:structuredClone(audit)}],objects:adopted.state.revisions.filter(row=>ids.has(row.object_id)).map(row=>({object_id:row.object_id,version:String(row.version),snapshot_revision:String(row.snapshot_revision),change_id:row.change_set_id,record:structuredClone(row)}))};
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    if(sql==='SHOW transaction_isolation')return {rows:[{transaction_isolation:'read committed'}]};
    if(sql.includes('FROM camery_versioning.snapshots')){const head=snapshots.get(Number(values[2]));return {rows:head?[{package:structuredClone(head)}]:[]};}
    if(sql.includes('FROM camery_versioning.changes'))return {rows:structuredClone(rows.changes)};
    if(sql.includes('FROM camery_versioning.adoptions'))return {rows:structuredClone(rows.adoptions)};
    if(sql.includes('FROM camery_versioning.object_revisions'))return {rows:structuredClone(rows.objects)};
    throw new Error('Unsupported screenplay handoff protocol statement');
  }),client={query} as unknown as PoolClient,store={readHistorical:vi.fn(async()=>progress),readForAdoption:vi.fn(async()=>({...progress,current:true}))},outline={readForAdoption:vi.fn()},grant=vi.fn(()=>true),host={...original.host,authorize:grant};
  function view(head:StoryboardPackage):ScreenplaySourceView{
    if(head.schema_version!=='0.7.0-draft'&&head.schema_version!=='0.8.0-draft')throw new Error('Expected supported writing head');
    const context={...structuredClone(original.context),schemaVersion:head.schema_version,snapshotRevision:head.revision.number,nativeContext:captureContinuityContext(head)},native={...progress.preparation.source.native,snapshotRevision:head.revision.number,packageDigest:continuityDigest(head,SCREENPLAY_CONTEXT_BYTES),contextDigest:continuityDigest(context.nativeContext,SCREENPLAY_CONTEXT_BYTES)};
    return {head:structuredClone(head),context,previous:null,source:{version:1,native,contextDigest:continuityDigest(context,SCREENPLAY_CONTEXT_BYTES)}};
  }
  const current=view(adopted.state.head);ports.binding.mockResolvedValue(binding);ports.receipt.mockResolvedValue(receipt);ports.current.mockImplementation(async()=>current);
  return {...original,draft,candidate,review,mapping,binding,receipt,progress,adopted,snapshots,rows,query,client,store,outline,grant,host,current,view,selection:{scope:original.scope,target:original.target,changeId:mapping.request.id}};
}
function readyLedger(f:Awaited<ReturnType<typeof fixture>>){
  let state=f.adopted.state;
  if(state.head.schema_version==='0.7.0-draft'){
    const request={schema_version:'0.8.0-draft',id:f.id('handoff-v08-upgrade'),base_revision:state.head.revision.number,author:f.author,status:'candidate',base_revisions:[],ops:[{op_id:f.id('handoff-v08-op'),op:'upgrade_schema',from:'0.7.0-draft',to:'0.8.0-draft'}]},pending=submitChangeSet(state,request),adopted=adoptChangeSet(pending.state,request.id,{actor:f.author,scope:{kind:'project',id:f.target.projectId},at:f.host.at,authorize:()=>true});
    if(adopted.status!=='adopted')throw new Error('Expected actual native v08 upgrade');state=adopted.state;
  }
  if(state.head.schema_version!=='0.8.0-draft')throw new Error('Expected native typed-ledger capacity');
  const head:StoryboardPackageV08=state.head,references=new Map(f.mapping.events.map(row=>[row.localId,row.ref])),draft={version:1 as const,episodeId:f.context.episode.id,events:f.review.output.draft.continuity.map(event=>({...event,evidence:{event:references.get(event.evidence.event.id)!,quote:event.evidence.quote}}))},candidate=createContinuityCandidate(f.scope,captureContinuityContext(head),draft);
  const pins=[...head.episodes,...head.characters,...head.scenes,...head.beats,...head.lines,...head.props,...head.appearances,...head.locations].map(row=>({id:row.id,version:row.version})),snapshot={id:f.id('handoff-ledger-snapshot'),version:1,episode_id:f.context.episode.id,based_on:pins,ledger:candidate.ledger},request={schema_version:'0.8.0-draft',id:f.id('handoff-ledger-change'),base_revision:head.revision.number,author:f.author,status:'candidate',base_revisions:pins,ops:[{op_id:f.id('handoff-ledger-op'),op:'add',collection:'continuity_snapshots',value:snapshot}]},pending=submitChangeSet(state,request),adopted=adoptChangeSet(pending.state,request.id,{actor:f.author,scope:{kind:'episode',id:f.context.episode.id},at:f.host.at,authorize:()=>true});
  if(adopted.status!=='adopted')throw new Error('Expected actual pure native ledger adoption');
  // The resolver mock represents separately verified human/PG provenance; native ledger object and adoption are real pure-engine results here.
  const body={version:2 as const,id:'handoff-ledger-candidate',scope:f.scope,target:f.target,snapshot:{id:snapshot.id,version:1},changeId:request.id,adoptedRevision:adopted.state.head.revision.number,ledger:snapshot.ledger,origin:{reviewDigest:'a'.repeat(64),bindingDigest:'b'.repeat(64)}},proof:Extract<ContinuityPrevious,{version:2}>={...body,digest:continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)};
  const current=f.view(adopted.state.head);ports.current.mockResolvedValue(current);ports.ledger.mockResolvedValue(proof);return {proof,current,state:adopted.state,candidate};
}

it('verifies the actual historical review, native versions, locks and human audit without claiming currentness',async()=>{
  const f=await fixture(),proof=await readScreenplayNativeAdoption(f.client,f.selection,f.store,f.host);expect(proof.receipt).toEqual(f.receipt);expect(proof.progress.current).toBe(false);expect(Object.hasOwn(proof,'current')).toBe(false);expect(Object.hasOwn(proof,'state')).toBe(false);
  expect(f.store.readHistorical).toHaveBeenCalledWith(f.client,f.key,expect.anything());expect(f.store.readForAdoption).not.toHaveBeenCalled();expect(ports.current).not.toHaveBeenCalled();expect(ports.ledger).not.toHaveBeenCalled();expect(Object.isFrozen(proof.receipt.actor)).toBe(true);
});

it('returns locked screenplay with a separately pending full four-ledger candidate using actual native evidence',async()=>{
  const f=await fixture(true),result=await readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host);expect(result.state).toBe('ledger_pending');expect(result.adopted).toBeNull();expect(result.script).toEqual(f.receipt);expect(result.timing).toEqual(f.review.output.timing);expect(result.lineBook).toEqual(f.review.output.lineBook);
  for(const key of ['facts','knowledge','characters','threads'] as const)expect(result.candidate.ledger[key]).toHaveLength(1);
  const actual=f.mapping.events.find(row=>row.localId===f.draft.scenes[0]!.beats[0]!.id)!.ref;expect(result.candidate.ledger.facts[0]!.introduced.evidence.event).toEqual(actual);expect(actual.id).not.toBe(f.review.output.continuity.ledger!.facts[0]!.introduced.evidence.event.id);expect(ports.ledger).toHaveBeenCalledWith(f.client,{scope:f.scope,target:f.target,episodeId:f.context.episode.id});
});
it.each(['repeatable read','serializable','read uncommitted'])('refuses caller-owned %s before claiming a current handoff',async isolation=>{
  const f=await fixture(true),original=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values=[])=>sql==='SHOW transaction_isolation'?{rows:[{transaction_isolation:isolation}]}:original(sql,values));
  await expect(readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host)).rejects.toMatchObject({code:'CONFLICT',path:'transaction_isolation'});expect(ports.current).not.toHaveBeenCalled();
});

it('permits the current v07-to-v08 upgrade and becomes ready only after separate complete-ledger adoption',async()=>{
  const f=await fixture(true),ready=readyLedger(f),result=await readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host);expect(result.state).toBe('handoff_ready');expect(result.adopted).toEqual(ready.proof);
  for(const key of ['facts','knowledge','characters','threads'] as const)expect(result.adopted!.ledger[key]).toEqual(result.candidate.ledger[key]);
  expect(result.script.toRevision).toBeLessThan(ready.proof.adoptedRevision);expect(result.adopted!.ledger.snapshotRevision).toBeLessThan(result.candidate.ledger.snapshotRevision);expect(result.timing).toEqual(f.review.output.timing);
});

it.each(['early-source','facts','knowledge','characters','threads'] as const)('rejects an adopted-ledger claim inconsistent with this exact screenplay: %s',async field=>{
    const f=await fixture(true),ready=readyLedger(f),proof=structuredClone(ready.proof);
    if(field==='early-source')proof.ledger.snapshotRevision=f.receipt.toRevision-1;else if(field==='facts')proof.ledger.facts[0]!.text='与定稿声明不一致的事实。';else if(field==='knowledge')proof.ledger.knowledge=[];else if(field==='characters')proof.ledger.characters[0]!.value.summary='另一套人物状态。';else proof.ledger.threads=[];
    ports.ledger.mockResolvedValue(proof);await expect(readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host)).rejects.toMatchObject({code:'CONFLICT',path:'adopted screenplay ledger'});
});

it.each(['binding','receipt'] as const)('refuses missing original native %s proof',async mode=>{
  const f=await fixture();ports[mode].mockResolvedValue(null);await expect(readScreenplayNativeAdoption(f.client,f.selection,f.store,f.host)).rejects.toMatchObject({code:'INCOMPLETE',path:'original proof'});expect(ports.current).not.toHaveBeenCalled();
});

it.each(['ordinary-scope','receipt-key','binding-digest','receipt-digest','review-digest','receipt-actor','receipt-time'] as const)('rejects inconsistent immutable proof %s',async field=>{
  const f=await fixture(),binding=structuredClone(f.binding),receipt=structuredClone(f.receipt);
  if(field==='ordinary-scope')binding.key.projectId='wrong-scope';else if(field==='receipt-key')receipt.key.candidateId='wrong-candidate';else if(field==='binding-digest')receipt.bindingDigest='b'.repeat(64);else if(field==='receipt-digest')receipt.digest='c'.repeat(64);else if(field==='review-digest')receipt.reviewDigest='d'.repeat(64);else if(field==='receipt-actor')receipt.actor.id=f.id('wrong-proof-actor');else receipt.at='2026-11-19T06:00:00.000Z';
  ports.binding.mockResolvedValue(binding);ports.receipt.mockResolvedValue(receipt);await expect(readScreenplayNativeAdoption(f.client,f.selection,f.store,f.host)).rejects.toMatchObject({code:'CONFLICT'});
});

it.each(['missing-snapshot','candidate-snapshot','revision','package','project','missing-change','change-status','missing-audit','from-column','to-column','object-id-column','object-version-column','object-revision-column','object-change-column'] as const)('checks native snapshot and SQL proof columns: %s',async field=>{
  const f=await fixture(),head=f.snapshots.get(f.receipt.toRevision)!;
  if(field==='missing-snapshot')f.snapshots.delete(f.receipt.toRevision);else if(field==='candidate-snapshot')head.revision.status='candidate';else if(field==='revision')head.revision.number++;else if(field==='package')head.package_id=f.id('wrong-native-package');else if(field==='project')head.project.id=f.id('wrong-native-project');else if(field==='missing-change')f.rows.changes=[];else if(field==='change-status')f.rows.changes[0]!.status='candidate';else if(field==='missing-audit')f.rows.adoptions=[];else if(field==='from-column')f.rows.adoptions[0]!.from_revision='999';else if(field==='to-column')f.rows.adoptions[0]!.to_revision='999';else if(field==='object-id-column')f.rows.objects[0]!.object_id=f.id('wrong-column-object');else if(field==='object-version-column')f.rows.objects[0]!.version='2';else if(field==='object-revision-column')f.rows.objects[0]!.snapshot_revision='999';else f.rows.objects[0]!.change_id=f.id('wrong-column-change');
  await expect(readScreenplayNativeAdoption(f.client,f.selection,f.store,f.host)).rejects.toMatchObject({code:'CONFLICT'});
});

it.each(['missing-lock','line-value','line-locked','collection','parent','object-version','object-revision','object-change','audit-scope','audit-from','audit-to','audit-actor','audit-time','request','duplicate-object'] as const)('rejects inconsistent native object/lock/audit history: %s',async field=>{
  const f=await fixture(),line=f.rows.objects.find(row=>row.record.collection==='lines')!,audit=f.rows.adoptions[0]!;
  if(field==='missing-lock')f.rows.objects=f.rows.objects.filter(row=>row.record.collection!=='locks');else if(field==='line-value')line.record.value={...line.record.value,text:'没有人审的历史改文。'};else if(field==='line-locked')line.record.value={...line.record.value,locked:false};else if(field==='collection')line.record.collection='beats';else if(field==='parent')line.record.parent_version=1;else if(field==='object-version'){line.version='2';line.record.version=2;}else if(field==='object-revision'){line.snapshot_revision='999';line.record.snapshot_revision=999;}else if(field==='object-change'){line.change_id=f.id('other-history-change');line.record.change_set_id=line.change_id;}else if(field==='audit-scope')audit.record.scope.id=f.id('wrong-audit-episode');else if(field==='audit-from'){audit.record.from_revision++;audit.from_revision=String(audit.record.from_revision);}else if(field==='audit-to'){audit.record.to_revision++;audit.to_revision=String(audit.record.to_revision);}else if(field==='audit-actor')audit.record.actor_id=f.id('wrong-audit-owner');else if(field==='audit-time')audit.record.at='2026-11-19T06:00:00.000Z';else if(field==='request')f.rows.changes[0]!.record.request.author.id=f.id('wrong-request-author');else f.rows.objects.push(structuredClone(line));
  await expect(readScreenplayNativeAdoption(f.client,f.selection,f.store,f.host)).rejects.toMatchObject({code:'CONFLICT'});
});

it.each(['line-text','line-lock','scene-body','lock-owner'] as const)('requires adopted snapshot %s to agree with its actual native object revisions',async field=>{
  const f=await fixture(),head=f.snapshots.get(f.receipt.toRevision)!;
  if(field==='line-text')head.lines[0]!.text='快照与原生对象历史不一致。';else if(field==='line-lock')head.lines[0]!.locked=false;else if(field==='scene-body')head.scenes[0]!.script_text='不属于人审结果的场景正文。';else head.locks[0]!.owner_id=f.id('wrong-snapshot-owner');
  await expect(readScreenplayNativeAdoption(f.client,f.selection,f.store,f.host)).rejects.toMatchObject({code:'CONFLICT'});
});

it.each(['scene','event'] as const)('rejects an unreviewed extra %s in the actual historical adopted snapshot',async kind=>{
  const f=await fixture(),head=f.snapshots.get(f.receipt.toRevision)!;
  if(kind==='scene'){head.scenes.push({...structuredClone(head.scenes[0]!),id:f.id('extra-history-scene'),order_key:'99999'});head.project.scope.expected_scene_count++;}
  else{head.beats.push({...structuredClone(head.beats[0]!),id:f.id('extra-history-event'),order_key:'99999'});head.project.scope.expected_required_beat_count++;}
  await expect(readScreenplayNativeAdoption(f.client,f.selection,f.store,f.host)).rejects.toMatchObject({code:'CONFLICT',path:'complete screenplay snapshot flow'});
});

it.each(['line-text','line-version','line-lock','beat-body','scene-body','lock-owner','lock-fields','lock-version'] as const)('rejects changed current locked screenplay %s',async field=>{
  const f=await fixture(),head=f.current.head;
  if(field==='line-text')head.lines[0]!.text='采用后的台词被另行改写。';else if(field==='line-version')head.lines[0]!.version++;else if(field==='line-lock')head.lines[0]!.locked=false;else if(field==='beat-body')head.beats[0]!.summary='采用后节拍变更。';else if(field==='scene-body')head.scenes[0]!.script_text='采用后的场次改文。';else if(field==='lock-owner')head.locks[0]!.owner_id=f.id('wrong-current-owner');else if(field==='lock-fields')head.locks[0]!.fields=[];else head.locks[0]!.version++;
  await expect(readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host)).rejects.toMatchObject({code:'CONFLICT'});
});

it('rejects an additional scene even when all originally mapped objects and current event refs remain unchanged',async()=>{
  const f=await fixture(),scene=f.current.head.scenes.find(row=>row.id===f.mapping.scenes[0]!.id)!;f.current.head.scenes.push({...structuredClone(scene),id:f.id('unmapped-current-scene'),order_key:'99999',script_text:'新增独立动作。'});f.current.head.project.scope.expected_scene_count++;
  await expect(readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host)).rejects.toMatchObject({code:'CONFLICT',path:'complete screenplay snapshot flow'});
});

it('rejects an additional actual native event without rewriting the locked original screenplay',async()=>{
  const f=await fixture(),beat=f.current.head.beats.find(row=>row.id===f.mapping.events.find(row=>row.ref.kind==='beat')!.ref.id)!;f.current.head.beats.push({...structuredClone(beat),id:f.id('unmapped-current-beat'),order_key:'99999',summary:'新增实际节拍。'});f.current.head.project.scope.expected_required_beat_count++;f.current.context.nativeContext=captureContinuityContext(f.current.head);
  await expect(readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host)).rejects.toMatchObject({code:'CONFLICT',path:'complete screenplay snapshot flow'});
});

it.each(['line','lock'] as const)('refuses a missing current actual %s instead of accepting a stale adoption flag',async kind=>{
  const f=await fixture(),line=f.mapping.locks[0]!.line.id,lock=f.mapping.locks[0]!.lock.id;
  f.current.head.locks=f.current.head.locks.filter(row=>row.id!==lock);if(kind==='line'){f.current.head.lines=f.current.head.lines.filter(row=>row.id!==line);f.current.context.nativeContext=captureContinuityContext(f.current.head);}
  await expect(readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host)).rejects.toMatchObject({code:'CONFLICT',path:kind==='line'?'locked screenplay snapshot body':'screenplay snapshot lock'});
});

it('keeps historical adoption available when a later current body change blocks handoff',async()=>{
  const f=await fixture();f.current.head.lines[0]!.text='后续当前正文变化。';const history=await readScreenplayNativeAdoption(f.client,f.selection,f.store,f.host);expect(history.receipt).toEqual(f.receipt);expect(history.progress.current).toBe(false);
  await expect(readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host)).rejects.toMatchObject({code:'CONFLICT',path:'locked screenplay snapshot body'});
});

it.each(['character-version','episode-version','outline-version','outline-beat-version','source-text','profile-version'] as const)('refuses changed current writing dependencies %s',async field=>{
  const f=await fixture(),context=f.current.context;
  if(field==='character-version')context.characters[0]!.version++;else if(field==='episode-version')context.episode.version++;else if(field==='outline-version')context.outline.plan.version++;else if(field==='outline-beat-version')context.outline.beats[0]!.ref.version++;else if(field==='source-text')context.references[0]!.text='当前写作依据已有新内容。';else context.rules.speech.version++;
  await expect(readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host)).rejects.toMatchObject({code:'CONFLICT',path:'current writing dependencies'});expect(ports.ledger).not.toHaveBeenCalled();
});

it('authorizes both historical and current reads before any trusted lookup or database query',async()=>{
  const f=await fixture();f.grant.mockReturnValue(false);
  for(const read of [()=>readScreenplayNativeAdoption(f.client,f.selection,f.store,f.host),()=>readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host)])await expect(read()).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(ports.binding).not.toHaveBeenCalled();expect(ports.receipt).not.toHaveBeenCalled();expect(f.store.readHistorical).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();expect(ports.current).not.toHaveBeenCalled();
});

it.each(['proof-reader','history-store','query','current-source','ledger-resolver'] as const)('sanitizes an opaque failure from the %s boundary',async port=>{
  const f=await fixture(),opaque=new Proxy(new Error('private-database-credential'),{getPrototypeOf:()=>{throw new Error('private-prototype');}});
  if(port==='proof-reader')ports.binding.mockRejectedValue(opaque);else if(port==='history-store')f.store.readHistorical.mockRejectedValue(opaque);else if(port==='query')f.query.mockRejectedValue(opaque);else if(port==='current-source')ports.current.mockRejectedValue(opaque);else ports.ledger.mockRejectedValue(opaque);
  const error=await readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host).catch(value=>value as Error);expect(error).toMatchObject({code:'STORAGE_FAILED'});if(!(error instanceof Error))throw new Error('Expected safe handoff refusal');expect(error.message).not.toContain('private-');
});

it('preserves a known current-source refusal and never invokes the ledger resolver afterward',async()=>{
  const f=await fixture(),error=new ScreenplayError('INCOMPLETE','current source review','review');ports.current.mockRejectedValue(error);await expect(readScreenplayHandoff(f.client,f.selection,f.store,f.outline,f.host)).rejects.toBe(error);expect(ports.ledger).not.toHaveBeenCalled();
});

it('refuses scope mismatch and unsafe selection accessors before any proof lookup',async()=>{
  const f=await fixture();await expect(readScreenplayNativeAdoption(f.client,{...f.selection,scope:{...f.scope,projectId:'outside-host-project'}},f.store,f.host)).rejects.toMatchObject({code:'FORBIDDEN'});
  let touched=false;const selection=Object.defineProperty({...f.selection},'changeId',{enumerable:true,get:()=>{touched=true;return f.selection.changeId;}});await expect(readScreenplayHandoff(f.client,selection,f.store,f.outline,f.host)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(touched).toBe(false);expect(ports.binding).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
});
