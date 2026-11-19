import {lazy,Suspense,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {Identity} from './api.js';
import {ApiClient,ApiError} from './api.js';
import type {OutlineRunView} from '@camery/script/outline/http';
import type {OutlineCandidate,OutlineCandidateHeader,OutlineReceipt,OutlineReceiptPage,OutlineUpgradeCandidate} from '@camery/ir/outline-adoption';
import type {WorkbenchState,WorkbenchCandidateSummary,WorkbenchActionReceipt} from '@camery/ir/workbench';
import {OutlineActionJournal,OutlineActionJournalError,AdoptionLifetime,outlineAdoptionSource,outlineDecisionFeedback} from './OutlineAdoptionState.js';
import type {OutlineAction} from './OutlineAdoptionState.js';
import {decisionReceiptFeedback} from './DevelopmentAdoptionState.js';
import {FormalProjectBoundary} from './FormalProjectBoundary.js';
import './outline-adoption.css';
const FormalOutlinePane=lazy(async()=>({default:(await import('./FormalOutlinePane.js')).FormalOutlinePane}));
interface Props{client:ApiClient;generation:number;projectId:string;identity:Identity;run:OutlineRunView|null;permissions:readonly string[];onFailure:(problem:unknown)=>void;onOpenRun?:(runId:string)=>void}
const statusNames:Record<OutlineCandidate['status'],string>={prepared:'准备待完成',candidate:'待明确采用',adopted:'已正式采用',rejected:'已拒绝',conflicted:'存在冲突',unchanged:'内容相同，无需变更'};
const texts:Record<string,string>={SCHEMA_UPGRADE_REQUIRED:'请先准备并采用项目结构升级，再准备正式大纲。',PROJECT_BINDING_MISSING:'项目尚未关联正式版本，请由管理员完成关联。',PRINCIPAL_BINDING_MISSING:'当前账号尚未关联正式审阅身份，请由管理员完成关联。',FORBIDDEN:'当前账号没有此操作的权限。',NOT_FOUND:'记录不存在或服务尚未开放，请刷新核对。',SNAPSHOT_STALE:'正式内容已有新修订，请刷新后重新核对。',WRITE_VERSION_CONFLICT:'项目的候选或审阅记录已有更新，请刷新后重新核对。',CONFLICT:'来源或项目已有变化，请刷新后重新核对。',INVALID_INPUT:'本次操作未被接受，请核对内容后重试。',INVALID_REQUEST:'本次操作内容无效，请刷新核对。',INPUT_LIMIT:'本次内容超出支持范围，请联系管理员核对。',PENDING_ACTION:'上次操作尚未确认，请先使用原请求重试。',JOURNAL_CORRUPT:'本标签页的待确认操作记录无法核对。请保留服务器记录，重新打开标签页后核对候选。',JOURNAL_UNAVAILABLE:'无法保留本标签页的操作身份，本次没有发出新操作。请允许标签页存储后重试。',BAD_RESPONSE:'服务回执无法核对。请使用原请求重试，不能据此判断已采用。'};
function errorText(problem:unknown){return texts[problem instanceof ApiError||problem instanceof OutlineActionJournalError?problem.code:'']??'本次操作结果尚未确认。请使用原请求重试；刷新只读取记录。';}
function uncertain(problem:unknown){return !(problem instanceof ApiError)||['NETWORK_FAILED','TIMEOUT','CANCELLED','BAD_RESPONSE','HTTP_FAILED','STORAGE_FAILED'].includes(problem.code);}
function journalFor(identity:Identity,projectId:string){try{return {journal:new OutlineActionJournal({tenantId:identity.tenantId,userId:identity.userId,projectId},window.sessionStorage),error:null};}catch{return {journal:null,error:new OutlineActionJournalError('JOURNAL_UNAVAILABLE')};}}
/** A changed identity, project or source record remounts the controller before any late response can update it. */
export function OutlineAdoptionPane(props:Props){
  const context=useRef({client:props.client,generation:props.generation,projectId:props.projectId,tenantId:props.identity.tenantId,userId:props.identity.userId,runId:props.run?.runId,key:0}),old=context.current;
  if(old.client!==props.client||old.generation!==props.generation||old.projectId!==props.projectId||old.tenantId!==props.identity.tenantId||old.userId!==props.identity.userId||old.runId!==props.run?.runId)context.current={client:props.client,generation:props.generation,projectId:props.projectId,tenantId:props.identity.tenantId,userId:props.identity.userId,runId:props.run?.runId,key:old.key+1};
  return <AdoptionSession key={context.current.key} {...props}/>;
}
function AdoptionSession({client,generation,projectId,identity,run,permissions,onFailure,onOpenRun}:Props){
  const [journalState]=useState(()=>journalFor(identity,projectId)),journal=journalState.journal;
  const [pending,setPending]=useState<Readonly<OutlineAction>|null>(null),[state,setState]=useState<WorkbenchState|null>(null),[items,setItems]=useState<OutlineCandidateHeader[]>([]),[detail,setDetail]=useState<OutlineCandidate|null>(null);
  const [manuals,setManuals]=useState<WorkbenchCandidateSummary[]>([]),[upgrade,setUpgrade]=useState<OutlineUpgradeCandidate|null>(null),[cursor,setCursor]=useState<string|null>(null),[manualCursor,setManualCursor]=useState<string|null>(null),[all,setAll]=useState(!run);
  const [busy,setBusy]=useState(false),[needsRefresh,setNeedsRefresh]=useState(true),[journalReady,setJournalReady]=useState(false),[error,setError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null),[reason,setReason]=useState(''),[upgradeReason,setUpgradeReason]=useState(''),[receipt,setReceipt]=useState<OutlineReceipt|null>(null),[upgradeReceipt,setUpgradeReceipt]=useState<WorkbenchActionReceipt|null>(null),[formal,setFormal]=useState(false);
  const lifetime=useRef(new AdoptionLifetime()),writing=useRef(false);
  const [formalRevision,setFormalRevision]=useState<number|undefined>(),[formalEpoch,setFormalEpoch]=useState(0),[historyRevision,setHistoryRevision]=useState('');
  useLayoutEffect(()=>()=>lifetime.current.close(),[]);
  function fail(problem:unknown){if(problem instanceof ApiError&&problem.code==='UNAUTHENTICATED')onFailure(problem);setError(errorText(problem));}
  async function load(signal:AbortSignal,selected?:string,nextAll=all,selectedUpgrade?:string){
    const [next,page,old]=await Promise.all([client.getWorkbenchState(projectId,signal),client.outlineCandidates(projectId,{...(!nextAll&&run?{runId:run.runId}:{}),limit:20},signal),client.listWorkbenchCandidates(projectId,undefined,undefined,signal)]);
    const [candidate,verified]=await Promise.all([selected?client.outlineCandidate(projectId,selected,signal):Promise.resolve(null),selectedUpgrade?client.workbenchUpgradeCandidate(projectId,selectedUpgrade,signal):Promise.resolve(null)]);
    return {next,page,old,candidate:!candidate||nextAll||candidate.runId===run?.runId?candidate:null,verified};
  }
  function apply(result:Awaited<ReturnType<typeof load>>){if(result.verified?.candidate.scope.id!==undefined&&result.verified.candidate.scope.id!==result.next.projectId)throw new ApiError('BAD_RESPONSE');setState(result.next);setItems(result.page.items);setCursor(result.page.nextCursor);setManuals(result.old.items.filter(item=>item.managed&&item.source.kind==='manual'));setManualCursor(result.old.nextCursor);setDetail(result.candidate);setUpgrade(result.verified);setNeedsRefresh(false);}
  async function refresh(nextAll=all){
    if(writing.current)return;const ticket=lifetime.current.next();setBusy(true);setError(null);
    // Browser persistence gates new writes, never the ability to read existing project records.
    try{if(journalState.error)throw journalState.error;setPending(journal!.read());setJournalReady(true);}catch(problem){setJournalReady(false);fail(problem);}
    try{const result=await load(ticket.signal,detail?.candidateId,nextAll,upgrade?.candidate.candidateId);if(!lifetime.current.current(ticket))return;apply(result);setAll(nextAll);}
    catch(problem){if(lifetime.current.current(ticket)){setNeedsRefresh(true);fail(problem);}}finally{if(lifetime.current.current(ticket))setBusy(false);}
  }
  useEffect(()=>{void refresh();},[]);
  const sourceSignature=run?[run.runDigest,run.brief.digest,run.source.digest,run.candidateDigest,run.review?.digest,run.state,run.reviewStatus,run.sourceChanged].join(':'):'none',previousSource=useRef(sourceSignature);
  useEffect(()=>{if(previousSource.current!==sourceSignature){previousSource.current=sourceSignature;void refresh();}},[sourceSignature]);
  async function open(candidateId:string,isUpgrade=false){
    if(busy||writing.current)return;const ticket=lifetime.current.next();setBusy(true);setError(null);
    try{if(isUpgrade){const value=await client.workbenchUpgradeCandidate(projectId,candidateId,ticket.signal);if(state&&value.candidate.scope.id!==state.projectId)throw new ApiError('BAD_RESPONSE');if(lifetime.current.current(ticket)){setUpgrade(value);setUpgradeReceipt(value.candidate.preparation);setUpgradeReason('');}}
      else{const value=await client.outlineCandidate(projectId,candidateId,ticket.signal);if(!all&&run&&value.runId!==run.runId)throw new ApiError('BAD_RESPONSE');if(lifetime.current.current(ticket)){setDetail(value);setReceipt(value.preparation);setReason('');}}}
    catch(problem){if(lifetime.current.current(ticket)){if(isUpgrade&&problem instanceof ApiError&&problem.code==='NOT_FOUND')setError('该记录不存在，或不是结构升级候选。请选择已准备的项目升级。');else fail(problem);}}finally{if(lifetime.current.current(ticket))setBusy(false);}
  }
  async function more(isUpgrade=false){
    const next=isUpgrade?manualCursor:cursor;if(busy||!next)return;const ticket=lifetime.current.next();setBusy(true);setError(null);
    try{if(isUpgrade){const page=await client.listWorkbenchCandidates(projectId,undefined,next,ticket.signal);if(lifetime.current.current(ticket)){setManuals(old=>[...old,...page.items.filter(item=>item.managed&&item.source.kind==='manual'&&!old.some(previous=>previous.candidateId===item.candidateId))]);setManualCursor(page.nextCursor);}}
      else{const page=await client.outlineCandidates(projectId,{cursor:next,...(!all&&run?{runId:run.runId}:{}),limit:20},ticket.signal);if(lifetime.current.current(ticket)){setItems(old=>[...old,...page.items.filter(item=>!old.some(previous=>previous.candidateId===item.candidateId))]);setCursor(page.nextCursor);}}}
    catch(problem){if(lifetime.current.current(ticket))fail(problem);}finally{if(lifetime.current.current(ticket))setBusy(false);}
  }
  async function execute(proposed:OutlineAction){
    if(writing.current||busy||!journal)return;let action:Readonly<OutlineAction>,recovering:boolean;
    try{recovering=journal.read()!==null;action=journal.begin(proposed);setPending(action);}catch(problem){fail(problem);return;}
    const ticket=lifetime.current.next();writing.current=true;setBusy(true);setError(null);setMessage(null);setReceipt(null);setUpgradeReceipt(null);let acknowledged=false,selected=detail?.candidateId,selectedUpgrade=upgrade?.candidate.candidateId;
    try{
      if(action.kind==='prepare'){
        const value=await client.outlinePrepareCandidate(projectId,action.runId,action.command,ticket.signal);
        if(!lifetime.current.current(ticket))return;selected=value.candidateId;setReceipt(value.preparation);setMessage(value.status==='unchanged'?'正式大纲内容已经一致，本次无需变更。':value.status==='candidate'?'正式候选已准备，尚未采用。请核对人审与提示后再明确采用。':'本次准备已收到回执，请核对候选状态与问题。');
      }else if(action.kind==='upgrade'){
        const value=await client.prepareWorkbenchUpgrade(projectId,action.command,ticket.signal);
        if(!lifetime.current.current(ticket))return;selectedUpgrade=value.candidateId;setUpgradeReceipt(value.preparation);setMessage('项目升级候选已准备，尚未改变正式结构。请明确采用升级，再继续大纲。');
      }else if(action.kind==='adopt'||action.kind==='reject'){
        const value=action.kind==='adopt'?await client.outlineAdoptCandidate(projectId,action.candidateId,action.requestId,action.command,ticket.signal):await client.outlineRejectCandidate(projectId,action.candidateId,action.requestId,action.command,ticket.signal);
        if(!lifetime.current.current(ticket))return;selected=action.candidateId;setReceipt(value);const feedback=outlineDecisionFeedback(action.kind,value);setMessage(feedback.message);setError(feedback.error);if(feedback.success)setReason('');
      }else{
        const value=action.kind==='upgrade-adopt'?await client.adoptWorkbenchCandidate(projectId,action.candidateId,action.requestId,action.command,ticket.signal):await client.rejectWorkbenchCandidate(projectId,action.candidateId,action.requestId,action.command,ticket.signal);
        if(!lifetime.current.current(ticket))return;selectedUpgrade=action.candidateId;setUpgradeReceipt(value);const feedback=decisionReceiptFeedback(action.kind==='upgrade-adopt'?'adopt':'reject',value);setMessage(feedback.message?'项目升级决定已确认，请核对当前结构版本。':null);setError(feedback.error);if(feedback.message)setUpgradeReason('');
      }
      acknowledged=true;journal.complete(action);setPending(null);setNeedsRefresh(true);const result=await load(ticket.signal,selected,all,selectedUpgrade);if(lifetime.current.current(ticket))apply(result);
    }catch(problem){if(lifetime.current.current(ticket)){
      // A refusal of this retry cannot prove whether the earlier, unacknowledged request committed.
      if(!acknowledged&&!recovering&&!uncertain(problem))try{journal.complete(action);setPending(null);}catch{/* Retain unresolved storage evidence and the original operation identity. */}
      if(acknowledged){setNeedsRefresh(true);setError('已收到本次操作回执，但最新状态尚未恢复。请刷新核对；回执保留如下。');}else fail(problem);
    }}finally{writing.current=false;if(lifetime.current.current(ticket))setBusy(false);}
  }
  const source=run?outlineAdoptionSource(run):null,blocked=busy||pending!==null||needsRefresh||!journalReady,canWrite=permissions.includes('candidate:write')&&state?.canWrite===true,canReview=permissions.includes('candidate:review')&&state?.canReview===true;
  const legacy=state&&!['0.7.0-draft','0.8.0-draft'].includes(state.schemaVersion);
  const selectedRevision=/^[1-9][0-9]*$/.test(historyRevision)?Number(historyRevision):NaN,validHistory=Number.isSafeInteger(selectedRevision)&&!!state&&selectedRevision<=state.snapshotRevision;
  function showFormal(revision?:number){setFormalRevision(revision);setFormalEpoch(value=>value+1);setFormal(true);}
  function prepare(){if(!blocked&&canWrite&&state&&source&&run&&!legacy)void execute({kind:'prepare',runId:run.runId,command:{applicationId:'outline-adopt-'+crypto.randomUUID(),...source,expectedSnapshotRevision:state.snapshotRevision,expectedWriteVersion:state.writeVersion}});}
  function prepareUpgrade(){if(!blocked&&canWrite&&state&&legacy)void execute({kind:'upgrade',command:{applicationId:'outline-upgrade-'+crypto.randomUUID(),expectedSnapshotRevision:state.snapshotRevision,expectedWriteVersion:state.writeVersion}});}
  function decide(action:'adopt'|'reject'){
    if(blocked||!canReview||!detail?.canReview||detail.status!=='candidate'||action==='adopt'&&(detail.sourceState!=='current'||detail.runId!==run?.runId)||action==='reject'&&!reason.trim())return;
    const base={expectedSnapshotRevision:detail.snapshotRevision,expectedWriteVersion:detail.writeVersion},requestId='outline-decision-'+crypto.randomUUID();
    void execute(action==='adopt'?{kind:'adopt',candidateId:detail.candidateId,requestId,command:base}:{kind:'reject',candidateId:detail.candidateId,requestId,command:{...base,reason:reason.trim()}});
  }
  function decideUpgrade(action:'adopt'|'reject'){
    const candidate=upgrade?.candidate;if(blocked||!canReview||!candidate||(action==='adopt'?!candidate.canAdopt:!candidate.canReject)||action==='reject'&&!upgradeReason.trim())return;
    const command={scope:candidate.scope,expectedSnapshotRevision:candidate.snapshotRevision,expectedWriteVersion:candidate.writeVersion},requestId='outline-schema-decision-'+crypto.randomUUID();
    void execute(action==='adopt'?{kind:'upgrade-adopt',candidateId:candidate.candidateId,requestId,command}:{kind:'upgrade-reject',candidateId:candidate.candidateId,requestId,command:{...command,reason:upgradeReason.trim()}});
  }
  return <section className="outline-adoption" aria-label="正式大纲采用">
    <header className="outline-section-heading"><div><p className="outline-kicker">03 / FORMAL OUTLINE</p><h2>写入正式大纲</h2></div><button type="button" disabled={busy} onClick={()=>{void refresh();}}>刷新正式版本</button></header>
    <p>人审保存与正式采用是两个决定。先准备正式候选，再由有审阅权限的成员明确采用。</p>
    {error&&<p role="alert" className="outline-warning">{error}</p>}{message&&<p role="status">{message}</p>}{busy&&<p role="status">正在核对正式版本与操作回执…</p>}
    {state&&<p className="outline-audit">已核对正式修订 {state.snapshotRevision} · 写入版本 {state.writeVersion} · 结构 {state.schemaVersion}</p>}
    {state?.actorId===null&&(permissions.includes('candidate:write')||permissions.includes('candidate:review'))&&<p className="outline-warning">当前账号尚未关联正式身份，请由管理员完成关联后再准备或采用。</p>}
    {pending&&<aside className="outline-warning"><p>上次明确操作尚未确认。刷新只读取记录，重试使用原内容与原请求。</p>{pending.kind==='prepare'&&<p>原大纲记录：{pending.runId}</p>}<button type="button" disabled={busy} onClick={()=>{void execute(pending);}}>使用原请求重试</button></aside>}
    <div className="outline-actions"><button type="button" disabled={busy||!state||!!legacy} onClick={()=>showFormal()}>查看正式大纲</button><button type="button" disabled={blocked||!canWrite||!source||!!legacy} onClick={prepare}>准备正式大纲候选</button></div>
    {state&&!legacy&&<div className="outline-history-select"><label><span>正式修订号</span><input aria-label="正式修订号" type="number" min={1} max={state.snapshotRevision} step={1} value={historyRevision} onChange={event=>setHistoryRevision(event.target.value)} disabled={busy}/></label><button type="button" disabled={busy||!validHistory} onClick={()=>showFormal(selectedRevision)}>查看指定正式修订</button></div>}
    {!source&&<p className="outline-hint">选择来源仍有效且已保存人审的大纲，才可准备正式候选。已有正式内容与候选仍可查看。</p>}
    {legacy&&<section className="outline-section" aria-label="项目结构升级"><h3>先升级项目结构</h3><p>升级只改变结构版本，不会自动采用这份大纲。请先准备并明确采用升级候选。</p><button type="button" disabled={blocked||!canWrite} onClick={prepareUpgrade}>准备项目结构升级</button>
      <ul className="outline-adoption-list">{manuals.map(item=><li key={item.candidateId}><button type="button" disabled={busy} onClick={()=>{void open(item.candidateId,true);}}>核对项目变更 · {item.applicationId??item.candidateId}</button><span>{statusNames[item.status]}</span></li>)}</ul>{manualCursor&&<button type="button" disabled={busy} onClick={()=>{void more(true);}}>加载更多项目变更</button>}
      {upgrade&&<div className="outline-upgrade-proof"><h4>已核验的结构升级</h4><p>{upgrade.from} → {upgrade.to} · {statusNames[upgrade.candidate.status]}</p><p className="outline-audit">候选 {upgrade.candidate.candidateId}</p><label className="outline-field"><span>项目升级拒绝理由</span><textarea aria-label="项目升级拒绝理由" value={upgradeReason} maxLength={500} rows={2} disabled={busy||!canReview} onChange={event=>setUpgradeReason(event.target.value)}/></label><div className="outline-actions"><button type="button" disabled={blocked||!canReview||!upgrade.candidate.canAdopt} onClick={()=>decideUpgrade('adopt')}>明确采用项目升级</button><button type="button" disabled={blocked||!canReview||!upgrade.candidate.canReject||!upgradeReason.trim()} onClick={()=>decideUpgrade('reject')}>拒绝项目升级</button></div></div>}
    </section>}
    <section className="outline-section" aria-label="正式大纲候选目录"><header className="outline-section-heading"><h3>正式候选记录</h3>{run&&<button type="button" disabled={busy} onClick={()=>{void refresh(!all);}}>{all?'只看当前大纲':'查看全部大纲候选'}</button>}</header>
      {!items.length&&<p>暂无正式大纲候选。</p>}<ul className="outline-adoption-list">{items.map(item=><li key={item.candidateId}><button type="button" disabled={busy} aria-pressed={detail?.candidateId===item.candidateId} onClick={()=>{void open(item.candidateId);}}><strong>{statusNames[item.status]}</strong><small>{item.runId} · {item.operationCount} 项变更 · {item.createdAt}</small></button></li>)}</ul>{cursor&&<button type="button" disabled={busy} onClick={()=>{void more();}}>加载更多正式候选</button>}
    </section>
    {detail&&<section className="outline-section" aria-label="正式候选决定"><h3>{statusNames[detail.status]}</h3><p>对应大纲：{detail.runId}</p><p className="outline-audit">候选 {detail.candidateId} · 基于正式修订 {detail.baseRevision} · {detail.operationCount} 项变更</p>
      <p>{detail.sourceState==='current'?'已核对当前人审来源。':detail.sourceState==='stale'?'来源已经变化，不能采用；仍可明确拒绝这份候选。':'暂时无法核对来源，不能采用。'}</p>
      {detail.runId!==run?.runId&&<aside className="outline-warning"><p>这份候选对应另一份大纲，请先打开该大纲记录核对五件套。</p>{onOpenRun&&<button type="button" disabled={busy} onClick={()=>onOpenRun(detail.runId)}>打开对应大纲记录</button>}</aside>}
      {detail.preparation&&<button type="button" disabled={busy} onClick={()=>setReceipt(detail.preparation)}>查看准备回执与提示</button>}
      <div className="outline-actions"><button type="button" disabled={blocked||!canReview||!detail.canReview||detail.sourceState!=='current'||detail.runId!==run?.runId} onClick={()=>decide('adopt')}>明确采用到正式大纲</button><button type="button" disabled={blocked||!canReview||!detail.canReview||!reason.trim()} onClick={()=>decide('reject')}>拒绝这份正式候选</button></div>
      {!detail.canReview&&<p className="outline-hint">当前候选状态或账号身份不允许审阅决定。</p>}
    </section>}
    {detail&&<label className="outline-field"><span>正式候选拒绝理由</span><textarea aria-label="正式候选拒绝理由" value={reason} maxLength={500} rows={3} disabled={busy||!canReview} onChange={event=>setReason(event.target.value)}/></label>}
    {receipt&&<><button type="button" disabled={busy} onClick={()=>showFormal(receipt.adoption?.to_revision??receipt.snapshotRevision)}>查看回执对应正式修订</button><ReceiptPanel key={receipt.candidateId+':'+receipt.kind+':'+receipt.requestId} client={client} projectId={projectId} receipt={receipt} onFailure={onFailure}/></>}
    {upgradeReceipt&&<aside className="outline-upgrade-receipt"><h3>项目升级操作回执</h3><p>记录状态：{statusNames[upgradeReceipt.status]} · 当时正式修订 {upgradeReceipt.snapshotRevision}</p>{[...upgradeReceipt.issues,...upgradeReceipt.warnings].map((item,index)=><p key={index}>{item.message}<small>{item.where}</small></p>)}</aside>}
    {formal&&<FormalProjectBoundary onClose={()=>setFormal(false)}><Suspense fallback={<p role="status">正在打开正式大纲…</p>}><FormalOutlinePane key={formalEpoch} client={client} generation={generation} projectId={projectId} onFailure={onFailure} onClose={()=>setFormal(false)} {...(formalRevision===undefined?{}:{revision:formalRevision})}/></Suspense></FormalProjectBoundary>}
  </section>;
}
function ReceiptPanel({client,projectId,receipt,onFailure}:{client:ApiClient;projectId:string;receipt:OutlineReceipt;onFailure:(problem:unknown)=>void}){
  const [pages,setPages]=useState<Partial<Record<'issues'|'warnings',OutlineReceiptPage>>>({}),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),lifetime=useRef(new AdoptionLifetime());
  useLayoutEffect(()=>()=>lifetime.current.close(),[]);
  async function load(section:'issues'|'warnings'){
    if(busy)return;const previous=pages[section],ticket=lifetime.current.next();setBusy(true);setError(null);
    try{const page=await client.outlineReceiptMessages(projectId,receipt.candidateId,{kind:receipt.kind,requestId:receipt.requestId,section,limit:50,...(previous?.nextCursor?{cursor:previous.nextCursor}:{})},ticket.signal),total=section==='issues'?receipt.issueCount:receipt.warningCount;
      const loaded=(previous?.items.length??0)+page.items.length;
      if(page.total!==total||page.nextCursor&&(!page.items.length||page.nextCursor===previous?.nextCursor||loaded>=total)||!page.nextCursor&&loaded!==total||loaded>total)throw new ApiError('BAD_RESPONSE');
      if(lifetime.current.current(ticket))setPages(old=>({...old,[section]:{...page,items:[...(previous?.items??[]),...page.items]}}));
    }catch(problem){if(lifetime.current.current(ticket)){setError(errorText(problem));if(problem instanceof ApiError&&problem.code==='UNAUTHENTICATED')onFailure(problem);}}finally{if(lifetime.current.current(ticket))setBusy(false);}
  }
  return <section className="outline-receipt" aria-label="正式大纲操作回执"><h3>{receipt.kind==='preparation'?'准备回执':'决定回执'}</h3><p>回执中的候选状态：{statusNames[receipt.status]} · 当时正式修订 {receipt.snapshotRevision} · 写入版本 {receipt.writeVersion}</p>
    {receipt.kind==='decision'&&receipt.issueCount>0&&<p className="outline-warning">本次决定未完成；下列既有审计记录仅供核对，不表示本次操作成功。</p>}
    <p className="outline-audit">候选 {receipt.candidateId} · 请求 {receipt.requestId}</p>{receipt.adoption&&<p>采用记录：修订 {receipt.adoption.from_revision} → {receipt.adoption.to_revision} · {receipt.adoption.at}</p>}{receipt.rejection&&<p>拒绝记录：{receipt.rejection.reason} · {receipt.rejection.at}</p>}
    {error&&<p role="alert" className="outline-warning">{error}</p>}
    {(['issues','warnings'] as const).map(section=>{const page=pages[section],total=section==='issues'?receipt.issueCount:receipt.warningCount;return <section key={section} aria-label={section==='issues'?'回执问题':'回执提醒'}><h4>{section==='issues'?'问题':'提醒'} · {total} 项</h4>{page?.items.map((item,index)=><article className="outline-issue" key={index}><p>{item.message}</p><small>{item.code} · {item.where}</small></article>)}{total===0?<p>无。</p>:(!page||page.nextCursor)&&<button type="button" disabled={busy} onClick={()=>{void load(section);}}>{page?'加载更多':'读取'}{section==='issues'?'问题':'提醒'}（已显示 {page?.items.length??0} / {total}）</button>}</section>;})}
  </section>;
}
