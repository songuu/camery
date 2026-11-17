import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {DevelopmentWorkbench,FoundationEditor,EpisodesEditor} from '../src/DevelopmentWorkbench.js';
import {episodeFixture} from '../../script/test/episode-fixture.js';
import type {DevelopmentWorkbenchProps} from '../src/DevelopmentWorkbench.js';
function props():DevelopmentWorkbenchProps{
  const f=episodeFixture();const {tenantId:_tenant,projectId:_project,...brief}=f.brief;const at='2026-11-16T12:00:00.000Z';return {capabilities:{formalAdoption:false,canStart:false,modelLabel:null,budget:null,defaultEpisodeCount:10},briefs:{items:[{briefId:brief.briefId,revision:1,ideaPreview:brief.idea,actorId:'human',createdAt:at}],nextCursor:null},runs:{items:[],nextCursor:null},savedBrief:null,composeVersion:0,detail:{runId:'run',runDigest:'d'.repeat(64),briefId:brief.briefId,briefRevision:1,createdAt:at,sourceChanged:false,foundationCandidateDigest:'a'.repeat(64),foundationReviewStatus:null,episodesCandidateDigest:null,episodesReviewStatus:null,stage:'foundation',state:'awaiting_review',task:null,brief,budget:{currency:'CNY',tokens:200,costMicros:0},foundation:{candidate:{digest:'a'.repeat(64),output:f.foundation},review:null},episodes:{candidate:null,review:null}},status:null,redoOptions:null,pendingRedoStages:[],canEdit:true,canReview:true,busy:null,error:null,message:null,onSave:vi.fn(),onStart:vi.fn(),onNew:vi.fn(),onOpenBrief:vi.fn(),onOpenRun:vi.fn(),onMoreBriefs:vi.fn(),onMoreRuns:vi.fn(),onRefresh:vi.fn(),onConfirm:vi.fn(),onReject:vi.fn(),onRedo:vi.fn()};
}
it('renders every foundation and episode field as ordinary form controls, with stable identity and reference choices',()=>{
  const f=episodeFixture();const foundation=renderToStaticMarkup(<FoundationEditor output={f.foundation} onChange={()=>{}} disabled={false}/>);
  for(const label of ['故事标题','时代','世界与环境','人物欲望','人物阻力','人物弧光','关系起点','关系终点','核心命题','中心冲突','代价与赌注','主线推进','主线结局','驱动主线的人物','主线涉及的规则','待解问题','添加规则','添加人物','添加关系','删除人物'])expect(foundation).toContain(label);
  expect(foundation).toMatch(/<span id="([^"]+)">故事标题<\/span><textarea[^>]*aria-labelledby="\1"/);
  expect(foundation).toContain('人物 1 · 林舟（主角）');expect(foundation).toContain('人物 2 · 林舟（对抗者）');
  const episodes=renderToStaticMarkup(<EpisodesEditor output={f.output} foundation={f.foundation} onChange={()=>{}} disabled={false}/>);for(const label of ['集号','分集标题','分集梗概','本集目标','本集冲突','转折','收尾与悬念','本集人物','本集规则','添加一集','分集分页'])expect(episodes).toContain(label);
});
it('distinguishes full and episodes-only redo budgets and keeps inherited approval read-only',()=>{
  const p=props();const detail=p.detail!;const reviewDigest='b'.repeat(64);detail.origin={stage:'episodes',sourceRunId:'direct-parent',sourceRunDigest:'c'.repeat(64),actorId:'fork-author',foundation:{runId:'generation-owner',runDigest:'e'.repeat(64),candidateDigest:detail.foundation.candidate!.digest,reviewDigest},affectedStages:['episodes']};
  detail.foundation.review={status:'reviewed',digest:reviewDigest,actorId:'original-reviewer',at:'2026-11-16T12:00:00.000Z',output:detail.foundation.candidate!.output};detail.foundationReviewStatus='reviewed';
  p.redoOptions={runId:detail.runId,runDigest:detail.runDigest,briefDigest:detail.brief.digest,modelLabel:'当前模型',foundation:{canRedo:true,reason:null,budget:{currency:'CNY',tokens:200,costMicros:20}},episodes:{canRedo:true,reason:null,budget:{currency:'CNY',tokens:100,costMicros:10}}};
  const html=renderToStaticMarkup(<DevelopmentWorkbench {...p}/>);for(const text of ['重做设定与分集','仅重做分集','200 tokens','100 tokens','generation-owner','direct-parent','original-reviewer','本次只重做分集','旧分支仍保留为历史记录'])expect(html).toContain(text);
  expect(html).not.toContain('确认设定并生成分集');expect(html).not.toContain('拒绝此阶段候选');expect(p.onRedo).not.toHaveBeenCalled();
  detail.episodes.candidate={digest:'f'.repeat(64),output:episodeFixture().output};const withEpisodes=renderToStaticMarkup(<DevelopmentWorkbench {...p}/>);expect(withEpisodes).toMatch(/<button[^>]*class="button primary"[^>]*>确认分集审阅/);expect(withEpisodes).not.toContain('确认设定并生成分集');
});
it('shows an unknown gate and lets an unacknowledged request retry only its original stage',()=>{
  const p=props();p.redoOptions={runId:'run',runDigest:p.detail!.runDigest,briefDigest:p.detail!.brief.digest,modelLabel:'当前模型',foundation:{canRedo:true,reason:null,budget:{currency:'CNY',tokens:200,costMicros:20}},episodes:{canRedo:false,reason:'UNKNOWN_RESULT',budget:{currency:'CNY',tokens:100,costMicros:10}}};
  let html=renderToStaticMarkup(<DevelopmentWorkbench {...p}/>);expect(html).toContain('需先由管理员对账');expect(html).toMatch(/<button[^>]*disabled=""[^>]*>仅重做分集/);
  p.pendingRedoStages=['episodes'];html=renderToStaticMarkup(<DevelopmentWorkbench {...p}/>);expect(html).toContain('重试确认分集重做');expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重做设定与分集/);
  p.canEdit=false;html=renderToStaticMarkup(<DevelopmentWorkbench {...p}/>);expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重试确认分集重做/);
  p.canEdit=true;p.pendingRedoStages=[];p.redoOptions.runDigest='0'.repeat(64);html=renderToStaticMarkup(<DevelopmentWorkbench {...p}/>);expect(html).toContain('正在读取重做条件');expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重做设定与分集/);
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
