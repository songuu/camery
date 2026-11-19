import type {Pool} from 'pg';
import {createVersionState,submitChangeSet,adoptChangeSet} from '@camery/versioning';
import {makeContinuityPackage} from '../../ir/test/continuity-ledger-fixture.js';
import {ContinuityMemory,id} from './continuity-store-protocol-support.js';
import type {Row} from './continuity-store-protocol-support.js';
import {PostgresContinuityStore} from '../src/continuity/node/store.js';
import {prepareContinuityNativeMapping} from '../src/continuity/node/native-mapping.js';
import {insertContinuityNativeBinding,insertContinuityNativeReceipt} from '../src/continuity/node/native-records.js';
import {CONTINUITY_NATIVE_RECORD_BYTES} from '../src/continuity/node/native-contracts.js';
import {continuityDigest} from '../src/continuity/node/digest.js';
import {captureContinuityContext} from '../src/continuity/context.js';

/** SQL protocol double plus actual pure native engine; only separate PG tests prove SQL/role/atomicity. */
export async function nativeContinuityFixture(adopt=true){
  const memory=new ContinuityMemory(),head=makeContinuityPackage();head.continuity_snapshots=[];
  memory.state=createVersionState(head);memory.target.projectId=head.project.id;memory.snapshots=new Map([[head.revision.number,structuredClone(head)]]);
  const tables={native_bindings:[] as Row[],native_adoptions:[] as Row[]},calls:string[]=[];
  const pool={connect:async()=>{
    const original=await memory.pool.connect();return new Proxy(original,{get(target,property){
      if(property==='query')return async(text:string,values:unknown[]=[])=>{
        const table=text.includes('camery_continuity.native_bindings')?'native_bindings':text.includes('camery_continuity.native_adoptions')?'native_adoptions':null;
        if(!table)return target.query(text,values);calls.push(text);
        if(text.startsWith('INSERT')){
          const columns=/\(([^)]+)\)/.exec(text)![1]!.split(','),row:Row={};for(const [index,column] of columns.entries())row[column]=column==='record'?JSON.parse(String(values[index])):values[index];
          if(!tables[table].some(old=>old['formal_tenant_id']===row['formal_tenant_id']&&old['formal_project_id']===row['formal_project_id']&&old['change_id']===row['change_id']))tables[table].push(row);
          return {rows:[]};
        }
        return {rows:structuredClone(tables[table].filter(row=>row['formal_tenant_id']===values[0]&&row['formal_project_id']===values[1]&&(text.includes('AND snapshot_id=$3')?row['snapshot_id']===values[2]&&Number(row['snapshot_version'])===values[3]:row['change_id']===values[2])))};
      };
      const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
    }});
  }} as unknown as Pool;
  const store=new PostgresContinuityStore(pool),command=memory.command(),context=captureContinuityContext(head),beat=context.events.find(row=>row.ref.id===id('b_open'))!;
  command.draft.events.push({id:'state',op:'set_character',value:{characterId:id('char_lin'),summary:'核对后继续调查。',appearance:null,spot:null,holding:[]},evidence:{event:beat.ref,quote:beat.text}},
    {id:'plant',op:'plant',threadId:'origin',summary:'调查便签来源。',payoffEpisodeId:context.episodes[1]!.id,evidence:{event:beat.ref,quote:beat.text}});
  const original=await store.prepare(command,memory.host),edited=structuredClone(command.draft),fact=edited.events[0]!;if(fact.op!=='assert_fact')throw new Error('Expected fixture fact');fact.text='已由人类核对的便签事实。';
  const reviewed=await store.confirm(command.key,{candidateDigest:original.preparation.candidate.digest,draft:edited,waivers:[]},memory.host);
  const mapping=prepareContinuityNativeMapping({head,progress:reviewed,changeId:id('native-proof-change'),snapshotId:id('native-proof-snapshot'),operationId:id('native-proof-op'),author:{kind:'user',id:id('native-proof-author')}});
  async function commit(candidate=mapping){
    const pending=submitChangeSet(memory.state,candidate.request);if(pending.status!=='candidate')throw new Error('Expected actual native fixture candidate');memory.state=pending.state;
    const client=await pool.connect();try{await insertContinuityNativeBinding(client,candidate.binding);
      const adopted=adoptChangeSet(memory.state,candidate.request.id,{actor:candidate.request.author,scope:{kind:'episode',id:candidate.binding.episodeId},at:'2026-11-19T03:00:00.000Z',authorize:()=>true});if(adopted.status!=='adopted')throw new Error('Expected actual native fixture adoption');
      memory.state=adopted.state;memory.writeVersion+=2;memory.snapshots.set(memory.state.head.revision.number,structuredClone(memory.state.head));const audit=adopted.state.adoptions.at(-1)!;
      const body={version:1 as const,key:candidate.binding.key,target:candidate.binding.target,bindingDigest:candidate.binding.digest,reviewDigest:candidate.binding.reviewDigest,changeId:candidate.binding.changeId,snapshot:candidate.binding.snapshot,ledgerDigest:continuityDigest(candidate.snapshot.ledger,CONTINUITY_NATIVE_RECORD_BYTES),fromRevision:audit.from_revision,toRevision:audit.to_revision,actor:{kind:'user' as const,id:audit.actor_id},scope:{kind:'episode' as const,id:candidate.binding.episodeId},at:audit.at};
      const receipt={...body,digest:continuityDigest(body,CONTINUITY_NATIVE_RECORD_BYTES)};await insertContinuityNativeReceipt(client,receipt);return receipt;
    }finally{client.release();}
  }
  const receipt=adopt?await commit():null;return {memory,pool,store,command,original,reviewed,mapping,tables,calls,receipt,commit,selection:{scope:memory.scope,target:memory.target,episodeId:context.episodes[1]!.id}};
}
export {id};
export type NativeFixture=Awaited<ReturnType<typeof nativeContinuityFixture>>;
