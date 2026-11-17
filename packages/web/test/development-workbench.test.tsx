import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {DevelopmentWorkbench,FoundationEditor,EpisodesEditor} from '../src/DevelopmentWorkbench.js';
import {episodeFixture} from '../../script/test/episode-fixture.js';
import type {DevelopmentWorkbenchProps} from '../src/DevelopmentWorkbench.js';
function props():DevelopmentWorkbenchProps{
  const f=episodeFixture();const {tenantId:_tenant,projectId:_project,...brief}=f.brief;const at='2026-11-16T12:00:00.000Z';return {capabilities:{canStart:false,modelLabel:null,budget:null,defaultEpisodeCount:10},briefs:{items:[{briefId:brief.briefId,revision:1,ideaPreview:brief.idea,actorId:'human',createdAt:at}],nextCursor:null},runs:{items:[],nextCursor:null},savedBrief:null,composeVersion:0,detail:{runId:'run',briefId:brief.briefId,briefRevision:1,createdAt:at,sourceChanged:false,foundationCandidateDigest:'a'.repeat(64),foundationReviewStatus:null,episodesCandidateDigest:null,episodesReviewStatus:null,stage:'foundation',state:'awaiting_review',task:null,brief,budget:{currency:'CNY',tokens:200,costMicros:0},foundation:{candidate:{digest:'a'.repeat(64),output:f.foundation},review:null},episodes:{candidate:null,review:null}},status:null,canEdit:true,canReview:true,busy:null,error:null,message:null,onSave:vi.fn(),onStart:vi.fn(),onNew:vi.fn(),onOpenBrief:vi.fn(),onOpenRun:vi.fn(),onMoreBriefs:vi.fn(),onMoreRuns:vi.fn(),onRefresh:vi.fn(),onConfirm:vi.fn(),onReject:vi.fn()};
}
it('renders every foundation and episode field as ordinary form controls, with stable identity and reference choices',()=>{
  const f=episodeFixture();const foundation=renderToStaticMarkup(<FoundationEditor output={f.foundation} onChange={()=>{}} disabled={false}/>);
  for(const label of ['故事标题','时代','世界与环境','人物欲望','人物阻力','人物弧光','关系起点','关系终点','核心命题','中心冲突','代价与赌注','主线推进','主线结局','驱动主线的人物','主线涉及的规则','待解问题','添加规则','添加人物','添加关系','删除人物'])expect(foundation).toContain(label);
  expect(foundation).toMatch(/<span id="([^"]+)">故事标题<\/span><textarea[^>]*aria-labelledby="\1"/);
  expect(foundation).toContain('人物 1 · 林舟（主角）');expect(foundation).toContain('人物 2 · 林舟（对抗者）');
  const episodes=renderToStaticMarkup(<EpisodesEditor output={f.output} foundation={f.foundation} onChange={()=>{}} disabled={false}/>);for(const label of ['集号','分集标题','分集梗概','本集目标','本集冲突','转折','收尾与悬念','本集人物','本集规则','添加一集','分集分页'])expect(episodes).toContain(label);
});
it('restores saved ideas before generation and explicitly explains the next paid stage',()=>{
  const p=props();const html=renderToStaticMarkup(<DevelopmentWorkbench {...p}/>);expect(html).toContain('已保存创意');expect(html).toContain('尚未配置文本模型');expect(html).toContain('确认设定并生成分集');expect(html).toContain('原始候选');expect(p.onStart).not.toHaveBeenCalled();
});
it('makes stale candidates read-only and makes unknown results explicit without a resend control',()=>{
  const p=props();p.detail!.sourceChanged=true;p.detail!.state='reconciling';const html=renderToStaticMarkup(<DevelopmentWorkbench {...p}/>);expect(html).toContain('系统不会自动重发');expect(html).toContain('不能首次确认');expect(html).toMatch(/<button[^>]*disabled=""[^>]*>确认设定并生成分集/);expect(html).not.toContain('重新发送');
});
it('keeps a saved brief discoverable when its bounded preview contains only whitespace',()=>{
  const p=props();p.briefs!.items[0]!.ideaPreview=' '.repeat(120);const html=renderToStaticMarkup(<DevelopmentWorkbench {...p}/>);
  expect(html).toContain('查看已保存创意');expect(html).toContain(`${p.briefs!.items[0]!.briefId} · 修订 1`);expect(p.onOpenBrief).not.toHaveBeenCalled();
});
