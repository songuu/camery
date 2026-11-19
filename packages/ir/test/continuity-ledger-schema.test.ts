import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {StoryboardPackageV08,upgradeV07Package,validatePackage,continuityDependencyIssues,CONTINUITY_LEDGER_BYTES,ContinuityLedgerSchema,ContinuityDraftSchema,UpgradeSchemaOp,ChangeSetV08,toChangeSetJsonSchema} from '../src/index';
import {makeOutlinePackage} from './outline-formal-fixture';
import {makeContinuityPackage} from './continuity-ledger-fixture';
import {fixtureId as id} from './fixtures';
import type {StoryboardPackageV08 as Package,ContinuitySnapshot} from '../src/index';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snap=(p:Package)=>p.continuity_snapshots[0]!;
const issues=(p:Package)=>validatePackage(p).errors;
const expectCode=(p:Package,code:string)=>expect(issues(p).some(issue=>issue.code===code),JSON.stringify(issues(p))).toBe(true);
it('requires an explicit typed v08 upgrade and never inserts ledger defaults into v07',()=>{
  const old=makeOutlinePackage(),saved=structuredClone(old),p=upgradeV07Package(old);
  expect(p).toEqual({...old,schema_version:'0.8.0-draft',continuity_snapshots:[]});expect(old).toEqual(saved);
  expect(StoryboardPackageV08.safeParse({...p,continuity_snapshots:undefined}).success).toBe(false);expect(issues(p)).toEqual([]);
});
it('retains every typed v1 field and schema exactly across the script-to-IR move',()=>{
  expect(hash(z.toJSONSchema(ContinuityDraftSchema))).toBe('cdc26c9027b697f08fa0723cef48f2a1dac26050231c640bdbfe9e0f11f9b9bd');
  expect(hash(z.toJSONSchema(ContinuityLedgerSchema))).toBe('ab834e98dcf4eaa06191077003354fbb698c52de09643569c7eb8dbe04b1e1f2');
  const p=makeContinuityPackage();expect(StoryboardPackageV08.parse(p)).toEqual(p);expect(issues(p)).toEqual([]);expect(continuityDependencyIssues(p)).toEqual([]);
  expect(StoryboardPackageV08.safeParse({...p,continuity_snapshots:[{...snap(p),status:'adopted'}]}).success).toBe(false);
});
const mutateCases:readonly [string,(_p:Package,s:ContinuitySnapshot)=>void,string][]=[
  ['project scope',(_p,s)=>{s.ledger.projectId=id('wrong-project');},'CONTINUITY_SCOPE'],
  ['package scope',(_p,s)=>{s.ledger.packageId=id('wrong-package');},'CONTINUITY_SCOPE'],
  ['episode scope',(_p,s)=>{s.ledger.episodeId=id('wrong-episode');},'CONTINUITY_SCOPE'],
  ['future source revision',(_p,s)=>{s.ledger.snapshotRevision=_p.revision.number+1;},'CONTINUITY_SCOPE'],
  ['duplicate snapshots',(_p,s)=>{_p.continuity_snapshots.push({...structuredClone(s),id:id('other-snapshot')});},'CONTINUITY_DUPLICATE'],
  ['duplicate pins',(_p,s)=>{s.based_on.push(s.based_on[0]!);},'CONTINUITY_DUPLICATE'],
  ['duplicate facts',(_p,s)=>{s.ledger.facts.push(s.ledger.facts[0]!);},'CONTINUITY_DUPLICATE'],
  ['duplicate knowledge',(_p,s)=>{s.ledger.knowledge.push(s.ledger.knowledge[0]!);},'CONTINUITY_DUPLICATE'],
  ['duplicate character states',(_p,s)=>{s.ledger.characters.push(s.ledger.characters[0]!);},'CONTINUITY_DUPLICATE'],
  ['duplicate threads',(_p,s)=>{s.ledger.threads.push(s.ledger.threads[0]!);},'CONTINUITY_DUPLICATE'],
  ['missing pin',(_p,s)=>{s.based_on.pop();},'CONTINUITY_REFERENCE'],
  ['wrong exact pin',(_p,s)=>{s.based_on.find(ref=>ref.id===_p.beats[0]!.id)!.version=2;},'CONTINUITY_REFERENCE'],
  ['absent independent pin',(_p,s)=>{s.based_on.push({id:id('absent-pin'),version:1});},'CONTINUITY_REFERENCE'],
  ['self pin',(_p,s)=>{s.based_on.push({id:s.id,version:1});},'CONTINUITY_REFERENCE'],
  ['missing fact',(_p,s)=>{s.ledger.knowledge[0]!.factId='absent';},'CONTINUITY_REFERENCE'],
  ['missing native character',(_p,s)=>{s.ledger.characters[0]!.value.characterId=id('missing-character');},'CONTINUITY_REFERENCE'],
  ['false quote',(_p,s)=>{s.ledger.facts[0]!.introduced.evidence.quote='不在原文内';},'CONTINUITY_EVIDENCE'],
  ['wrong evidence collection',(_p,s)=>{s.ledger.facts[0]!.introduced.evidence.event.kind='line';},'CONTINUITY_REFERENCE'],
  ['unknown evidence episode',(_p,s)=>{s.ledger.facts[0]!.introduced.episodeId=id('unknown-episode');},'CONTINUITY_ORDER'],
  ['future native version',(_p,s)=>{const ref=s.based_on.find(ref=>ref.id===_p.characters[0]!.id)!;ref.version=2;},'FUTURE_CONTINUITY_DEPENDENCY'],
  ['retirement before introduction',(_p,s)=>{const fact=s.ledger.facts[0]!;fact.retired=structuredClone(fact.introduced);fact.introduced.order=9;},'CONTINUITY_ORDER'],
  ['learning before introduction',(_p,s)=>{s.ledger.facts[0]!.introduced.order=9;},'CONTINUITY_ORDER'],
  ['learning after retirement',(_p,s)=>{const f=s.ledger.facts[0]!;f.retired=structuredClone(f.introduced);s.ledger.knowledge[0]!.learned.order=9;},'CONTINUITY_ORDER'],
  ['deduction self source',(_p,s)=>{s.ledger.knowledge[0]!.source={kind:'deduced',factIds:['fact.clock']};},'CONTINUITY_REFERENCE'],
  ['deduction missing source',(_p,s)=>{s.ledger.knowledge[0]!.source={kind:'deduced',factIds:['missing']};},'CONTINUITY_REFERENCE'],
  ['duplicate deduction sources',(_p,s)=>{s.ledger.knowledge[0]!.source={kind:'deduced',factIds:['fact.clock','fact.clock']};},'CONTINUITY_DUPLICATE'],
  ['payoff before planting',(_p,s)=>{s.ledger.threads[0]!.planted.order=9;},'CONTINUITY_ORDER'],
];
it.each(mutateCases)('rejects %s',(_name,mutate,code)=>{const p=makeContinuityPackage();mutate(p,snap(p));expectCode(p,code);});
it('retains stale pins and historical quotes as warnings, with exact content unchanged',()=>{
  const p=makeContinuityPackage(),old=structuredClone(snap(p));p.beats[0]!.version=2;p.beats[0]!.summary='新版本原文，不含旧句。';
  expect(issues(p)).toEqual([]);expect(validatePackage(p).warnings).toContainEqual(expect.objectContaining({code:'STALE_CONTINUITY_DEPENDENCY'}));expect(snap(p)).toEqual(old);expect(continuityDependencyIssues(p)[0]).toMatchObject({referenceId:p.beats[0]!.id,expectedVersion:1,actualVersion:2});
});
it('counts actual UTF-8 bytes and rejects a complete ledger above 2MiB without truncating it',()=>{
  const p=makeContinuityPackage(),s=snap(p),f=s.ledger.facts[0]!;s.ledger.facts=Array.from({length:800},(_,i)=>({...structuredClone(f),id:'fact.'+i,text:'钟'.repeat(1000)}));s.ledger.knowledge=[];
  expect(new TextEncoder().encode(JSON.stringify(s.ledger)).byteLength).toBeGreaterThan(CONTINUITY_LEDGER_BYTES);expectCode(p,'CONTINUITY_LIMIT');expect(s.ledger.facts).toHaveLength(800);
});
it('accepts only the adjacent public v08 upgrade edge in runtime and generated schemas',()=>{
  expect(UpgradeSchemaOp.safeParse({op:'upgrade_schema',op_id:id('up'),from:'0.7.0-draft',to:'0.8.0-draft'}).success).toBe(true);
  for(const [from,to] of [['0.5.0-draft','0.8.0-draft'],['0.6.0-draft','0.8.0-draft'],['0.7.0-draft','0.6.0-draft']])expect(UpgradeSchemaOp.safeParse({op:'upgrade_schema',op_id:id('up'),from,to}).success).toBe(false);
  const schema=toChangeSetJsonSchema() as {oneOf:{properties:{schema_version:{const:string};ops:{items:{oneOf:{properties:{op:{const:string};from?:{const:string};to?:{const:string}}}[]}}}}[]};
  const v08=schema.oneOf.find(row=>row.properties.schema_version.const==='0.8.0-draft')!,upgrade=v08.properties.ops.items.oneOf.find(row=>row.properties.op.const==='upgrade_schema')!;expect(upgrade.properties.from?.const).toBe('0.7.0-draft');expect(upgrade.properties.to?.const).toBe('0.8.0-draft');expect(ChangeSetV08).toBeDefined();
});

function pin(p:Package,ref:{id:string;version:number}){const s=snap(p);if(!s.based_on.some(value=>value.id===ref.id))s.based_on.push({id:ref.id,version:ref.version});}
function physical(p:Package){const value=snap(p).ledger.characters[0]!.value,appearance=p.appearances.find(row=>row.character_id===value.characterId)!,location=p.locations[0]!,prop=p.props[0]!;value.appearance={id:appearance.id,version:appearance.version};value.spot={id:location.spots[0]!.id,location:{id:location.id,version:location.version}};value.holding=[{id:prop.id,version:prop.version}];for(const row of [appearance,location,prop])pin(p,row);return value;}
it('preserves optional physical state only with real character, prop, appearance and location revisions',()=>{const p=makeContinuityPackage();physical(p);expect(issues(p)).toEqual([]);expect(StoryboardPackageV08.parse(p)).toEqual(p);});
it.each(['appearance-owner','spot-owner','duplicate-prop','missing-prop'] as const)('refuses physical-state %s corruption',kind=>{
  const p=makeContinuityPackage(),value=physical(p);if(kind==='appearance-owner'){const wrong={...p.appearances[0]!,id:id('other-character-appearance'),character_id:p.characters.find(row=>row.id!==value.characterId)!.id};p.appearances.push(wrong);value.appearance={id:wrong.id,version:wrong.version};}if(kind==='spot-owner')value.spot!.id=id('other-spot');if(kind==='duplicate-prop')value.holding.push(value.holding[0]!);if(kind==='missing-prop')value.holding[0]!.id=id('missing-prop');
  if(kind==='appearance-owner')pin(p,value.appearance!);expectCode(p,kind==='duplicate-prop'?'CONTINUITY_DUPLICATE':kind==='missing-prop'?'CONTINUITY_REFERENCE':'CONTINUITY_SCOPE');
});
it('preserves told and independently deduced source types without converting them to prose',()=>{
  const p=makeContinuityPackage(),s=snap(p),other=p.characters.find(row=>row.id!==s.ledger.knowledge[0]!.characterId)!;pin(p,other);s.ledger.knowledge[0]!.source={kind:'told',fromCharacterId:other.id};expect(issues(p)).toEqual([]);
  const fact=structuredClone(s.ledger.facts[0]!);fact.id='fact.premise';s.ledger.facts.push(fact);s.ledger.knowledge[0]!.source={kind:'deduced',factIds:['fact.premise']};expect(issues(p)).toEqual([]);expect(StoryboardPackageV08.parse(p).continuity_snapshots[0]!.ledger.knowledge[0]!.source).toEqual({kind:'deduced',factIds:['fact.premise']});
});
it('uses actual line text and its owning episode for native evidence',()=>{
  const p=makeContinuityPackage(),s=snap(p),line=p.lines[0]!,fact=s.ledger.facts[0]!;pin(p,line);pin(p,p.beats.find(row=>row.id===line.beat_id)!);fact.introduced.evidence={event:{kind:'line',id:line.id,version:line.version},quote:line.text};fact.introduced.order=1;s.ledger.knowledge=[];s.ledger.characters=[];s.ledger.threads=[];expect(issues(p)).toEqual([]);
  fact.introduced.evidence.quote='伪造的台词';expectCode(p,'CONTINUITY_EVIDENCE');
});
it('does not confuse scene/beat/line order with declaration order or lexical ULIDs',()=>{
  const p=makeContinuityPackage(),s=snap(p),fact=s.ledger.facts[0]!,first=p.beats[0]!,later=p.beats.find(row=>row.scene_id===first.scene_id&&row.order_key>first.order_key)!;pin(p,later);
  fact.retired=structuredClone(fact.introduced);fact.retired.evidence={event:{kind:'beat',id:later.id,version:later.version},quote:later.summary};fact.retired.order=1;expect(issues(p)).toEqual([]);
  fact.introduced.evidence=fact.retired.evidence;fact.retired.evidence={event:{kind:'beat',id:first.id,version:first.version},quote:first.summary};expectCode(p,'CONTINUITY_ORDER');
});
it('rejects evidence in a later episode and planned payoff before the planting episode',()=>{
  const p=makeContinuityPackage(),s=snap(p),next={...p.episodes[0]!,id:id('future-episode'),order_key:'z0'};p.episodes.push(next);p.project.scope.expected_episode_count=p.episodes.length;pin(p,next);
  s.ledger.facts[0]!.introduced.episodeId=next.id;expectCode(p,'CONTINUITY_ORDER');expectCode(p,'CONTINUITY_SCOPE');
  s.ledger.facts[0]!.introduced.episodeId=s.episode_id;s.ledger.episodeId=next.id;s.episode_id=next.id;s.ledger.threads[0]!.planted.episodeId=next.id;s.ledger.threads[0]!.payoffEpisodeId=p.episodes[0]!.id;expectCode(p,'CONTINUITY_ORDER');
});
it('reports missing native dependency versions rather than silently taking a latest object',()=>{
  const p=makeContinuityPackage(),s=snap(p);s.based_on.push({id:id('missing-native-object'),version:1});expect(continuityDependencyIssues(p)).toContainEqual({objectId:s.id,referenceId:id('missing-native-object'),expectedVersion:1,actualVersion:null});expectCode(p,'CONTINUITY_REFERENCE');
});
it('keeps absent payoff and retirement explicit rather than inventing closure',()=>{const p=makeContinuityPackage(),s=snap(p);s.ledger.threads[0]!.paidOff=null;s.ledger.threads[0]!.payoffEpisodeId=null;expect(issues(p)).toEqual([]);expect(StoryboardPackageV08.parse(p).continuity_snapshots[0]!.ledger.threads[0]).toMatchObject({paidOff:null,payoffEpisodeId:null});});

it('requires fresh evidence to pin its versioned parent scene, and warns when that parent changes',()=>{
  const p=makeContinuityPackage(),s=snap(p),scene=p.scenes.find(row=>row.id===p.beats[0]!.scene_id)!;s.based_on=s.based_on.filter(ref=>ref.id!==scene.id);expectCode(p,'CONTINUITY_REFERENCE');pin(p,scene);expect(issues(p)).toEqual([]);scene.version++;scene.order_key='z0';expect(issues(p)).toEqual([]);expect(validatePackage(p).warnings).toContainEqual(expect.objectContaining({code:'STALE_CONTINUITY_DEPENDENCY'}));
});
it.each(['scope','unique','missing','future','limit'] as const)('stale history never waives intrinsic %s errors',kind=>{
  const p=makeContinuityPackage(),s=snap(p);p.beats[0]!.version++;if(kind==='scope')s.ledger.projectId=id('wrong-project');if(kind==='unique')s.ledger.facts.push(s.ledger.facts[0]!);if(kind==='missing')s.based_on.push({id:id('absent'),version:1});if(kind==='future')s.based_on.find(ref=>ref.id===p.characters[0]!.id)!.version=2;if(kind==='limit'){const f=s.ledger.facts[0]!;s.ledger.facts=Array.from({length:800},(_,i)=>({...structuredClone(f),id:'fact.'+i,text:'钟'.repeat(1000)}));}
  expectCode(p,kind==='scope'?'CONTINUITY_SCOPE':kind==='unique'?'CONTINUITY_DUPLICATE':kind==='missing'?'CONTINUITY_REFERENCE':kind==='future'?'FUTURE_CONTINUITY_DEPENDENCY':'CONTINUITY_LIMIT');expect(validatePackage(p).warnings).toContainEqual(expect.objectContaining({code:'STALE_CONTINUITY_DEPENDENCY'}));
});
