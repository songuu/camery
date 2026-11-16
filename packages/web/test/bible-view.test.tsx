import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BibleCandidateView, BibleRunView } from '@camery/bible/http';
import { BibleWorkbench, type BibleWorkbenchProps } from '../src/BibleWorkbench.js';

const candidate=():BibleCandidateView=>({digest:'b'.repeat(64),entities:[{id:'c:e:a',kind:'character',name:'<script>林舟</script>',aliases:['阿舟'],description:'<img src=x onerror="bad()">矛盾描述仍保留',chunkId:'c',evidence:[{start:0,end:2,quote:'林舟'}]}],relations:[],claims:[],mergeSuggestions:[]});
const detail=():BibleRunView=>({runId:'run',createdAt:'2026-11-16T00:00:00.000Z',source:{documentId:'novel',kind:'novel',format:'novel',revision:1,sourceDigest:'a'.repeat(64),originalDigest:'a'.repeat(64),totalCharacters:4},completedChunks:1,totalChunks:1,candidateDigest:'b'.repeat(64),reviewStatus:null,sourceChanged:false,state:'ready',task:null,current:true,candidate:candidate(),review:null,budget:{currency:'USD',tokens:1000,costMicros:10000}});
const props=():BibleWorkbenchProps=>({capabilities:null,runs:null,selectedRunId:null,status:null,detail:null,source:null,startSource:null,evidence:null,canStart:false,canReview:false,busy:null,error:null,message:null,
  onStart:vi.fn(),onOpen:vi.fn(),onMore:vi.fn(),onRefresh:vi.fn(),onEvidence:vi.fn(),onSourcePage:vi.fn(),onConfirm:vi.fn(),onReject:vi.fn()});
const source=():NonNullable<BibleWorkbenchProps['source']>=>({documentId:'novel',title:'提取时原文',kind:'novel',format:'novel',revision:1,sourceDigest:'a'.repeat(64),originalDigest:'a'.repeat(64),totalCharacters:4,unitCount:1,warnings:[],excerpt:{start:0,end:4,text:'林舟出发'},units:[],checkpoint:null});

describe('Bible review rendering boundaries',()=>{
  it('explains the unconfigured text host and offers no enabled extraction action',()=>{
    const html=renderToStaticMarkup(<BibleWorkbench {...props()}/>);
    expect(html).toContain('文本抽取服务尚未配置'); expect(html).toContain('先在来源页选择');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>开始新提取/); expect(html).not.toContain('确认以上选择');
  });
  it('renders untrusted names, descriptions, and citations only as text and enables a permitted fresh review',()=>{
    const html=renderToStaticMarkup(<BibleWorkbench {...props()} selectedRunId="run" detail={detail()} canReview source={source()} evidence={{start:0,end:2,quote:'林舟'}}/>);
    expect(html).not.toContain('<script>林舟'); expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img'); expect(html).toContain('<mark>林舟</mark>出发');
    expect(html).toMatch(/<button class="button primary bible-confirm" type="button">确认以上选择/);
    expect(html).toContain('合并只改变身份分组'); expect(html).toContain('矛盾描述');
  });
  it('shows a safe read-only view for viewers, while still exposing citation navigation',()=>{
    const html=renderToStaticMarkup(<BibleWorkbench {...props()} selectedRunId="run" detail={detail()}/>);
    expect(html).toContain('当前角色可查看候选与原文'); expect(html).toContain('查看提取时原文 0–2');
    expect(html).toMatch(/class="button primary bible-confirm"[^>]*disabled/); expect(html).toMatch(/disabled=""[^>]*>提交拒绝原因/);
  });
  it('blocks confirmation on a changed source and keeps the whole-run rejection form available',()=>{
    const changed={...detail(),sourceChanged:true,state:'stale' as const,current:false};
    const html=renderToStaticMarkup(<BibleWorkbench {...props()} selectedRunId="run" detail={changed} canReview/>);
    expect(html).toContain('来源已变化'); expect(html).toMatch(/class="button primary bible-confirm"[^>]*disabled/);
    expect(html).toContain('拒绝整次候选'); expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
  });
  it('restores an audited decision as read-only, with no second confirm or reject action',()=>{
    const value=detail(); value.review={status:'confirmed',digest:'c'.repeat(64),actorId:'reviewer',at:'2026-11-16T00:00:00.000Z',reason:null,
      decision:{candidateDigest:value.candidateDigest!,groups:[{id:'confirmed-group',name:'审阅后的名称',memberIds:['c:e:a']}],rejectedEntityIds:[],selectedRelationIds:[],selectedClaimIds:[]}};
    value.state='confirmed';value.reviewStatus='confirmed';
    const html=renderToStaticMarkup(<BibleWorkbench {...props()} selectedRunId="run" detail={value} canReview/>);
    expect(html).toContain('审阅人 reviewer');expect(html).toContain('审阅后的名称'); expect(html).not.toContain('确认以上选择');expect(html).not.toContain('拒绝整次候选');
  });
  it('shows persisted extraction progress and reconciliation without exposing task internals',()=>{
    const value={...detail(),state:'reconciling' as const,candidate:null,completedChunks:0,candidateDigest:null};
    const html=renderToStaticMarkup(<BibleWorkbench {...props()} selectedRunId="run" detail={value} busy="正在读取状态" message="已保存" error="暂不可用" runs={{items:[value],nextCursor:'next'}}/>);
    expect(html).toContain('等待结果对账');expect(html).toContain('不会自动重新调用模型');expect(html).toContain('等待候选成稿');
    expect(html).toContain('已完成 0 / 1 块');expect(html).toContain('加载更早记录');expect(html).toContain('role="alert"');
  });
  it('does not render another run detail or source after the selected run changes',()=>{
    const html=renderToStaticMarkup(<BibleWorkbench {...props()} selectedRunId="other-run" detail={detail()} source={source()} evidence={{start:0,end:2,quote:'林舟'}}/>);
    expect(html).not.toContain('矛盾描述');expect(html).not.toContain('<mark>');expect(html).not.toContain('林舟出发');
    expect(html).toContain('每个判断，都有来处');
  });
  it('requires exact pinned source identity before displaying a source page',()=>{
    const html=renderToStaticMarkup(<BibleWorkbench {...props()} selectedRunId="run" detail={detail()} source={{...source(),revision:2}}/>);
    expect(html).not.toContain('林舟出发');
    const mismatch=renderToStaticMarkup(<BibleWorkbench {...props()} selectedRunId="run" detail={detail()} source={source()} evidence={{start:0,end:2,quote:'不符'}}/>);
    expect(mismatch).not.toContain('<mark>');expect(mismatch).toContain('当前片段未包含完整引文');
  });
  it('shows a configured model, reservation ceiling and selected source without exposing connection data',()=>{
    const html=renderToStaticMarkup(<BibleWorkbench {...props()} startSource={source()} canStart capabilities={{canStart:true,modelLabel:'文本模型',budget:{currency:'USD',tokens:12000,costMicros:2000}}}/>);
    expect(html).toContain('文本模型');expect(html).toContain('本次预算上限 12,000 tokens');expect(html).toContain('0.002 USD');
    expect(html).toMatch(/<button class="button primary" type="button">开始新提取/);expect(html).not.toContain('credential');
  });
});
