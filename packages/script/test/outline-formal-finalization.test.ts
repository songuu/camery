import {expect,it} from 'vitest';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {finalizeOutlineChangeSet} from '../src/outline/node/formal-mapping.js';
import type {OutlineMappingDraft} from '../src/outline/node/formal-contracts.js';
function fixture(){
  const target=id('target'),slot=`characters:${target}:replace`;
  const draft:OutlineMappingDraft={version:1,target:{tenantId:id('tenant'),projectId:id('project')},source:{tenantId:'tenant',projectId:'project',runId:'run',runDigest:'a'.repeat(64),briefDigest:'b'.repeat(64),candidateDigest:'c'.repeat(64),reviewDigest:'d'.repeat(64),sourceDigest:'e'.repeat(64)},baseRevision:7,baseRevisions:[{id:target,version:2}],operations:[{slot,op:{op:'replace',collection:'characters',target,value:{id:target,version:2,name:'人改'}}}],reservedIds:[target]};
  return {draft,changeSetId:id('change'),author:{kind:'user' as const,id:id('approver')},operationIds:[{slot,id:id('op')}]};
}
it('finalizes exact fixed operation and base identities without changing the captured draft',()=>{const input=fixture(),before=structuredClone(input),change=finalizeOutlineChangeSet(input);expect(change).toMatchObject({schema_version:'0.7.0-draft',base_revision:7,status:'candidate',ops:[{op_id:input.operationIds[0]!.id,target:input.draft.reservedIds[0],value:{version:2}}]});expect(input).toEqual(before);expect(Object.isFrozen(change.ops)).toBe(true);});
it('refuses an empty ChangeSet after an unchanged replay',()=>{const input=fixture();input.draft.operations=[];input.operationIds=[];expect(()=>finalizeOutlineChangeSet(input)).toThrowError(expect.objectContaining({code:'INCOMPLETE'}));});
it.each(['missing','extra','duplicate','alias-target','alias-change','alias-author','wrong-slot','wrong-base','wrong-id','unreserved','duplicate-target'] as const)('refuses %s operation identity corruption',kind=>{
  const input=fixture(),target=input.draft.reservedIds[0]!,operation=input.draft.operations[0]!.op;
  if(kind==='missing')input.operationIds=[];
  if(kind==='extra')input.operationIds.push({slot:'extra',id:id('extra')});
  if(kind==='duplicate')input.operationIds.push({...input.operationIds[0]!});
  if(kind==='alias-target')input.operationIds[0]!.id=target;
  if(kind==='alias-change')input.operationIds[0]!.id=input.changeSetId;
  if(kind==='alias-author')input.operationIds[0]!.id=input.author.id;
  if(kind==='wrong-slot')input.draft.operations[0]!.slot='different';
  if(operation.op==='replace'&&kind==='wrong-base')operation.value['version']=3;
  if(operation.op==='replace'&&kind==='wrong-id')operation.value['id']=id('other');
  if(kind==='unreserved')input.draft.reservedIds=[];
  if(kind==='duplicate-target'){input.draft.operations.push({...input.draft.operations[0]!,slot:`characters:${target}:remove`,op:{op:'remove',collection:'characters',target}});input.operationIds.push({slot:`characters:${target}:remove`,id:id('op2')});}
  expect(()=>finalizeOutlineChangeSet(input)).toThrowError(expect.objectContaining({code:'CONFLICT'}));
});
it('rejects getters without evaluating application code',()=>{const input=fixture();let calls=0;Object.defineProperty(input.draft,'reservedIds',{get(){calls++;return [];},enumerable:true});expect(()=>finalizeOutlineChangeSet(input)).toThrowError(expect.objectContaining({code:'INVALID_INPUT'}));expect(calls).toBe(0);});
it('does not allow a replacement to act like an unbased insert',()=>{const input=fixture();input.draft.baseRevisions=[];expect(()=>finalizeOutlineChangeSet(input)).toThrowError(expect.objectContaining({code:'CONFLICT'}));});
