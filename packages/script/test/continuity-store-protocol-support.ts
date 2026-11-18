import {EventEmitter} from 'node:events';
import type {Pool,PoolClient} from 'pg';
import {createVersionState,submitChangeSet,adoptChangeSet} from '@camery/versioning';
import {fixtureId as id,makePackage} from '../../ir/test/fixtures.js';
import {captureContinuityContext} from '../src/continuity/context.js';
import {continuityDigest} from '../src/continuity/node/digest.js';
import {CONTINUITY_CONTEXT_BYTES} from '../src/continuity/contracts.js';
import {PostgresContinuityStore} from '../src/continuity/node/store.js';
import {nativeEpisodeSnapshotPins} from '../src/continuity/node/handoff.js';
import {reduceEpisodeContinuity} from '../src/continuity/reduce.js';
import type {ContinuityDraft} from '../src/continuity/contracts.js';
import {CONTINUITY_PREVIOUS_BYTES} from '../src/continuity/node/persistence-contracts.js';
import type {ContinuityReviewHost,ContinuityPrepare,ContinuityPrevious} from '../src/continuity/node/persistence-contracts.js';

export {id};
export type Row=Record<string,unknown>;
type Tables={candidates:Map<string,Row>;reviews:Map<string,Row>};
export type Fault='connect'|'begin'|'settings'|'project'|'snapshot'|'advisory'|'candidate-read'|'candidate-write'|'review-read'|'review-write'|'commit-before'|'commit-after'|'rollback'|'release'|'on'|'remove';
const copyTables=(value:Tables):Tables=>({candidates:structuredClone(value.candidates),reviews:structuredClone(value.reviews)});
const keyOf=(values:readonly unknown[])=>JSON.stringify(values.slice(0,3));
const privateFailure=()=>new Error('private-protocol-postgres://credential');
class Client extends EventEmitter{
  tx:Tables|null=null;
  readonly calls:string[]=[];
  constructor(readonly owner:ContinuityMemory){super();}
  override on(event:string|symbol,listener:(...args:unknown[])=>void):this{this.owner.hit('on');return super.on(event,listener);}
  override removeListener(event:string|symbol,listener:(...args:unknown[])=>void):this{this.owner.hit('remove');return super.removeListener(event,listener);}
  release(destroy=false):void{this.owner.releases.push(destroy);this.owner.hit('release');}
  async query(text:string,values:unknown[]=[]):Promise<{rows:Row[]}>{
    this.calls.push(text);this.owner.calls.push(text);await this.owner.before?.(text,values,this as unknown as PoolClient);
    let rows:Row[]=[];
    if(text.startsWith('BEGIN')){this.owner.hit('begin');this.tx=copyTables(this.owner.tables);}
    else if(text.startsWith('SET LOCAL'))this.owner.hit('settings');
    else if(text==='COMMIT'){this.owner.hit('commit-before');if(this.tx)this.owner.tables=copyTables(this.tx);this.tx=null;this.owner.hit('commit-after');}
    else if(text==='ROLLBACK'){this.owner.hit('rollback');this.tx=null;}
    else if(text.includes('pg_advisory_xact_lock'))this.owner.hit('advisory');
    else if(text.includes('FROM camery_versioning.projects')){this.owner.hit('project');if(values[0]===this.owner.target.tenantId&&values[1]===this.owner.target.projectId)rows=[{tenant_id:values[0],project_id:values[1],package_id:this.owner.state.head.package_id,head_revision:String(this.owner.state.head.revision.number),write_version:String(this.owner.writeVersion)}];}
    else if(text.includes('FROM camery_versioning.snapshots')){this.owner.hit('snapshot');const pkg=this.owner.snapshots.get(Number(values[2]));if(values[0]===this.owner.target.tenantId&&values[1]===this.owner.target.projectId&&pkg)rows=[{package:structuredClone(pkg)}];}
    else if(text.includes('FROM camery_versioning.object_revisions'))rows=this.owner.state.revisions.filter(value=>value.object_id===values[2]&&value.version===Number(values[3])).map(value=>({object_id:value.object_id,version:value.version,snapshot_revision:value.snapshot_revision,change_id:value.change_set_id,record:structuredClone(value)}));
    else if(text.includes('FROM camery_versioning.adoptions'))rows=this.owner.state.adoptions.filter(value=>value.change_set_id===values[2]&&value.to_revision===Number(values[3])).map(value=>({change_id:value.change_set_id,from_revision:value.from_revision,to_revision:value.to_revision,record:structuredClone(value)}));
    else if(text.includes('FROM camery_versioning.changes'))rows=this.owner.state.changes.filter(value=>value.request.id===values[2]).map(value=>({status:value.status,record:structuredClone(value)}));
    else if(text.includes('camery_continuity.candidates')||text.includes('camery_continuity.reviews')){
      const table=text.includes('camery_continuity.candidates')?'candidates':'reviews',writing=text.startsWith('INSERT'),point=(table==='candidates'?(writing?'candidate-write':'candidate-read'):(writing?'review-write':'review-read'));
      this.owner.hit(point);const tables=this.tx??this.owner.tables,key=keyOf(values);
      if(writing){if(tables[table].has(key))throw new Error('Owned protocol duplicate');const columns=/\(([^)]+)\)/.exec(text)?.[1]?.split(',');if(!columns)throw new Error('Owned protocol INSERT columns missing');const row:Row={};for(const [index,column] of columns.entries())row[column]=column==='record'?JSON.parse(String(values[index])):values[index];tables[table].set(key,row);rows=[structuredClone(row)];}
      else{const row=tables[table].get(key);if(row)rows=[structuredClone(row)];}
    }else throw new Error('Unsupported owned continuity protocol operation');
    return {rows:this.owner.transform?.(text,structuredClone(rows))??rows};
  }
}

export class ContinuityMemory{
  state=createVersionState(structuredClone(makePackage()));
  writeVersion=1;
  readonly target={tenantId:id('protocol-native-tenant'),projectId:this.state.head.project.id};
  readonly scope={tenantId:'protocol-tenant',projectId:'protocol-project'};
  readonly key={...this.scope,candidateId:'original-candidate'};
  readonly host:ContinuityReviewHost={actor:{kind:'human',id:'protocol-editor'},scope:this.scope,at:'2026-11-18T14:00:00.000Z',authorize:()=>true};
  readonly calls:string[]=[];
  readonly clients:Client[]=[];
  readonly releases:boolean[]=[];
  tables:Tables={candidates:new Map(),reviews:new Map()};
  snapshots=new Map([[this.state.head.revision.number,structuredClone(this.state.head)]]);
  before:((text:string,values:unknown[],client:PoolClient)=>Promise<void>|void)|undefined;
  transform:((text:string,rows:Row[])=>Row[])|undefined;
  readonly faults=new Map<Fault,unknown>();
  constructor(){this.state.head.revision.status='adopted';}
  hit(point:Fault):void{if(this.faults.has(point)){const value=this.faults.get(point);this.faults.delete(point);throw value;}}
  fail(point:Fault,error:unknown=privateFailure()):void{this.faults.set(point,error);}
  readonly pool={connect:async()=>{this.hit('connect');const client=new Client(this);this.clients.push(client);return client as unknown as PoolClient;}} as unknown as Pool;
  readonly store=new PostgresContinuityStore(this.pool);
  draft():ContinuityDraft{
    const context=captureContinuityContext(this.state.head),event=context.events.find(value=>value.ref.id===id('b_open'))!;
    return {version:1,episodeId:event.episodeId,events:[{id:'assert-note',op:'assert_fact',factId:'note',kind:'fact',text:'发现便签',evidence:{event:{...event.ref},quote:event.text}},{id:'learn-note',op:'learn',characterId:id('char_lin'),factId:'note',source:{kind:'witness'},evidence:{event:{...event.ref},quote:event.text}}]};
  }
  command(candidateId=this.key.candidateId):ContinuityPrepare{return {key:{...this.key,candidateId},target:{...this.target},expectedSnapshotRevision:this.state.head.revision.number,expectedPackageDigest:continuityDigest(this.state.head,CONTINUITY_CONTEXT_BYTES),draft:this.draft()};}
  selection(){return {scope:this.scope,target:this.target,episodeId:id('ep_1')};}
  counts(){return {candidates:this.tables.candidates.size,reviews:this.tables.reviews.size};}
  candidateRow(key=this.key):Row{const row=this.tables.candidates.get(keyOf([key.tenantId,key.projectId,key.candidateId]));if(!row)throw new Error('Expected owned prepared row');return row;}
  reviewRow(key=this.key):Row{const row=this.tables.reviews.get(keyOf([key.tenantId,key.projectId,key.candidateId]));if(!row)throw new Error('Expected owned review row');return row;}
  advance(){
    const author={kind:'user' as const,id:id('protocol-author')},request={schema_version:this.state.head.schema_version,id:id('protocol-next-'+this.state.head.revision.number),author,status:'candidate',base_revision:this.state.head.revision.number,base_revisions:[],ops:[{op:'add',op_id:id('protocol-next-op-'+this.state.head.revision.number),collection:'props',value:{id:id('protocol-next-prop-'+this.state.head.revision.number),version:1,name:'无关后续道具',description:'实际原生采用，用于测试来源已经变化'}}]};
    const prepared=submitChangeSet(this.state,request);if(prepared.status!=='candidate')throw new Error('Expected native protocol preparation');const adopted=adoptChangeSet(prepared.state,request.id,{actor:author,scope:{kind:'project',id:this.target.projectId},at:'2026-11-18T14:05:00.000Z',authorize:()=>true});if(adopted.status!=='adopted')throw new Error('Expected native protocol adoption');this.state=adopted.state;this.writeVersion+=2;this.snapshots.set(this.state.head.revision.number,structuredClone(this.state.head));
  }
}

/** Synthetic declarations are actually reduced and their legacy projection actually passes the native human-adoption engine. */
export function continuityPreviousFixture(){
  const memory=new ContinuityMemory(),context=captureContinuityContext(memory.state.head),ledger=reduceEpisodeContinuity(context,memory.draft()).ledger;
  const snapshot={id:id('protocol-previous-snapshot'),version:1,episode_id:id('ep_1'),based_on:nativeEpisodeSnapshotPins(memory.state.head,id('ep_1')),status:'adopted' as const,facts:ledger.facts.map(fact=>fact.text),knowledge:ledger.knowledge.map(value=>({character_id:value.characterId,fact:ledger.facts.find(fact=>fact.id===value.factId)!.text,source:value.learned.evidence.quote})),characters:[],plot_threads:[]};
  const author={kind:'user' as const,id:id('protocol-previous-author')},request={schema_version:memory.state.head.schema_version,id:id('protocol-previous-change'),author,status:'candidate',base_revision:memory.state.head.revision.number,base_revisions:[],ops:[{op:'add',op_id:id('protocol-previous-op'),collection:'episode_state_snapshots',value:snapshot}]};
  const prepared=submitChangeSet(memory.state,request);if(prepared.status!=='candidate')throw new Error('Expected actual native snapshot candidate');const adopted=adoptChangeSet(prepared.state,request.id,{actor:author,scope:{kind:'episode',id:id('ep_1')},at:'2026-11-18T14:01:00.000Z',authorize:()=>true});if(adopted.status!=='adopted')throw new Error('Expected actual native snapshot adoption');memory.state=adopted.state;memory.writeVersion=3;memory.snapshots.set(memory.state.head.revision.number,structuredClone(memory.state.head));
  const body={version:1 as const,id:'trusted-previous',scope:memory.scope,target:memory.target,snapshot:{id:snapshot.id,version:1},changeId:request.id,adoptedRevision:adopted.state.head.revision.number,ledger};const previous:ContinuityPrevious={...body,digest:continuityDigest(body,CONTINUITY_PREVIOUS_BYTES)};
  return {memory,previous,selection:{scope:memory.scope,target:memory.target,episodeId:id('ep_2')}};
}
