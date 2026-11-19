import {expect,it} from 'vitest';
import {createVersionState,submitChangeSet,adoptChangeSet} from '@camery/versioning';
import {CONTINUITY_CONTEXT_BYTES,ContinuityError} from '../src/continuity/contracts.js';
import type {ContinuityDraft} from '../src/continuity/contracts.js';
import {makeContinuityPackage} from '../../ir/test/continuity-ledger-fixture.js';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {captureContinuityContext} from '../src/continuity/context.js';
import {createContinuityCandidate} from '../src/continuity/node/candidate.js';
import {continuityDigest} from '../src/continuity/node/digest.js';
import {reviewContinuityCandidate,rejectContinuityCandidate} from '../src/continuity/node/review.js';
import {CONTINUITY_RECORD_BYTES,CONTINUITY_PREVIOUS_BYTES} from '../src/continuity/node/persistence-contracts.js';
import type {ContinuityProgress,ContinuityPrevious} from '../src/continuity/node/persistence-contracts.js';
import {prepareContinuityNativeMapping} from '../src/continuity/node/native-mapping.js';

function fixture(options:{existing?:boolean;empty?:boolean;previous?:1|2;staleParent?:boolean;physical?:boolean;retired?:boolean;unpaid?:boolean;told?:boolean;version?:number;repair?:boolean}={}){
  const head=makeContinuityPackage();if(!options.existing)head.continuity_snapshots=[];
  if(options.version!==undefined&&head.continuity_snapshots[0])head.continuity_snapshots[0].version=options.version;
  const scope={tenantId:'native-mapping-tenant',projectId:'native-mapping-project'},target={tenantId:id('native-mapping-tenant'),projectId:head.project.id};
  let context=captureContinuityContext(head);const firstEpisode=context.episodes[0]!,beat=context.events.find(row=>row.episodeId===firstEpisode.id&&row.ref.kind==='beat')!,line=context.events.find(row=>row.episodeId===firstEpisode.id&&row.ref.kind==='line'&&row.lineKind==='on_screen')!;
  const character=beat.characterIds[0]!,appearance=head.appearances.find(row=>row.character_id===character),location=head.locations[0]!,prop=head.props[0]!;
  const evidence=(event=beat)=>({event:{...event.ref},quote:event.text});
  const full:ContinuityDraft={version:1,episodeId:firstEpisode.id,events:[
    {id:'fact',op:'assert_fact',factId:'note',kind:'fact',text:'原始候选的便签事实。',evidence:evidence()},
    {id:'learn',op:'learn',characterId:character,factId:'note',source:{kind:'witness'},evidence:evidence()},
    {id:'plant',op:'plant',threadId:'letter',summary:'便签背后是谁？',payoffEpisodeId:options.unpaid?context.episodes[1]!.id:firstEpisode.id,evidence:evidence()},
    {id:'state',op:'set_character',value:{characterId:character,summary:'核对便签后继续调查。',appearance:options.physical===false?null:appearance?{id:appearance.id,version:appearance.version}:null,spot:options.physical===false?null:{id:location.spots[0]!.id,location:{id:location.id,version:location.version}},holding:options.physical===false?[]:[{id:prop.id,version:prop.version}]},evidence:evidence(line)},
    ...(options.told?[{id:'told',op:'learn' as const,characterId:beat.characterIds[1]!,factId:'note',source:{kind:'told' as const,fromCharacterId:character},evidence:evidence(line)}]:[]),
    ...(options.unpaid?[]:[{id:'payoff',op:'payoff' as const,threadId:'letter',evidence:evidence(line)}]),
    ...(options.retired?[{id:'retire',op:'retire_fact' as const,factId:'note',evidence:evidence(line)}]:[]),
  ]};
  let previous:ContinuityPrevious|null=null;
  if(options.previous){
    const prior=createContinuityCandidate(scope,context,full),snapshot={id:id('native-map-prior-snapshot'),version:1,episode_id:firstEpisode.id,
      based_on:[firstEpisode,...head.characters,head.beats.find(row=>row.id===beat.ref.id)!,head.lines.find(row=>row.id===line.ref.id)!,head.beats.find(row=>row.id===head.lines.find(row=>row.id===line.ref.id)!.beat_id)!,...head.scenes,...head.appearances,...head.locations,...head.props].filter((row,index,rows)=>rows.findIndex(item=>item.id===row.id)===index).map(({id,version})=>({id,version})),ledger:prior.ledger};
    if(options.previous===2)head.continuity_snapshots.push(snapshot);
    else head.episode_state_snapshots.push({id:snapshot.id,version:1,episode_id:firstEpisode.id,based_on:snapshot.based_on,status:'adopted',facts:[],knowledge:[],characters:[],plot_threads:[]});
    if(options.staleParent)head.scenes.find(row=>row.id===head.beats.find(row=>row.id===beat.ref.id)!.scene_id)!.version++;
    const body={version:options.previous,id:'prior-candidate',scope,target,snapshot:{id:snapshot.id,version:1},changeId:id('prior-change'),adoptedRevision:head.revision.number,ledger:prior.ledger,
      ...(options.previous===2?{origin:{reviewDigest:'b'.repeat(64),bindingDigest:'c'.repeat(64)}}:{})};
    previous={...body,digest:continuityDigest(body,CONTINUITY_PREVIOUS_BYTES)} as ContinuityPrevious;context=captureContinuityContext(head);
  }
  const episodeId=options.previous?context.episodes[1]!.id:firstEpisode.id,draft=options.previous||options.empty?{version:1 as const,episodeId,events:[]}:full;
  if(options.repair)draft.events.push({id:'unknown-use',op:'use_fact',characterId:character,factId:'unknown-fact',evidence:evidence(line)});
  const candidate=createContinuityCandidate(scope,context,draft,previous?.ledger??null),key={...scope,candidateId:'native-map-candidate'};
  const source={version:1 as const,target,packageId:head.package_id,snapshotRevision:head.revision.number,episodeId,packageDigest:continuityDigest(head,CONTINUITY_CONTEXT_BYTES),contextDigest:continuityDigest(context,CONTINUITY_CONTEXT_BYTES),previousDigest:previous?.digest??null};
  const command={key,target,expectedSnapshotRevision:source.snapshotRevision,expectedPackageDigest:source.packageDigest,draft};
  const body={version:1 as const,key,source,previous,authorId:'candidate-author',createdAt:'2026-11-19T03:05:00.000Z',commandDigest:continuityDigest({...command,authorId:'candidate-author'},CONTINUITY_RECORD_BYTES),candidate};
  const preparation={...body,digest:continuityDigest(body,CONTINUITY_RECORD_BYTES)};
  const edited=structuredClone(draft);const fact=edited.events.find(row=>row.op==='assert_fact');if(fact?.op==='assert_fact')fact.text='人工核对后的完整便签事实。';
  if(options.repair)edited.events=edited.events.filter(row=>row.id!=='unknown-use');
  const host={actor:{kind:'human' as const,id:'human-reviewer'},scope,at:'2026-11-19T03:06:00.000Z',authorize:()=>true};
  const review=reviewContinuityCandidate(context,candidate,{candidateDigest:candidate.digest,draft:edited,waivers:[]},host,previous?.ledger??null);
  const progress:ContinuityProgress=structuredClone({preparation,review,current:true});
  return {head,progress,context,host,beat,line,full,input:{head,progress,changeId:id('native-map-change'),snapshotId:options.existing?head.continuity_snapshots[0]!.id:id('native-map-snapshot'),operationId:id('native-map-op'),author:{kind:'user' as const,id:id('native-map-author')}}};
}
function rehash(f:ReturnType<typeof fixture>){const {digest:_digest,...body}=f.progress.preparation;f.progress.preparation.digest=continuityDigest(body,CONTINUITY_RECORD_BYTES);}
function refreshSource(f:ReturnType<typeof fixture>){const p=f.progress.preparation;p.source.packageDigest=continuityDigest(f.head,CONTINUITY_CONTEXT_BYTES);p.commandDigest=continuityDigest({key:p.key,target:p.source.target,expectedSnapshotRevision:p.source.snapshotRevision,expectedPackageDigest:p.source.packageDigest,draft:p.candidate.draft,authorId:p.authorId},CONTINUITY_RECORD_BYTES);rehash(f);}
function rehashPrevious(f:ReturnType<typeof fixture>){const p=f.progress.preparation,previous=p.previous;if(!previous)throw new Error('Expected prior fixture');const {digest:_digest,...body}=previous;previous.digest=continuityDigest(body,CONTINUITY_PREVIOUS_BYTES);p.source.previousDigest=previous.digest;rehash(f);}

it('maps the complete human-edited four-ledger output through the real native episode adoption engine',()=>{
  const f=fixture(),saved=structuredClone(f.head),mapping=prepareContinuityNativeMapping(f.input);
  if(f.progress.review?.status!=='reviewed')throw new Error('Expected reviewed fixture');
  expect(mapping.snapshot.ledger).toEqual(f.progress.review.output.ledger);expect(mapping.snapshot.ledger.facts[0]!.text).toBe('人工核对后的完整便签事实。');
  expect(mapping.snapshot.ledger).not.toEqual(f.progress.preparation.candidate.ledger);expect(mapping.snapshot.ledger.characters[0]!.value.holding).toEqual([{id:f.head.props[0]!.id,version:f.head.props[0]!.version}]);
  for(const row of [f.head.episodes[0]!,f.head.characters[0]!,f.head.scenes.find(row=>row.id===f.head.beats.find(row=>row.id===f.beat.ref.id)!.scene_id)!,f.head.beats.find(row=>row.id===f.beat.ref.id)!,f.head.lines.find(row=>row.id===f.line.ref.id)!])expect(mapping.snapshot.based_on).toContainEqual({id:row.id,version:row.version});
  const pending=submitChangeSet(createVersionState(f.head),mapping.request);expect(pending.issues).toEqual([]);expect(pending.status).toBe('candidate');
  const adopted=adoptChangeSet(pending.state,mapping.request.id,{actor:f.input.author,scope:{kind:'episode',id:mapping.snapshot.episode_id},at:f.host.at,authorize:()=>true});expect(adopted.status).toBe('adopted');
  expect(adopted.state.head).toEqual({...saved,revision:adopted.state.head.revision,continuity_snapshots:[mapping.snapshot]});expect(adopted.state.head.revision.number).toBe(saved.revision.number+1);
  expect(f.head).toEqual(saved);expect(Object.isFrozen(mapping.snapshot.ledger.facts)).toBe(true);
  const {digest,...body}=mapping.binding;expect(digest).toBe(continuityDigest(body,8_388_608));expect(mapping.binding).toMatchObject({key:f.progress.preparation.key,target:f.progress.preparation.source.target,candidateDigest:f.progress.preparation.candidate.digest,reviewDigest:f.progress.review.digest,sourceRevision:f.head.revision.number,packageDigest:f.progress.preparation.source.packageDigest,requestDigest:continuityDigest(mapping.request,8_388_608)});
});

it('preserves a complete empty ledger and pins its actual episode',()=>{
  const f=fixture({empty:true}),mapping=prepareContinuityNativeMapping(f.input);expect(mapping.snapshot.based_on).toEqual([{id:f.head.episodes[0]!.id,version:f.head.episodes[0]!.version}]);
  expect(mapping.snapshot.ledger).toMatchObject({facts:[],knowledge:[],characters:[],threads:[]});expect(mapping.request.ops).toHaveLength(1);
});

it('updates only the existing snapshot ledger and pins while keeping native locks for the engine to enforce',()=>{
  const f=fixture({existing:true});f.head.locks.push({id:id('native-map-lock'),version:1,target:f.input.snapshotId,fields:['ledger'],owner_id:f.input.author.id,reason:'保持人审锁。'});
  const fresh=fixture({existing:true});fresh.head.locks=f.head.locks;const context=captureContinuityContext(fresh.head);fresh.progress.preparation.source.packageDigest=continuityDigest(fresh.head,CONTINUITY_CONTEXT_BYTES);fresh.progress.preparation.source.contextDigest=continuityDigest(context,CONTINUITY_CONTEXT_BYTES);
  const p=fresh.progress.preparation;p.commandDigest=continuityDigest({key:p.key,target:p.source.target,expectedSnapshotRevision:p.source.snapshotRevision,expectedPackageDigest:p.source.packageDigest,draft:p.candidate.draft,authorId:p.authorId},CONTINUITY_RECORD_BYTES);rehash(fresh);
  const saved=structuredClone(fresh.head),mapping=prepareContinuityNativeMapping(fresh.input);expect(mapping.snapshot.version).toBe(2);expect(mapping.request.ops).toEqual([{op_id:fresh.input.operationId,op:'update',collection:'continuity_snapshots',target:fresh.input.snapshotId,set:{based_on:mapping.snapshot.based_on,ledger:mapping.snapshot.ledger}}]);
  expect(mapping.request.base_revisions).toContainEqual({id:fresh.input.snapshotId,version:1});const result=submitChangeSet(createVersionState(fresh.head),mapping.request);expect(result.issues.map(row=>row.code)).toContain('LOCKED');expect(fresh.head).toEqual(saved);expect(mapping.request.ops.some(row=>row.op==='unlock')).toBe(false);
});

it('adopts an unlocked update as one new snapshot version and preserves its full baseline object history',()=>{
  const f=fixture({existing:true}),original=structuredClone(f.head.continuity_snapshots[0]),mapping=prepareContinuityNativeMapping(f.input),pending=submitChangeSet(createVersionState(f.head),mapping.request);
  expect(pending.status).toBe('candidate');const result=adoptChangeSet(pending.state,mapping.request.id,{actor:f.input.author,scope:{kind:'episode',id:mapping.snapshot.episode_id},at:f.host.at,authorize:()=>true});expect(result.status).toBe('adopted');
  expect(result.state.revisions.filter(row=>row.object_id===mapping.snapshot.id).map(row=>({version:row.version,value:row.value}))).toEqual([{version:1,value:original},{version:2,value:mapping.snapshot}]);
  expect(result.state.head).toEqual({...f.head,revision:result.state.head.revision,continuity_snapshots:[mapping.snapshot]});
});

it('permits the human to repair original candidate errors while persisting only the recompiled reviewed ledger',()=>{
  const f=fixture({repair:true}),mapping=prepareContinuityNativeMapping(f.input);expect(f.progress.preparation.candidate.issues.some(row=>row.code==='UNKNOWN_FACT')).toBe(true);
  if(f.progress.review?.status!=='reviewed')throw new Error('Expected human repair');expect(f.progress.review.output.issues).toEqual([]);expect(mapping.snapshot.ledger).toEqual(f.progress.review.output.ledger);expect(mapping.binding.candidateDigest).toBe(f.progress.preparation.candidate.digest);
});

it.each(['not-reviewed','rejected','stale'] as const)('refuses %s progress',kind=>{
  const f=fixture(),progress={...f.progress,...(kind==='stale'?{current:false}:{review:kind==='not-reviewed'?null:rejectContinuityCandidate(f.context,f.progress.preparation.candidate,{candidateDigest:f.progress.preparation.candidate.digest,reason:'尚不能采用。'},f.host)})};
  expect(()=>prepareContinuityNativeMapping({...f.input,progress})).toThrow(ContinuityError);
});

it('keeps retirement, told knowledge and future unpaid threads while allowing absent physical assets',()=>{
  const f=fixture({physical:false,retired:true,unpaid:true,told:true}),mapping=prepareContinuityNativeMapping(f.input);
  expect(mapping.snapshot.ledger.facts[0]!.retired?.eventId).toBe('retire');expect(mapping.snapshot.ledger.knowledge[1]!.source).toEqual({kind:'told',fromCharacterId:f.beat.characterIds[0]});expect(mapping.snapshot.ledger.threads[0]!.paidOff).toBeNull();
  expect(mapping.snapshot.based_on).toContainEqual({id:f.head.episodes[1]!.id,version:f.head.episodes[1]!.version});expect(mapping.snapshot.ledger.characters[0]!.value).toMatchObject({appearance:null,spot:null,holding:[]});
});

it('rejects a snapshot version that cannot be incremented safely',()=>{
  const f=fixture({existing:true,version:Number.MAX_SAFE_INTEGER});expect(()=>prepareContinuityNativeMapping(f.input)).toThrow('INPUT_LIMIT');
});

it.each(['change-op','change-content','op-content','op-reserved','invalid-author','old-schema','candidate-head'] as const)('refuses %s request identities or source',kind=>{
  const f=fixture();if(kind==='change-op')f.input.changeId=f.input.operationId;else if(kind==='change-content')f.input.changeId=f.head.characters[0]!.id;else if(kind==='op-content')f.input.operationId=f.head.beats[0]!.id;else if(kind==='op-reserved')f.input.operationId=f.head.package_id;else if(kind==='invalid-author')f.input.author.id='not-native-id';else if(kind==='old-schema')Object.assign(f.head,{schema_version:'0.7.0-draft'});else f.head.revision.status='candidate';
  expect(()=>prepareContinuityNativeMapping(f.input)).toThrow(ContinuityError);
});

it.each(['packageId','target','revision','packageDigest','contextDigest','previousDigest','commandDigest','preparationDigest','candidate','review'] as const)('rejects changed %s even when an outer record is rehashed',field=>{
  const f=fixture(),p=f.progress.preparation;if(field==='packageId')p.source.packageId=id('other-package');else if(field==='target')p.source.target.projectId=id('other-project');else if(field==='revision')p.source.snapshotRevision++;else if(field==='packageDigest')p.source.packageDigest='0'.repeat(64);else if(field==='contextDigest')p.source.contextDigest='0'.repeat(64);else if(field==='previousDigest')p.source.previousDigest='0'.repeat(64);else if(field==='commandDigest')p.commandDigest='0'.repeat(64);else if(field==='preparationDigest')p.digest='0'.repeat(64);else if(field==='candidate')p.candidate.ledger.facts[0]!.text='重写候选';else if(f.progress.review?.status==='reviewed')f.progress.review.output.ledger.facts[0]!.text='重写人审';
  if(field!=='preparationDigest')rehash(f);expect(()=>prepareContinuityNativeMapping(f.input)).toThrow(ContinuityError);
});

it.each(['project','package','spot','character','author','change','operation','other-episode','second-snapshot'] as const)('rejects snapshot identity collision with %s',kind=>{
  const f=fixture({existing:kind==='second-snapshot'});f.input.snapshotId=kind==='project'?f.head.project.id:kind==='package'?f.head.package_id:kind==='spot'?f.head.locations[0]!.spots[0]!.id:kind==='character'?f.head.characters[0]!.id:kind==='author'?f.input.author.id:kind==='change'?f.input.changeId:kind==='operation'?f.input.operationId:kind==='second-snapshot'?id('second-snapshot'):id('foreign-snapshot');
  if(kind==='other-episode'){const old=makeContinuityPackage().continuity_snapshots[0]!,episode=f.head.episodes[1]!;f.head.continuity_snapshots.push({...old,id:f.input.snapshotId,episode_id:episode.id,based_on:[{id:episode.id,version:episode.version}],ledger:{...old.ledger,episodeId:episode.id,facts:[],knowledge:[],characters:[],threads:[]}});refreshSource(f);}
  expect(()=>prepareContinuityNativeMapping(f.input)).toThrow(ContinuityError);
});

it.each([1,2] as const)('continues the complete exact v%s predecessor ledger without rewriting its envelope',version=>{
  const f=fixture({previous:version}),saved=JSON.stringify(f.progress.preparation.previous),mapping=prepareContinuityNativeMapping(f.input);
  expect(mapping.snapshot.episode_id).toBe(f.head.episodes[1]!.id);expect(mapping.snapshot.ledger.facts).toEqual(f.progress.preparation.previous!.ledger.facts);expect(mapping.snapshot.ledger.characters).toEqual(f.progress.preparation.previous!.ledger.characters);expect(JSON.stringify(f.progress.preparation.previous)).toBe(saved);
});

it('rejects an old scene-parent pin in the typed predecessor even when beat and line versions still match',()=>{
  const f=fixture({previous:2,staleParent:true});expect(()=>prepareContinuityNativeMapping(f.input)).toThrow(ContinuityError);
});

it.each(['digest','scope','tenant','project','package','future-adoption','future-source','episode','missing','version','ledger'] as const)('rejects a rebound predecessor %s',field=>{
  const f=fixture({previous:2}),previous=f.progress.preparation.previous!;if(field==='digest'){previous.digest='0'.repeat(64);f.progress.preparation.source.previousDigest=previous.digest;rehash(f);}
  else{if(field==='scope')previous.scope.projectId='other-project';else if(field==='tenant')previous.target.tenantId=id('other-native-tenant');else if(field==='project')previous.ledger.projectId=id('other-native-project');else if(field==='package')previous.ledger.packageId=id('other-native-package');else if(field==='future-adoption')previous.adoptedRevision=f.head.revision.number+1;else if(field==='future-source')previous.ledger.snapshotRevision=previous.adoptedRevision+1;else if(field==='episode')previous.ledger.episodeId=f.head.episodes[1]!.id;else if(field==='missing')previous.snapshot.id=id('missing-prior-snapshot');else if(field==='version')previous.snapshot.version++;else previous.ledger.facts[0]!.text='伪造前集账本';rehashPrevious(f);}
  expect(()=>prepareContinuityNativeMapping(f.input)).toThrow(ContinuityError);
});

it('refuses a legacy candidate snapshot as a trusted v1 predecessor without changing its old shape',()=>{
  const f=fixture({previous:1});f.head.episode_state_snapshots[0]!.status='candidate';refreshSource(f);expect(()=>prepareContinuityNativeMapping(f.input)).toThrow('predecessor ledger');
});

it('rejects malformed preparation audit time and envelope scope despite fresh package hashes',()=>{
  const f=fixture();f.progress.preparation.createdAt='2026-02-30T03:05:00.000Z';rehash(f);expect(()=>prepareContinuityNativeMapping(f.input)).toThrow(ContinuityError);
  const other=fixture();other.progress.preparation.key.projectId='mismatched-scope';const p=other.progress.preparation;p.commandDigest=continuityDigest({key:p.key,target:p.source.target,expectedSnapshotRevision:p.source.snapshotRevision,expectedPackageDigest:p.source.packageDigest,draft:p.candidate.draft,authorId:p.authorId},CONTINUITY_RECORD_BYTES);rehash(other);expect(()=>prepareContinuityNativeMapping(other.input)).toThrow(ContinuityError);
});

it('refuses unsafe accessors before evaluation and data over its capture budget',()=>{
  const f=fixture();let touched=false;const input=Object.defineProperty({...f.input},'head',{enumerable:true,get:()=>{touched=true;throw new Error('private');}});expect(()=>prepareContinuityNativeMapping(input)).toThrow(ContinuityError);expect(touched).toBe(false);
  expect(()=>prepareContinuityNativeMapping({...f.input,head:{...f.head,oversized:'x'.repeat(CONTINUITY_CONTEXT_BYTES)}})).toThrow('INPUT_LIMIT');
});
