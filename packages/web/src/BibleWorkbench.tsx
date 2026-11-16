import { useMemo, useState, type ReactNode } from 'react';
import type { SourcePage } from '@camery/ingest/contracts';
import type { BibleCapabilities, BibleConfirm, BibleEvidence, BibleRunList, BibleRunView, BibleStatus, BibleCandidateView } from '@camery/bible/http';
import { bibleDecision, initialBibleDraft, inspectBibleDraft, mergeBibleGroups, removeRejectedReferences, renameBibleGroup, splitBibleGroup, toggleBibleEntity, toggleBibleSelection } from './bible-review-state.js';
import './bible-styles.css';

export interface BibleWorkbenchProps {
  readonly capabilities:BibleCapabilities|null; readonly runs:BibleRunList|null; readonly selectedRunId:string|null;
  readonly status:BibleStatus|null; readonly detail:BibleRunView|null;
  readonly source:SourcePage|null; readonly startSource:SourcePage|null; readonly evidence:BibleEvidence|null;
  readonly canStart:boolean; readonly canReview:boolean; readonly busy:string|null; readonly error:string|null; readonly message:string|null;
  readonly onStart:()=>void; readonly onOpen:(runId:string)=>void; readonly onMore:()=>void; readonly onRefresh:()=>void;
  readonly onEvidence:(evidence:BibleEvidence)=>void; readonly onSourcePage:(target:number,direction?:'before')=>void;
  readonly onConfirm:(decision:BibleConfirm)=>void; readonly onReject:(reason:string)=>void;
}
const kindLabels:Record<string,string>={character:'人物',place:'地点',prop:'物件',organization:'组织',concept:'概念',fact:'事实',world_rule:'世界规则',timeline:'时间线',foreshadowing:'伏笔',reveal:'揭示'};
const stateLabels:Record<BibleStatus['state'],string>={queued:'排队中',running:'正在抽取',waiting:'等待继续',reconciling:'等待结果对账',blocked:'执行已暂停',failed:'执行失败',cancelled:'执行已取消',ready:'等待审阅',confirmed:'已确认',rejected:'已拒绝',stale:'来源已变化'};
function budgetText(value:NonNullable<BibleCapabilities['budget']>):string {
  return `${value.tokens.toLocaleString('zh-CN')} tokens · ${(value.costMicros/1_000_000).toLocaleString('zh-CN',{maximumFractionDigits:6})} ${value.currency}`;
}
function Paged<T>({items,children,label}:{items:readonly T[];children:(item:T,index:number)=>ReactNode;label:string}) {
  const [requested,setPage]=useState(0); const pages=Math.max(1,Math.ceil(items.length/20)); const page=Math.min(requested,pages-1);
  return <><div className="bible-rows">{items.slice(page*20,page*20+20).map((item,index)=>children(item,page*20+index))}</div>
    {pages>1 && <nav className="bible-pager" aria-label={`${label}分页`}><button type="button" disabled={page===0} onClick={()=>setPage(page-1)}>上一页</button>
      <span>{page+1} / {pages}</span><button type="button" disabled={page===pages-1} onClick={()=>setPage(page+1)}>下一页</button></nav>}</>;
}
function Citations({evidence,onEvidence}:{evidence:readonly BibleEvidence[];onEvidence:(evidence:BibleEvidence)=>void}) {
  return <div className="bible-citations">{evidence.map((item,index)=><button type="button" key={`${item.start}:${item.end}:${index}`} onClick={()=>onEvidence(item)}
    title={`查看提取时原文 ${item.start}–${item.end}`}><span aria-hidden="true">↗</span>「{item.quote}」<small>原文 {item.start}–{item.end}</small></button>)}</div>;
}
function FrozenSource({source,evidence,busy,onPage}: {source:SourcePage|null;evidence:BibleEvidence|null;busy:boolean;onPage:(target:number,direction?:'before')=>void}) {
  if (!source) return <aside className="bible-source"><p className="bible-eyebrow">SOURCE NOTES / 原文核对</p><h3>每个判断，都有来处。</h3><p>点击候选下方的引文，查看提取时保存的原文。追加或修改后的来源不会覆盖这份快照。</p></aside>;
  const {text,start,end}=source.excerpt; const local=evidence?evidence.start-start:-1;
  const matches=!!evidence && local>=0 && evidence.end<=end && text.slice(local,evidence.end-start)===evidence.quote;
  return <aside className="bible-source" aria-label="提取时原文"><p className="bible-eyebrow">SOURCE NOTES / 原文核对</p><h3>{source.title}</h3>
    <p className="bible-source-meta">版本 {source.revision} · 字符 {start.toLocaleString('zh-CN')}–{end.toLocaleString('zh-CN')}</p>
    <pre>{matches?<>{text.slice(0,local)}<mark>{evidence.quote}</mark>{text.slice(evidence.end-start)}</>:text}</pre>
    {evidence && !matches && <p className="bible-note">当前片段未包含完整引文，请重新点击对应引文定位。</p>}
    <nav className="bible-pager" aria-label="冻结原文分页"><button type="button" disabled={busy || start===0} onClick={()=>onPage(start,'before')}>上一段</button>
      <button type="button" disabled={busy || end>=source.totalCharacters} onClick={()=>onPage(end)}>下一段</button></nav>
  </aside>;
}
function CandidateReview({candidate,detail,stale,canReview,busy,onConfirm,onReject,onEvidence}: {
  candidate:BibleCandidateView;detail:BibleRunView;stale:boolean;canReview:boolean;busy:boolean;
  onConfirm:(decision:BibleConfirm)=>void;onReject:(reason:string)=>void;onEvidence:(evidence:BibleEvidence)=>void;
}) {
  const [draft,setDraft]=useState(()=>initialBibleDraft(candidate,detail.review?.decision));
  const [tab,setTab]=useState<'entities'|'relations'|'claims'|'suggestions'>('entities');
  const [mergeIds,setMergeIds]=useState<string[]>([]); const [reason,setReason]=useState('');
  const readonly=!!detail.review || !canReview || busy; const issues=useMemo(()=>inspectBibleDraft(candidate,draft),[candidate,draft]);
  const entities=useMemo(()=>new Map(candidate.entities.map(entity=>[entity.id,entity])),[candidate]);
  const selectedGroups=draft.groups.filter(group=>mergeIds.includes(group.id));
  const sameKind=new Set(selectedGroups.flatMap(group=>group.memberIds).map(id=>entities.get(id)?.kind)).size===1;
  const selectMerge=(id:string,selected:boolean)=>setMergeIds(current=>selected?[...current,id]:current.filter(member=>member!==id));
  const rejectEntity=(id:string,keep:boolean)=>{setDraft(current=>toggleBibleEntity(candidate,current,id,keep));setMergeIds([]);};
  const selectedRelationSet=new Set(draft.selectedRelationIds); const selectedClaimSet=new Set(draft.selectedClaimIds);
  const rejectedEntities=candidate.entities.filter(entity=>draft.rejectedEntityIds.includes(entity.id));
  return <section className="bible-review" aria-label="候选审阅">
    <div className="bible-review-intro"><div><p className="bible-eyebrow">EDITORIAL REVIEW / 候选审阅</p><h2>把故事里的线索，逐一落定。</h2></div>
      <span className="bible-candidate-label">{detail.review?'审阅记录':'候选 · 尚未确认'}</span></div>
    <p className="bible-note">同名条目起初各自保留。合并只改变身份分组，每条描述及其原文依据都会保存；有冲突的描述也会一起保留。</p>
    {!canReview && <p className="bible-notice">当前角色可查看候选与原文；确认或拒绝需要项目审阅权限。</p>}
    {stale && <p className="bible-notice">来源已变化。这次提取仍对应旧版原文，无法确认；可以保留查阅或拒绝本次候选。</p>}
    {detail.review && <p className="bible-audit">{detail.review.status==='confirmed'?'已确认':'已拒绝'} · 审阅人 {detail.review.actorId} · {detail.review.at}
      {detail.review.reason && <span>拒绝原因：{detail.review.reason}</span>}
      {detail.review.status==='rejected' && <span>以下保留本次原始候选，整次结果已拒绝。</span>}</p>}
    <div className="bible-tabs" role="tablist" aria-label="候选类型">{([['entities','实体',candidate.entities.length],['relations','关系',candidate.relations.length],['claims','事实与线索',candidate.claims.length],['suggestions','合并建议',candidate.mergeSuggestions.length]] as const).map(([value,label,count])=>
      <button key={value} type="button" role="tab" aria-selected={tab===value} id={`bible-tab-${value}`} aria-controls="bible-tab-content" onClick={()=>setTab(value)}>{label}<span>{count}</span></button>)}</div>
    <div id="bible-tab-content" role="tabpanel" aria-labelledby={`bible-tab-${tab}`}>
    {tab==='entities' && <><div className="bible-merge-bar"><p>保留 {draft.groups.length} 个身份 · 拒绝 {draft.rejectedEntityIds.length} 条</p>
      <button type="button" disabled={readonly || selectedGroups.length<2 || !sameKind} onClick={()=>{setDraft(current=>mergeBibleGroups(candidate,current,mergeIds));setMergeIds([]);}}>合并选中的 {selectedGroups.length} 组</button>
      <small>勾选同一类型的分组后合并。已合并的组可以再次拆开。</small></div>
      <Paged key="groups" items={draft.groups} label="实体分组">{group=><article className="bible-entity-group" key={group.id}>
        <div className="bible-group-heading"><label className="bible-check"><input type="checkbox" aria-label={`选择合并 ${group.name}`} checked={mergeIds.includes(group.id)} disabled={readonly} onChange={event=>selectMerge(group.id,event.target.checked)}/>选择合并</label>
          <span>{kindLabels[entities.get(group.memberIds[0]!)!.kind]} · {group.memberIds.length} 条来源</span>
          {group.memberIds.length>1 && <button type="button" disabled={readonly} onClick={()=>{setDraft(current=>splitBibleGroup(candidate,current,group.id));setMergeIds([]);}}>拆为独立身份</button>}</div>
        <label className="bible-name-label">确认名称<input value={group.name} maxLength={120} disabled={readonly} onChange={event=>setDraft(current=>renameBibleGroup(current,group.id,event.target.value))}/></label>
        <Paged items={group.memberIds} label={`${group.name}来源`}>{id=>{const entity=entities.get(id)!;return <div key={id} className="bible-original-entity"><div className="bible-row-heading"><h4>{entity.name}</h4>
          <button type="button" disabled={readonly} onClick={()=>rejectEntity(id,false)}>拒绝此条</button></div>
          {entity.aliases.length>0 && <p className="bible-aliases">别名：{entity.aliases.join('、')}</p>}<p>{entity.description}</p><Citations evidence={entity.evidence} onEvidence={onEvidence}/></div>;}}</Paged>
      </article>}</Paged>
      {rejectedEntities.length>0 && <div className="bible-rejected"><h3>已拒绝的条目</h3><Paged items={rejectedEntities} label="已拒绝实体">{entity=><article key={entity.id}><div className="bible-row-heading"><h4>{entity.name}</h4>
        <button type="button" disabled={readonly} onClick={()=>rejectEntity(entity.id,true)}>恢复为独立身份</button></div><p>{entity.description}</p><Citations evidence={entity.evidence} onEvidence={onEvidence}/></article>}</Paged></div>}
    </>}
    {tab==='relations' && <Paged key="relations" items={candidate.relations} label="关系">{relation=><article key={relation.id} className="bible-association"><label className="bible-check"><input type="checkbox" checked={selectedRelationSet.has(relation.id)} disabled={readonly}
      onChange={event=>setDraft(current=>toggleBibleSelection(current,'relation',relation.id,event.target.checked))}/><strong>{entities.get(relation.from)!.name} → {entities.get(relation.to)!.name}</strong></label>
      <p>{relation.label}</p>{issues.invalidRelationIds.includes(relation.id) && <p className="bible-field-error">这条关系引用了已拒绝实体，请明确取消选择或恢复实体。</p>}<Citations evidence={relation.evidence} onEvidence={onEvidence}/></article>}</Paged>}
    {tab==='claims' && <Paged key="claims" items={candidate.claims} label="事实与线索">{claim=><article key={claim.id} className="bible-association"><label className="bible-check"><input type="checkbox" checked={selectedClaimSet.has(claim.id)} disabled={readonly}
      onChange={event=>setDraft(current=>toggleBibleSelection(current,'claim',claim.id,event.target.checked))}/><span>{kindLabels[claim.kind]}</span></label><p>{claim.text}</p>
      {claim.entityIds.length>0 && <p className="bible-aliases">涉及：{claim.entityIds.map(id=>entities.get(id)!.name).join('、')}</p>}
      {issues.invalidClaimIds.includes(claim.id) && <p className="bible-field-error">这条线索引用了已拒绝实体，请明确取消选择或恢复实体。</p>}<Citations evidence={claim.evidence} onEvidence={onEvidence}/></article>}</Paged>}
    {tab==='suggestions' && <><p className="bible-note">以下条目出现了同名或共同别名。名字相同不代表同一身份；请核对引文后，在“实体”中选择分组合并。</p>
      {candidate.mergeSuggestions.length===0 && <p className="bible-empty-note">没有同名或别名相遇的条目。仍可在实体页自行合并。</p>}
      <Paged key="suggestions" items={candidate.mergeSuggestions} label="合并建议">{(suggestion,index)=><article key={index} className="bible-association"><h3>同名 / 别名相遇</h3>
        <Paged items={suggestion.entityIds} label="建议条目">{id=>{const entity=entities.get(id)!;return <div key={id} className="bible-suggestion-member"><h4>{entity.name}<small>{kindLabels[entity.kind]}</small></h4><p>{entity.description}</p><Citations evidence={entity.evidence} onEvidence={onEvidence}/></div>;}}</Paged>
      </article>}</Paged></>}
    </div>
    {!detail.review && <div className="bible-decision"><div className="bible-decision-counts"><span><strong>{draft.groups.length}</strong> 个身份</span><span><strong>{draft.selectedRelationIds.length}</strong> 条关系</span><span><strong>{draft.selectedClaimIds.length}</strong> 条事实与线索</span></div>
      {issues.invalidRelationIds.length+issues.invalidClaimIds.length>0 && <div className="bible-notice"><p>还有 {issues.invalidRelationIds.length} 条关系、{issues.invalidClaimIds.length} 条线索引用了已拒绝实体。它们仍被选中。</p>
        <button type="button" disabled={readonly} onClick={()=>setDraft(current=>removeRejectedReferences(candidate,current))}>明确取消这 {issues.invalidRelationIds.length+issues.invalidClaimIds.length} 条关联</button></div>}
      {!issues.valid && issues.invalidRelationIds.length+issues.invalidClaimIds.length===0 && <p className="bible-field-error">请填写有效名称，并为每条实体决定保留或拒绝。</p>}
      <button className="button primary bible-confirm" type="button" disabled={readonly || stale || !detail.current || !issues.valid} onClick={()=>{const decision=bibleDecision(candidate,draft);if(decision)onConfirm(decision);}}>确认以上选择 <span aria-hidden="true">↗</span></button>
      <p className="bible-note">确认后保存为本次 StoryBible 快照；原文与矛盾描述会保留，正式剧本的采用另行处理。</p>
      <details className="bible-reject"><summary>拒绝整次候选</summary><label>拒绝原因<textarea maxLength={1000} rows={3} value={reason} disabled={readonly} onChange={event=>setReason(event.target.value)}/></label>
        <button type="button" disabled={readonly || reason.trim().length===0 || !reason.isWellFormed() || reason.includes('\0')} onClick={()=>onReject(reason.trim())}>提交拒绝原因</button></details>
    </div>}
  </section>;
}

export function BibleWorkbench(props:BibleWorkbenchProps) {
  const {capabilities,runs,selectedRunId,status,detail,source,startSource,evidence,busy,canStart,canReview}=props;
  const currentStatus=status?.runId===selectedRunId?status:detail?.runId===selectedRunId?detail:null;
  const activeDetail=detail?.runId===selectedRunId?detail:null;
  const stale=!!currentStatus?.sourceChanged || activeDetail?.current===false;
  const pinned=currentStatus?.source;
  const visibleSource=pinned && source?.documentId===pinned.documentId && source.kind===pinned.kind && source.format===pinned.format && source.revision===pinned.revision &&
    source.sourceDigest===pinned.sourceDigest && source.originalDigest===pinned.originalDigest && source.totalCharacters===pinned.totalCharacters?source:null;
  return <section className="bible-workbench" aria-label="StoryBible 工作台"><header className="bible-header"><div><p className="bible-eyebrow">STORY ARCHIVE / 故事档案</p><h1>StoryBible<span>人物、关系，与尚未落定的线索。</span></h1></div>
    <button type="button" className="button subtle" onClick={props.onRefresh} disabled={!!busy}>刷新档案 ↻</button></header>
    {props.error && <p className="bible-notice" role="alert">{props.error}</p>}{props.message && <p className="bible-message" role="status">{props.message}</p>}
    {busy && <p className="bible-working" role="status">{busy}</p>}
    <div className="bible-start"><div><h2>从来源里，建立故事档案。</h2><p>{startSource?`${startSource.title} · 版本 ${startSource.revision} · ${startSource.totalCharacters.toLocaleString('zh-CN')} 字符`:'先在来源页选择一份小说或剧本，再开始提取。'}</p>
      {capabilities?.canStart?<p className="bible-note">{capabilities.modelLabel} {capabilities.budget && <>· 本次预算上限 {budgetText(capabilities.budget)}</>}</p>:<p className="bible-note">文本抽取服务尚未配置，可以继续查看和审阅已有结果。</p>}
      {!canStart && <p className="bible-note">开始提取需要项目任务权限。</p>}</div>
      <button className="button primary" type="button" disabled={!canStart || !capabilities?.canStart || !startSource || !!busy} onClick={props.onStart}>开始新提取 <span aria-hidden="true">↗</span></button></div>
    <div className="bible-layout"><aside className="bible-run-index"><div className="bible-section-title"><h2>提取记录</h2><span>{runs?.items.length??0}</span></div>
      {!runs?.items.length && <p className="bible-empty-note">暂无提取记录。开始后可随时回到这里查看进度与审阅结果。</p>}
      <div className="bible-run-list">{runs?.items.map(run=><button type="button" key={run.runId} className={selectedRunId===run.runId?'selected':''} onClick={()=>props.onOpen(run.runId)} aria-pressed={selectedRunId===run.runId}>
        <strong>{run.source.documentId}</strong><span>版本 {run.source.revision} · {run.completedChunks}/{run.totalChunks} 块</span>
        <small>{run.reviewStatus==='confirmed'?'已确认':run.reviewStatus==='rejected'?'已拒绝':run.sourceChanged?'来源已变化':run.candidateDigest?'等待审阅':'提取中'} · {run.createdAt.slice(0,10)}</small></button>)}</div>
      {runs?.nextCursor && <button type="button" className="bible-load-more" disabled={!!busy} onClick={props.onMore}>加载更早记录 ↓</button>}</aside>
      <section className="bible-main" aria-label="提取与审阅内容">{currentStatus && <div className="bible-run-status"><strong>{stateLabels[currentStatus.state]}</strong><span>已完成 {currentStatus.completedChunks} / {currentStatus.totalChunks} 块</span>
        <progress aria-label="提取进度" max={currentStatus.totalChunks} value={currentStatus.completedChunks}/>
        {currentStatus.state==='reconciling' && <p>正在核对上一次调用的结果，本次任务不会自动重新调用模型。</p>}
        {currentStatus.state==='blocked' && <p>本次执行已暂停。保留已完成结果，等待管理员检查服务或预算后处理。</p>}
        {stale && <p>此记录对应提取时原文，当前来源已变化。</p>}</div>}
        {activeDetail?.candidate?<CandidateReview key={`${activeDetail.runId}:${activeDetail.candidate.digest}:${activeDetail.review?.digest??''}`} candidate={activeDetail.candidate} detail={activeDetail}
          stale={stale} canReview={canReview} busy={!!busy} onConfirm={props.onConfirm} onReject={props.onReject} onEvidence={props.onEvidence}/>:
          <div className="bible-empty"><span aria-hidden="true">§</span><p className="bible-eyebrow">A STORY, STILL UNFOLDING</p><h2>{selectedRunId?'等待候选成稿':'让细节，成为可以核对的档案。'}</h2><p>{selectedRunId?'完成全部分块后，人物、关系与线索将在这里等待审阅。':'选择一条提取记录，查看其进度、候选与原文。'}</p></div>}
      </section><FrozenSource source={visibleSource} evidence={evidence} busy={!!busy} onPage={props.onSourcePage}/></div>
  </section>;
}
