import {describe,expect,it} from 'vitest';
import type {ChangeOp} from '@camery/ir';
import {adoptChangeSet,createVersionState,selectChangeOperations,submitChangeSet} from '../src/index';
import type {Principal,VersionState} from '../src/types';
import {changeSet,deepFreeze,fixtureId as id,makePackage} from '../../ir/test/fixtures';

const author:Principal={kind:'user',id:id('selector')};
const input={sourceChangeId:id('cs_test'),operationIds:[id('op-second')],changeId:id('selection'),author};
function candidate():VersionState{
  const request=changeSet([
    {op:'update',op_id:id('op-first'),collection:'shots',target:id('sh_1'),set:{action:'第一处'}},
    {op:'update',op_id:id('op-second'),collection:'shots',target:id('sh_2'),set:{action:'第二处'}},
  ],{base_revisions:[{id:id('sh_1'),version:1},{id:id('sh_2'),version:5},{id:id('sc_1'),version:1}]});
  return submitChangeSet(createVersionState(makePackage()),request).state;
}

describe('original-operation selection',()=>{
  it('creates a detached candidate in original order preserving all read bases and current snapshot base',()=>{
    const state=candidate();state.head.revision.number=6;
    const source=state.changes[0]!,frozen=deepFreeze(state);
    const selected=selectChangeOperations(frozen,{...input,operationIds:[id('op-second'),id('op-first')]});
    expect(selected).toMatchObject({id:input.changeId,author,status:'candidate',base_revision:6,base_revisions:source.request.base_revisions});
    expect(selected.ops.map(op=>op.op_id)).toEqual(source.request.ops.map(op=>op.op_id));
    const first=selected.ops[0]!;
    if(first.op==='update')first.set['action']='只修改返回值';
    selected.base_revisions.pop();
    expect(source.request.base_revisions).toHaveLength(3);
    expect(source.request.ops[0]).toMatchObject({set:{action:'第一处'}});
    expect(state.changes).toHaveLength(1);
  });

  it('retains read conflicts and runs the existing full validation when the result is previewed',()=>{
    const state=candidate(),selected=selectChangeOperations(state,input);
    const other=changeSet([{op:'update',op_id:id('other-op'),collection:'shots',target:id('sh_1'),set:{action:'并发修改'}}],{id:id('other-change'),base_revisions:[{id:id('sh_1'),version:1}]});
    const pending=submitChangeSet(state,other);
    const adopted=adoptChangeSet(pending.state,other.id,{actor:author,scope:{kind:'project',id:state.head.project.id},at:'2026-11-20T00:00:00.000Z',authorize:()=>true});
    expect(submitChangeSet(adopted.state,selected).status).toBe('conflicted');
    expect(submitChangeSet(state,selected).status).toBe('candidate');
  });

  it('keeps reference and lock enforcement on the ordinary preview path',()=>{
    const pkg=makePackage(),asset={...pkg.assets[0]!,id:id('selected-asset')},reference={...pkg.asset_references[0]!,id:id('selected-reference'),asset_id:asset.id};
    const request=changeSet([{op:'add',op_id:id('asset-op'),collection:'assets',value:asset},{op:'add',op_id:id('reference-op'),collection:'asset_references',value:reference}]);
    const source=submitChangeSet(createVersionState(pkg),request);
    expect(source.status).toBe('candidate');
    const selection=selectChangeOperations(source.state,{...input,operationIds:[id('reference-op')]});
    expect(submitChangeSet(source.state,selection).issues.map(issue=>issue.code)).toContain('MISSING_REFERENCE');
    const locked=candidate();
    locked.head.locks.push({id:id('late-lock'),version:1,target:id('sh_2'),fields:['action'],owner_id:author.id,reason:'采用前锁定'});
    expect(submitChangeSet(locked,selectChangeOperations(locked,input)).issues.map(issue=>issue.code)).toContain('LOCKED');
  });

  it.each([[],[id('op-first'),id('op-first')],[id('unknown-op')],Array.from({length:501},(_,index)=>id('op-'+index))].map(operationIds=>({operationIds})))('rejects empty, duplicate, missing and oversized selections',({operationIds})=>{
    expect(()=>selectChangeOperations(candidate(),{...input,operationIds})).toThrow(/SELECTION_INVALID|INPUT_LIMIT/);
  });

  it('rejects missing, noncandidate or invalid-preview sources',()=>{
    const missing=candidate();missing.changes=[];
    const decided=candidate();decided.changes[0]!.status='adopted';
    const absent=candidate();absent.changes[0]!.preview=null;
    const invalid=candidate();invalid.changes[0]!.preview!.shots[0]!.scene_id=id('missing-scene');
    const malformed=candidate();malformed.changes[0]!.preview!.revision.number=0;
    const invalidRequest=candidate();invalidRequest.changes[0]!.request.status='adopted';
    const malformedRequest=candidate();malformedRequest.changes[0]!.request.ops=[];
    const formalPreview=candidate();formalPreview.changes[0]!.preview!.revision.status='adopted';
    for(const state of [missing,decided,absent,invalid,malformed,invalidRequest,malformedRequest,formalPreview])expect(()=>selectChangeOperations(state,input)).toThrow(/SELECTION_SOURCE/);
  });

  it('requires a distinct valid identity and explicit human author supplied by its host',()=>{
    for(const patch of [{changeId:input.sourceChangeId},{changeId:'invalid'},{sourceChangeId:'invalid'},{author:{kind:'agent_run',id:id('agent')}},{author:{kind:'user',id:'invalid'}}]){
      expect(()=>selectChangeOperations(candidate(),{...input,...patch} as typeof input)).toThrow(/SELECTION_INVALID|SELECTION_AUTHORITY/);
    }
    expect(()=>selectChangeOperations(candidate(),{...input,author:{...author,id:undefined}} as never)).toThrow(/NON_JSON/);
    for(const value of [null,{...input,author:null},{...input,operationIds:null}])expect(()=>selectChangeOperations(candidate(),value as never)).toThrow(/SELECTION_INVALID|SELECTION_AUTHORITY/);
    const invalidHead=candidate();invalidHead.head.revision.number=0;
    expect(()=>selectChangeOperations(invalidHead,input)).toThrow(/SELECTION_INVALID/);
  });

  it.each(['split','merge','lock','unlock','unlock_line','upgrade_schema'] as const)('refuses selecting %s without changing the original path',op=>{
    const pkg=structuredClone(makePackage()),op_id=id('op-second'),target=id('sh_1');
    const {version:_version,...draft}=pkg.shots[0]!;
    let operation:ChangeOp;
    if(op==='split')operation={op,op_id,target,into:[{...draft,id:id('part-1'),duration:{planned:2,measured:null}},{...draft,id:id('part-2'),duration:{planned:2,measured:null}}]};
    else if(op==='merge')operation={op,op_id,targets:[target,id('sh_2')],into:{...draft,id:id('joined'),beat_refs:[...draft.beat_refs,...pkg.shots[1]!.beat_refs],duration:{planned:10,measured:null}}};
    else if(op==='lock')operation={op,op_id,lock_id:id('new-lock'),target,fields:['action'],reason:'人工确认'};
    else if(op==='unlock'){
      pkg.locks.push({id:id('existing-lock'),version:1,target,fields:['action'],owner_id:id('user_1'),reason:'人工确认'});
      operation={op,op_id,lock_id:id('existing-lock'),reason:'人工解锁'};
    }else if(op==='unlock_line'){
      pkg.lines[0]!.locked=true;operation={op,op_id,target:pkg.lines[0]!.id,reason:'人工解锁'};
    }else operation={op,op_id,from:'0.5.0-draft',to:'0.6.0-draft'};
    const bases=Object.values(pkg).filter(Array.isArray).flatMap(rows=>rows.filter((row):row is {id:string;version:number}=>row&&typeof row==='object'&&'id' in row&&'version' in row).map(row=>({id:row.id,version:row.version})));
    const request=changeSet([operation],{base_revisions:bases,...(op==='upgrade_schema'?{schema_version:'0.6.0-draft'}:{})});
    const pending=submitChangeSet(createVersionState(pkg),request);
    expect(pending.issues).toEqual([]);
    expect(pending.status).toBe('candidate');
    expect(()=>selectChangeOperations(pending.state,input)).toThrow(/SELECTION_UNSUPPORTED/);
  });
});
