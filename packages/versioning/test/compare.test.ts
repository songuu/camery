import {describe,expect,it} from 'vitest';
import {compareVersionSnapshots,createVersionState,submitChangeSet,VersioningError} from '../src/index';
import {changeSet,deepFreeze,fixtureId as id,makePackage} from '../../ir/test/fixtures';
import {upgradeV05Package} from '@camery/ir';

describe('complete bounded snapshot comparison',()=>{
  it('returns sorted, detached object additions, replacements and removals including locks',()=>{
    const before=makePackage(),after=structuredClone(before);
    after.panels=after.panels.filter(row=>row.id!==id('p_end'));
    after.shots[0]!.action='另一动作';after.shots[0]!.version++;
    after.locks.push({id:id('compare-lock'),version:1,target:after.shots[0]!.id,fields:['action'],owner_id:id('owner'),reason:'人工确认'});
    after.revision={number:6,status:'candidate',note:'比较来源'};
    const differences=compareVersionSnapshots(before,deepFreeze(after));
    expect(differences.map(row=>[row.collection,row.kind])).toEqual([['locks','add'],['panels','remove'],['shots','replace']]);
    expect(differences[0]).toMatchObject({before:null,after:after.locks[0]});
    expect(differences[1]).toMatchObject({id:id('p_end'),before:before.panels.find(row=>row.id===id('p_end')),after:null});
    differences[2]!.after!['action']='仅修改结果';
    expect(after.shots[0]!.action).toBe('另一动作');
    expect(compareVersionSnapshots(before,before)).toEqual([]);
    expect(compareVersionSnapshots(after,before).map(row=>row.kind)).toEqual(['remove','add','replace']);
  });

  it('sorts identities deterministically and ignores collection storage order',()=>{
    const before=makePackage(),after=structuredClone(before);
    after.panels.reverse();expect(compareVersionSnapshots(before,after)).toEqual([]);
    after.shots.reverse();after.shots.forEach(row=>{row.action='更新';});
    const expected=after.shots.map(row=>row.id).sort();
    expect(compareVersionSnapshots(before,after).map(row=>row.id)).toEqual(expected);
  });

  it.each(['project','package','schema'] as const)('refuses a different %s identity',kind=>{
    const before=makePackage(),after=structuredClone(before);
    if(kind==='project')after.project.id=id('other-project');
    if(kind==='package')after.package_id=id('other-package');
    const target=kind==='schema'?upgradeV05Package(after):after;
    expect(()=>compareVersionSnapshots(before,target)).toThrow(VersioningError);
  });

  it('represents complete project metadata and refuses lineage instead of silently omitting it',()=>{
    const before=makePackage(),metadata=structuredClone(before),lineage=structuredClone(before);
    metadata.project.title='另一个标题';
    lineage.shot_lineage.push({from_ids:[id('old-shot')],to_ids:[id('sh_1')],revision:5});
    expect(compareVersionSnapshots(before,metadata)).toEqual([{collection:'projects',id:before.project.id,kind:'replace',before:before.project,after:metadata.project}]);
    expect(()=>compareVersionSnapshots(before,lineage)).toThrow(/COMPARE_UNSUPPORTED/);
  });

  it.each(['scenes','episodes'] as const)('includes automatic project counts from an actual added %s candidate',collection=>{
    const before=makePackage(),value={...before[collection][0]!,id:id('new-'+collection),order_key:'a2'};
    const request=changeSet([{op:'add',op_id:id('add-'+collection),collection,value}]);
    const pending=submitChangeSet(createVersionState(before),request);
    expect(pending.issues).toEqual([]);expect(pending.status).toBe('candidate');
    const after=pending.state.changes[0]!.preview!,differences=compareVersionSnapshots(before,after);
    expect(differences.map(row=>row.collection)).toEqual([collection,'projects'].sort());
    expect(differences.find(row=>row.collection==='projects')).toEqual({collection:'projects',id:before.project.id,kind:'replace',before:before.project,after:after.project});
    expect(differences.find(row=>row.collection===collection)).toMatchObject({id:value.id,kind:'add',before:null,after:value});
    expect(before.project.scope[collection==='scenes'?'expected_scene_count':'expected_episode_count']).toBe(2);
    expect(after.project.scope[collection==='scenes'?'expected_scene_count':'expected_episode_count']).toBe(3);
  });

  it('allows exactly 500 differences and rejects 501 without truncation',()=>{
    const before=makePackage(),after=structuredClone(before);
    after.panels=Array.from({length:500},(_,index)=>({...before.panels[0]!,id:id('added-panel-'+index)})).concat(before.panels);
    expect(compareVersionSnapshots(before,after)).toHaveLength(500);
    after.project.title='也计入项目差异';
    expect(()=>compareVersionSnapshots(before,after)).toThrow(/INPUT_LIMIT/);
    after.panels.shift();
    const bounded=compareVersionSnapshots(before,after);
    expect(bounded).toHaveLength(500);expect(bounded.at(-1)!.collection).toBe('projects');
    after.project.title=before.project.title;
    after.panels.unshift({...before.panels[0]!,id:id('added-panel-0')});
    after.panels.push({...before.panels[0]!,id:id('over-limit-panel')});
    expect(()=>compareVersionSnapshots(before,after)).toThrow(/INPUT_LIMIT/);
  });

  it('rejects non-JSON and invalid snapshot inputs explicitly',()=>{
    const before=makePackage();
    expect(()=>compareVersionSnapshots(before,{...before,project:{...before.project,title:undefined}} as never)).toThrow(/NON_JSON/);
    expect(()=>compareVersionSnapshots(before,{...before,revision:{number:0,status:'candidate',note:null}} as never)).toThrow(/INVALID_SNAPSHOT/);
    const invalid=structuredClone(before);invalid.shots[0]!.scene_id=id('missing-scene');
    expect(()=>compareVersionSnapshots(before,invalid)).toThrow(/INVALID_SNAPSHOT/);
  });
});
