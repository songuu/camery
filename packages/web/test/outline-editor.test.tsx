import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {OutlineEditor} from '../src/OutlineEditor.js';
import {outlineFixture} from '../../script/test/outline-support.js';
import type {OutlineSourceView} from '@camery/script/outline/http';
const fixture=()=>{
  const {output,context}=outlineFixture();
  const source:OutlineSourceView={version:1,descriptor:{kind:'development',runId:'source-run',runDigest:'a'.repeat(64),briefDigest:'b'.repeat(64),foundationReviewDigest:'c'.repeat(64),episodesReviewDigest:'d'.repeat(64)},material:null,references:context.sourceRefIds.map(id=>({id,path:`/characters/${id}`})),digest:'e'.repeat(64)};
  return {output,source};
};
it('renders all five pieces and craft fields as semantic ordinary controls',()=>{
  const p=fixture();const onChange=vi.fn();const html=renderToStaticMarkup(<OutlineEditor {...p} onChange={onChange} disabled={false}/>);
  for(const label of ['改编说明','故事标题','一句话故事','目标观众','类型承诺','中心冲突','改编取舍','取舍动作','取舍理由','来源引用','题材配方','主题材','辅助题材','题材碰撞','标志场景','失效模式','抽离测试','抽离后的效果','主线仍成立','人物表','人物姓名','人物职能','人物欲望','人物阻力','人物弧光','来源性质','节拍表','所属集号','集内顺序','涉及人物','节拍目标','节拍冲突','转折','后果','分集梗概','分集标题','本集节拍','开场钩子','钩子类型','预计秒数','代价与赌注','付费卡点','情绪强度','资产规划清单','资产类型','叙事用途','关联人物','道具状态变化','变化前','变化后','PlotUnit','压力','升级','反转','释放','下一危机','季冲突引擎','核心问题','主角目标','对抗力量','持续压力','升级机制','季末状态','关联PlotUnit'])expect(html).toContain(label);
  expect(html).toContain('source:clock');expect(html).toContain('/characters/source:clock');expect(html).toContain('阿澄');expect(html).toContain('b1');expect(html).toContain('复仇重生');
  expect(html).toMatch(/<span id="([^"]+)">故事标题<\/span><textarea[^>]*aria-labelledby="\1"/);
  expect(html).toContain('上移节拍表');expect(html).toContain('下移人物表');expect(html).not.toContain('JSON');expect(onChange).not.toHaveBeenCalled();
});
it('keeps stable identifiers read-only and displays removable invalid references',()=>{
  const p=fixture();p.output.beats[0]!.characterIds=['missing-person'];p.output.episodes[0]!.openingHook.beatId='missing-beat';
  const html=renderToStaticMarkup(<OutlineEditor {...p} onChange={()=>{}} disabled={false}/>);
  expect(html).toContain('已失效：missing-person');expect(html).toContain('已失效：missing-beat');expect(html).toContain('移除引用');
  expect(html).toMatch(/<output[^>]*>hero<\/output>/);for(const match of html.matchAll(/<input[^>]*value="hero"[^>]*>/g))expect(match[0]).toContain('type="checkbox"');
});
it('pages large collections without lowering their capacity or losing item counts',()=>{
  const p=fixture();const first=p.output.beats[0]!;p.output.beats=Array.from({length:500},(_,i)=>({...first,id:`beat-${i}`,goal:`唯一目标${i}`}));
  p.output.assets=Array.from({length:256},(_,i)=>({...p.output.assets[0]!,id:`asset-${i}`,name:`唯一资产${i}`}));
  const html=renderToStaticMarkup(<OutlineEditor {...p} onChange={()=>{}} disabled={false}/>);
  expect(html).toContain('节拍表分页');expect(html).toContain('1 / 100');expect(html).toContain('资产规划清单分页');expect(html).toContain('1 / 52');
  expect(html.includes('>唯一目标4</textarea>')).toBe(true);expect(html.includes('>唯一目标5</textarea>')).toBe(false);expect(html.includes('>唯一资产4</textarea>')).toBe(true);expect(html.includes('>唯一资产5</textarea>')).toBe(false);expect(html).toContain('共 500 项');expect(html).toContain('共 256 项');
});
it('supports empty optional collections and disables every editing control for historical views',()=>{
  const p=fixture();p.output.recipe.ablations=[];p.output.assets[0]!.propStates=[];
  const html=renderToStaticMarkup(<OutlineEditor {...p} onChange={()=>{}} disabled={true}/>);
  expect(html).toContain('添加抽离测试');expect(html).toContain('添加道具状态变化');
  for(const match of html.matchAll(/<(input|textarea|select)\b[^>]*>/g))expect(match[0]).toContain('disabled=""');
});
it('retains selected citations beyond the first source page and escapes hostile prose',()=>{
  const p=fixture();p.source.references=Array.from({length:100},(_,i)=>({id:`ref:${i}`,path:`/source/${i}`}));p.output.characters[0]!.origin.sourceRefIds=['ref:99'];p.output.adaptation.title='<img src=x onerror=alert(1)>';
  const html=renderToStaticMarkup(<OutlineEditor {...p} onChange={()=>{}} disabled={false}/>);
  expect(html).toContain('/source/99');expect(html).toContain('1 / 5');expect(html).not.toContain('<img');expect(html).toContain('&lt;img');
});
it('labels frozen source choices with short material prose while preserving the actual reference binding',()=>{
  const p=fixture();const ref=`source:${'f'.repeat(64)}`;p.source.material={characters:[{name:'阿澄 · 港城修钟师'}]};p.source.references=[{id:ref,path:'/characters/0'}];p.output.characters[0]!.origin.sourceRefIds=[ref];
  const html=renderToStaticMarkup(<OutlineEditor {...p} onChange={()=>{}} disabled={false}/>);
  expect(html).toContain('来源 1 · 阿澄 · 港城修钟师');expect(html).toContain(`value="${ref}"`);
  const visible=html.replace(/<[^>]+>/g,'');expect(visible).not.toContain(ref);expect(visible).not.toContain('/characters/0');expect(p.output.characters[0]!.origin.sourceRefIds).toEqual([ref]);
});
it('safely resolves escaped JSON pointers and never reads source prototype properties or accessors',()=>{
  const p=fixture();const accessed=vi.fn(()=>({name:'不应读取'}));const material=Object.create({inherited:{name:'不应读取原型'}}) as Record<string,unknown>;
  material['a/b']={'~key':{description:'长说明'.repeat(100)}};Object.defineProperty(material,'getter',{get:accessed});
  p.source.material=material as OutlineSourceView['material'];p.source.references=[{id:'safe',path:'/a~1b/~0key'},{id:'getter',path:'/getter'},{id:'prototype',path:'/inherited'},{id:'bad-escape',path:'/a~2b'}];
  p.output.characters[0]!.origin.sourceRefIds=['safe'];const html=renderToStaticMarkup(<OutlineEditor {...p} onChange={()=>{}} disabled={false}/>);
  expect(html).toContain('来源 1 · 长说明');expect(html).not.toContain('长说明'.repeat(100));expect(html).toContain('来源 2 · /getter');expect(html).toContain('来源 3 · /inherited');expect(html).toContain('来源 4 · /a~2b');expect(html).not.toContain('不应读取');expect(accessed).not.toHaveBeenCalled();
});
