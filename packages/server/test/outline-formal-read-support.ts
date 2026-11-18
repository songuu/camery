import {vi} from 'vitest';
import type {Role,SessionIdentity} from '@camery/access';
import {StoryboardPackageV07,validatePackage} from '@camery/ir';
import type {StoryboardPackageV07 as FormalPackage} from '@camery/ir';
import {adoptChangeSet,createVersionState,submitChangeSet} from '@camery/versioning';
import type {VersionProjectKey} from '@camery/versioning/node';
import {finalizeOutlineChangeSet,prepareOutlineMappingDraft} from '@camery/script/outline/node';
import {outlineFormalMappingFixture,outlineMappingInput} from '../../script/test/outline-formal-mapping-support.js';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {OutlineFormalReadApplication} from '../src/projects/outline-formal-application.js';
import type {OutlineFormalSnapshot} from '../src/projects/outline-formal-store.js';
import {ProjectApplicationError} from '../src/projects/intent-contracts.js';

/** Actual workflow evidence and native adoption form the baseline; this helper never claims live model quality. */
export async function outlineFormalReadFixture(options:{capacity?:boolean;large?:boolean}={}){
  const source=await outlineFormalMappingFixture({capacity:options.capacity??options.large??false}),draft=prepareOutlineMappingDraft(outlineMappingInput(source));
  const author={kind:'user' as const,id:source.reviewer.id},request=finalizeOutlineChangeSet({draft,changeSetId:id('formal-read-initial'),author,operationIds:draft.operations.map(row=>({slot:row.slot,id:id('formal-read-op:'+row.slot)}))});
  const submitted=submitChangeSet(createVersionState(source.head),request),adopted=adoptChangeSet(submitted.state,request.id,{actor:author,scope:{kind:'project',id:source.head.project.id},at:'2026-11-18T10:00:00.000Z',authorize:()=>true});
  if(submitted.status!=='candidate'||adopted.status!=='adopted'||adopted.state.head.schema_version!=='0.7.0-draft')throw new Error('Expected actual native adoption of the reviewed mapper output');
  const mapped=adopted.state.head,snapshot=options.large?largeFormalGraph(mapped):mapped,target=source.identities.target,scope={tenantId:source.source.tenantId,projectId:source.source.projectId};
  let state=createVersionState(snapshot),writeVersion=3,sequence=0;
  const snapshots=new Map<number,FormalPackage>([[snapshot.revision.number,snapshot]]);
  const identities={resolveProject:vi.fn(async(_input:{tenantId:string;projectId:string})=>({...scope,versionKey:target}))};
  const store={snapshot:vi.fn(async(command:{target:VersionProjectKey;revision?:number}):Promise<OutlineFormalSnapshot|null>=>{
    const revision=command.revision??state.head.revision.number,value=snapshots.get(revision);if(!value)throw new ProjectApplicationError('NOT_FOUND','explicit absent test snapshot');
    return {target:command.target,packageId:value.package_id,headRevision:state.head.revision.number,writeVersion,revision,snapshot:value};
  })};
  const application=new OutlineFormalReadApplication({tenantId:scope.tenantId,identities,store});
  const subject=(role:Role='viewer',userId='formal-viewer'):SessionIdentity=>({tenantId:scope.tenantId,userId,sessionId:'formal-session-'+userId,grants:[{projectId:scope.projectId,role}]});
  const context=(principal=subject())=>({subject:principal,projectId:scope.projectId});
  const address=(collection='adaptation_plans',objectId=snapshot.adaptation_plans[0]!.id,principal=subject())=>({...context(principal),collection,objectId});
  function advance(){
    const changeId=id('formal-read-later-'+sequence++),pending=submitChangeSet(state,{schema_version:'0.7.0-draft',id:changeId,author,base_revision:state.head.revision.number,base_revisions:[],status:'candidate',ops:[{op_id:id('formal-read-later-op-'+sequence),op:'add',collection:'props',value:{id:id('formal-read-unrelated-prop-'+sequence),version:1,name:'Later adopted prop',description:'This moves the head without rewriting an earlier snapshot.'}}]});
    const next=adoptChangeSet(pending.state,changeId,{actor:author,scope:{kind:'project',id:target.projectId},at:'2026-11-18T10:01:00.000Z',authorize:()=>true});
    if(next.status!=='adopted'||next.state.head.schema_version!=='0.7.0-draft')throw new Error('Expected real native head advancement');
    state=next.state;writeVersion+=2;snapshots.set(next.state.head.revision.number,next.state.head);return next.state.head;
  }
  return {source,mapped,snapshot,scope,target,snapshots,identities,store,application,subject,context,address,advance,current:()=>({headRevision:state.head.revision.number,writeVersion})};
}

/** Imported formal-graph capacity only: typed arrays grow past a public row; this does not invent provider or human-review evidence. */
function largeFormalGraph(input:FormalPackage):FormalPackage{
  const p=structuredClone(input),version=Number.MAX_SAFE_INTEGER;
  for(const beat of p.outline_beats)beat.version=version;
  const beatIds=new Set(p.outline_beats.map(beat=>beat.id));
  function update(value:unknown):void{if(Array.isArray(value)){for(const item of value)update(item);return;}if(!value||typeof value!=='object')return;const row=value as Record<string,unknown>;if(typeof row['id']==='string'&&beatIds.has(row['id'])&&Object.hasOwn(row,'version'))row['version']=version;for(const child of Object.values(row))update(child);}
  update(p);
  p.adaptation_plans[0]=outlineFormalReadCapacityPlan(p.adaptation_plans[0]!);
  const parsed=StoryboardPackageV07.parse(p),report=validatePackage(parsed);if(!report.valid)throw new Error('Invalid imported formal read capacity graph: '+JSON.stringify(report.errors));
  if(Buffer.byteLength(JSON.stringify(parsed.adaptation_plans[0]))<=1101588)throw new Error('Formal read capacity plan must exceed the established oversized-row example');return parsed;
}

/** Trusted import read-capacity data only; no new provider or human-review evidence is created. */
export function outlineFormalReadCapacityPlan(input:FormalPackage['adaptation_plans'][number]){
  const plan=structuredClone(input);
  const references=plan.source.references;
  for(let index=references.length;index<2048;index++)references.push({id:'formal-capacity-reference-'+index,path:'/formal-capacity/'+index+'/'+'界'.repeat(230)});
  plan.recipe.signature_scenes=Array.from({length:32},(_,index)=>({key:'formal-capacity-scene-'+index,description:'\u0001'.repeat(1000),beats:structuredClone(plan.beats)}));
  return plan;
}

export function setSection(object:Record<string,unknown>,path:readonly string[],items:unknown[]):void{
  let parent=object;for(const key of path.slice(0,-1)){const next=parent[key];if(!next||typeof next!=='object'||Array.isArray(next))throw new Error('Overview must retain each section parent');parent=next as Record<string,unknown>;}
  parent[path.at(-1)!]=items;
}
