import {expect,it} from 'vitest';
import {adoptChangeSet,createVersionState,submitChangeSet} from '../src/engine';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';

const approval={actor:{kind:'user' as const,id:id('user_1')},scope:{kind:'project' as const,id:id('prj_demo')},at:'2026-11-17T06:00:00.000Z',authorize:()=>true};
it('keeps the original and persisted replacement request immutable through preview and adoption',()=>{
  const head=makePackage();const character=head.characters[0]!;const request=changeSet([{op:'replace',op_id:id('isolation-replace'),collection:'characters',target:character.id,value:{...character,name:'明确编辑后的名字'}}],{base_revisions:[{id:character.id,version:character.version}]});const original=structuredClone(request);
  const submitted=submitChangeSet(createVersionState(head),request);expect(submitted.status).toBe('candidate');expect(request).toEqual(original);expect(submitted.state.changes[0]!.request).toEqual(original);
  expect(submitted.state.changes[0]!.preview!.characters[0]!.version).toBe(character.version+1);const adopted=adoptChangeSet(submitted.state,request.id,approval);expect(adopted.status).toBe('adopted');expect(adopted.state.changes[0]!.request).toEqual(original);expect(request).toEqual(original);
});
it('does not mutate an added object request when a later explicit human operation changes its draft fields',()=>{
  const head=makePackage();const line={...head.lines[0]!,id:id('isolation-new-line'),version:1,order_key:'zz',locked:false};
  const request=changeSet([{op:'add',op_id:id('isolation-add'),collection:'lines',value:line},{op:'lock',op_id:id('isolation-lock-op'),lock_id:id('isolation-lock'),target:line.id,fields:['text'],reason:'明确锁定新增正文'}],{base_revisions:[]});const original=structuredClone(request);
  const submitted=submitChangeSet(createVersionState(head),request);expect(submitted.status).toBe('candidate');expect(request).toEqual(original);expect(submitted.state.changes[0]!.request).toEqual(original);expect(submitted.state.changes[0]!.preview!.lines.find(value=>value.id===line.id)!.locked).toBe(true);
  expect(adoptChangeSet(submitted.state,request.id,approval).status).toBe('adopted');expect(request).toEqual(original);
});
