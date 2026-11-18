import {lazy,Suspense,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import type {DevelopmentRunView} from '@camery/script/http';
import type {DevelopmentCandidatePrepare,WorkbenchUpgradeInput,WorkbenchAdoptInput,WorkbenchRejectInput,WorkbenchState,WorkbenchCandidateSummary,WorkbenchCandidateDetail} from '@camery/ir/workbench';
import {ApiClient,ApiError} from './api.js';
import {AdoptionLifetime,AdoptionPending,adoptionSource,decisionReceiptFeedback} from './DevelopmentAdoptionState.js';
import './development-adoption.css';
import {FormalProjectBoundary} from './FormalProjectBoundary.js';
const FormalProjectPane=lazy(async()=>({default:(await import('./FormalProjectPane.js')).FormalProjectPane}));

interface Props {client:ApiClient;generation:number;projectId:string;run:DevelopmentRunView;onFailure:(error:unknown)=>void}
type Action={kind:'prepare';command:DevelopmentCandidatePrepare}|{kind:'upgrade';command:WorkbenchUpgradeInput}|{kind:'adopt';candidateId:string;command:WorkbenchAdoptInput}|{kind:'reject';candidateId:string;command:WorkbenchRejectInput};
const statusNames:Record<WorkbenchCandidateSummary['status'],string>={prepared:'准备待完成',candidate:'待采用',adopted:'已采用',rejected:'已拒绝',conflicted:'存在冲突',unchanged:'内容相同，无需变更'};
const collections:Record<string,string>={worlds:'世界设定',characters:'人物',character_relationships:'人物关系',development_plans:'故事开发方案',episode_plans:'分集计划',episodes:'分集',scenes:'场景',shots:'镜头',assets:'素材',projects:'项目',sources:'来源',appearances:'人物造型',props:'道具',locations:'地点',claims:'来源论据',beats:'情节点',lines:'对白',renditions:'版本表现',panels:'分镜',audio_tracks:'音轨',audio_cues:'声音提示',asset_references:'素材引用',adaptation_decisions:'改编决定',segments:'段落',shot_takes:'镜头方案',plot_units:'情节单元',episode_state_snapshots:'分集状态',shot_lineage:'镜头沿革',locks:'内容锁定'};
const reasons:Record<string,string>={UNMANAGED_CANDIDATE:'外部候选缺少来源记录，不能直接采用。',UNMANAGED:'外部候选缺少来源记录，不能直接采用。',SOURCE_STALE:'来源已有新修订，请查看最新开发记录。',SOURCE_UNAVAILABLE:'暂时无法核对来源，不能采用。',SNAPSHOT_STALE:'正式剧本已有更新，请刷新后重新检查差异。',WRITE_VERSION_CONFLICT:'项目候选或审阅记录已有更新，请刷新后重试。',SCHEMA_UPGRADE_REQUIRED:'请先准备并采用项目升级候选。',PROJECT_BINDING_MISSING:'此项目尚未关联正式剧本，请由管理员完成项目关联。',PRINCIPAL_BINDING_MISSING:'当前账号尚未关联正式剧本审阅身份，请联系管理员。',SOURCE_POLICY_MISSING:'项目尚未配置开发结果的来源规则，请联系管理员。',REVIEW_PERMISSION_REQUIRED:'当前账号没有正式剧本审阅权限。',WRITE_PERMISSION_REQUIRED:'当前账号没有候选准备权限。',PREPARED:'候选准备尚未完成，请先继续准备。'};
function explanation(code:string){return reasons[code]??'此候选暂时不能采用。请刷新项目后查看审阅条件。';}
Object.assign(reasons,{LOCKED:'变更涉及已锁定的内容，需先由有权限的成员解除保护。',LOCKED_LINE:'变更涉及已锁定的对白，需先明确解锁。',LOCK_AUTHORITY:'只有获得授权的成员才能变更内容锁定。',LOCK_OWNER:'此内容只能由锁定它的成员解除保护。',LOCK_OPERATION_REQUIRED:'请先完成独立的内容解锁决定，再准备候选。',BASE_REVISION_MISMATCH:'候选基于的正式内容已有更新，请刷新后重新核对。',SOURCE_CHANGED:'开发来源已有新修订，请查看最新审阅记录。'});
function errorText(problem:unknown){
  const code=problem instanceof ApiError?problem.code:'';
  return reasons[code]??({FORBIDDEN:'当前账号没有执行此操作的权限。已有内容仍可查看。',NOT_FOUND:'项目或候选暂时不可用，请刷新记录。',CONFLICT:'项目或来源已有更新，请刷新后重新检查。',INVALID_REQUEST:'本次操作内容不完整，请刷新记录后重试。',INVALID_INPUT:'本次操作内容不符合要求，请检查后重试。'}[code]??'尚未确认本次操作结果。请保留当前页面，使用原请求重试。');
}
function unknownResult(problem:unknown){return !(problem instanceof ApiError)||['NETWORK_FAILED','TIMEOUT','CANCELLED','BAD_RESPONSE','HTTP_FAILED','STORAGE_FAILED'].includes(problem.code);}

/** Remount the entire in-memory lifetime before rendering another account, project or run. */
export function DevelopmentAdoptionPane(props:Props){
  const context=useRef({client:props.client,generation:props.generation,projectId:props.projectId,runId:props.run.runId,key:0});
  const old=context.current;if(old.client!==props.client||old.generation!==props.generation||old.projectId!==props.projectId||old.runId!==props.run.runId)context.current={client:props.client,generation:props.generation,projectId:props.projectId,runId:props.run.runId,key:old.key+1};
  return <AdoptionSession key={context.current.key} {...props}/>;
}
function AdoptionSession({client,generation,projectId,run,onFailure}:Props){
  const [state,setState]=useState<WorkbenchState|null>(null);const [items,setItems]=useState<WorkbenchCandidateSummary[]>([]);const [detail,setDetail]=useState<WorkbenchCandidateDetail|null>(null);
  const [cursor,setCursor]=useState<string|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [message,setMessage]=useState<string|null>(null);const [reason,setReason]=useState('');const [hasPending,setHasPending]=useState(false);
  const [allCandidates,setAllCandidates]=useState(false);
  const [decisionIssues,setDecisionIssues]=useState<WorkbenchCandidateDetail['issues']>([]);
  const [formalOpen,setFormalOpen]=useState(false);
  const lifetime=useRef(new AdoptionLifetime());const pending=useRef(new AdoptionPending<Action>());
  useLayoutEffect(()=>()=>{lifetime.current.close();pending.current.clear();},[]);
  function fail(problem:unknown){if(problem instanceof ApiError&&problem.code==='UNAUTHENTICATED'){onFailure(problem);return;}setError(errorText(problem));}
  async function read(signal:AbortSignal,selectedId?:string,all=allCandidates){
    const [next,page,candidate]=await Promise.all([client.getWorkbenchState(projectId,signal),client.listWorkbenchCandidates(projectId,all?undefined:run.runId,undefined,signal),selectedId?client.getWorkbenchCandidate(projectId,selectedId,signal):Promise.resolve(null)]);
    return {next,page,candidate};
  }
  async function refresh(){
    if(busy)return;const ticket=lifetime.current.next();setBusy(true);setError(null);
    try{const result=await read(ticket.signal,detail?.candidateId);if(!lifetime.current.current(ticket))return;setState(result.next);setItems(result.page.items);setCursor(result.page.nextCursor);setDetail(result.candidate);}
    catch(problem){if(lifetime.current.current(ticket))fail(problem);}finally{if(lifetime.current.current(ticket))setBusy(false);}
  }
  useEffect(()=>{void refresh();},[]);
  async function toggleScope(){
    if(busy||hasPending)return;const all=!allCandidates;const ticket=lifetime.current.next();setBusy(true);setError(null);setMessage(null);setDecisionIssues([]);
    try{const result=await read(ticket.signal,undefined,all);if(!lifetime.current.current(ticket))return;setState(result.next);setItems(result.page.items);setCursor(result.page.nextCursor);setDetail(null);setReason('');setAllCandidates(all);}
    catch(problem){if(lifetime.current.current(ticket))fail(problem);}finally{if(lifetime.current.current(ticket))setBusy(false);}
  }
  async function open(candidateId:string){
    if(busy||hasPending)return;const ticket=lifetime.current.next();setBusy(true);setError(null);setMessage(null);setDecisionIssues([]);setReason('');
    try{const result=await client.getWorkbenchCandidate(projectId,candidateId,ticket.signal);if(lifetime.current.current(ticket))setDetail(result);}
    catch(problem){if(lifetime.current.current(ticket))fail(problem);}finally{if(lifetime.current.current(ticket))setBusy(false);}
  }
  async function more(){
    if(!cursor||busy)return;const ticket=lifetime.current.next();setBusy(true);
    try{const page=await client.listWorkbenchCandidates(projectId,allCandidates?undefined:run.runId,cursor,ticket.signal);if(!lifetime.current.current(ticket))return;setItems(old=>[...old,...page.items.filter(item=>!old.some(existing=>existing.candidateId===item.candidateId))]);setCursor(page.nextCursor);}
    catch(problem){if(lifetime.current.current(ticket))fail(problem);}finally{if(lifetime.current.current(ticket))setBusy(false);}
  }
  async function execute(action:Action,requestId:string){
    if(busy)return;const retained=pending.current.begin(action.kind,{requestId,body:action});setHasPending(true);const ticket=lifetime.current.next();setBusy(true);setError(null);setMessage(null);setDecisionIssues([]);
    let acknowledged=false;let decisionSucceeded=true;
    try{
      const original=retained.body;let candidateId:string;
      if(original.kind==='prepare'){const result=await client.prepareDevelopmentCandidate(projectId,run.runId,original.command,ticket.signal);candidateId=result.candidateId;if(lifetime.current.current(ticket))setDetail(result);}
      else if(original.kind==='upgrade'){const result=await client.prepareWorkbenchUpgrade(projectId,original.command,ticket.signal);candidateId=result.candidateId;if(lifetime.current.current(ticket))setDetail(result);}
      else{candidateId=original.candidateId;const receipt=original.kind==='adopt'?await client.adoptWorkbenchCandidate(projectId,candidateId,retained.requestId,original.command,ticket.signal):await client.rejectWorkbenchCandidate(projectId,candidateId,retained.requestId,original.command,ticket.signal);const feedback=decisionReceiptFeedback(original.kind,receipt);decisionSucceeded=feedback.message!==null;if(lifetime.current.current(ticket)){setMessage(feedback.message);setError(feedback.error);setDecisionIssues(feedback.issues);}}
      if(!lifetime.current.current(ticket))return;acknowledged=true;pending.current.clear();setHasPending(false);
      const result=await read(ticket.signal,candidateId);if(!lifetime.current.current(ticket))return;setState(result.next);setItems(result.page.items);setCursor(result.page.nextCursor);setDetail(result.candidate);if(decisionSucceeded)setReason('');
    }catch(problem){if(lifetime.current.current(ticket)){if(!unknownResult(problem)){pending.current.clear();setHasPending(false);}if(acknowledged&&!(problem instanceof ApiError&&problem.code==='UNAUTHENTICATED'))setError('已收到本次操作回执，但暂时无法恢复最新记录。请刷新正式版本后继续。');else fail(problem);}}
    finally{if(lifetime.current.current(ticket))setBusy(false);}
  }
  function prepare(){
    const source=adoptionSource(run);if(!state||!source||!state.canWrite||hasPending)return;
    const prepared=detail?.managed&&detail.status==='prepared'&&detail.source.kind==='development'&&detail.source.runId===run.runId&&detail.applicationId&&detail.baseWriteVersion!==null?detail:null;
    if(!prepared&&(!['0.6.0-draft','0.7.0-draft'].includes(state.schemaVersion)||run.sourceChanged))return;
    const applicationId=prepared?.applicationId??crypto.randomUUID();
    const command={applicationId,...source,expectedSnapshotRevision:prepared?.baseRevision??state.snapshotRevision,expectedWriteVersion:prepared?.baseWriteVersion??state.writeVersion};void execute({kind:'prepare',command},applicationId);
  }
  function upgrade(){
    if(!state?.canWrite||hasPending||state.schemaVersion!=='0.5.0-draft')return;
    const prepared=!allCandidates&&detail?.managed&&detail.status==='prepared'&&detail.source.kind==='manual'&&detail.applicationId&&detail.baseWriteVersion!==null?detail:null;
    const applicationId=prepared?.applicationId??crypto.randomUUID();void execute({kind:'upgrade',command:{applicationId,expectedSnapshotRevision:prepared?.baseRevision??state.snapshotRevision,expectedWriteVersion:prepared?.baseWriteVersion??state.writeVersion}},applicationId);
  }
  function decide(kind:'adopt'|'reject'){
    if(!detail||!state?.canReview||hasPending||!(kind==='adopt'?detail.canAdopt:detail.canReject)||kind==='reject'&&!reason.trim())return;
    const command={scope:detail.scope,expectedSnapshotRevision:detail.snapshotRevision,expectedWriteVersion:detail.writeVersion};
    void execute(kind==='adopt'?{kind,candidateId:detail.candidateId,command}:{kind,candidateId:detail.candidateId,command:{...command,reason:reason.trim()}},crypto.randomUUID());
  }
  return <><DevelopmentAdoptionView state={state} items={items} detail={detail} busy={busy} error={error} message={message} pending={hasPending} reason={reason} nextCursor={cursor} sourceChanged={run.sourceChanged}
    decisionIssues={decisionIssues} runId={run.runId} allCandidates={allCandidates} onListScope={()=>{void toggleScope();}}
    onFormalOpen={()=>setFormalOpen(true)} onRefresh={()=>{void refresh();}} onPrepare={prepare} onUpgrade={upgrade} onOpen={id=>{void open(id);}} onMore={()=>{void more();}} onAdopt={()=>decide('adopt')} onReject={()=>decide('reject')} onReason={setReason} onRetry={()=>{const original=pending.current.value;if(original)void execute(original.body,original.requestId);}}/>
    {formalOpen&&<FormalProjectBoundary onClose={()=>setFormalOpen(false)}><Suspense fallback={<p className="development-hint" role="status">正在打开正式内容…</p>}><FormalProjectPane client={client} generation={generation} projectId={projectId} onFailure={onFailure} onClose={()=>setFormalOpen(false)}/></Suspense></FormalProjectBoundary>}</>;
}
interface ViewProps {state:WorkbenchState|null;items:readonly WorkbenchCandidateSummary[];detail:WorkbenchCandidateDetail|null;busy:boolean;error:string|null;message:string|null;decisionIssues?:WorkbenchCandidateDetail['issues'];pending:boolean;reason:string;nextCursor:string|null;sourceChanged:boolean;runId?:string;allCandidates?:boolean;onFormalOpen?:()=>void;onListScope?:()=>void;onRefresh:()=>void;onPrepare:()=>void;onUpgrade:()=>void;onOpen:(id:string)=>void;onMore:()=>void;onAdopt:()=>void;onReject:()=>void;onRetry:()=>void;onReason:(value:string)=>void}
export function DevelopmentAdoptionView(props:ViewProps){
  const {state,detail,busy,pending}=props;const reasonId=useId();const blocked=busy||pending;const legacy=state?.schemaVersion==='0.5.0-draft';
  const resumable=detail?.managed&&detail.status==='prepared'&&detail.source.kind==='development'&&detail.source.runId===props.runId;
  const adoptable=detail?.managed&&detail.status==='candidate'&&detail.canAdopt&&(detail.source.kind!=='development'||detail.source.state==='current');
  return <section className="development-adoption" aria-label="正式剧本采用"><header className="development-section-heading"><div><p className="development-kicker">从审阅稿到正式版本</p><h2>正式剧本</h2></div><button type="button" onClick={props.onRefresh} disabled={busy}>刷新正式版本</button></header>
    <p className="development-hint">设定与分集的审阅已完成。先准备候选并核对变更，再由有审阅权限的成员明确采用。</p>
    {props.onFormalOpen&&<div className="development-actions"><button type="button" disabled={busy} onClick={props.onFormalOpen}>查看正式内容</button></div>}
    {props.error&&<p className="development-warning" role="alert">{props.error}</p>}{props.message&&<p className="development-notice" role="status">{props.message}</p>}{busy&&<p className="development-hint" role="status">正在核对正式版本与候选记录…</p>}
    {!!props.decisionIssues?.length&&<ul className="development-issues" aria-label="本次操作提示">{props.decisionIssues.map((issue,index)=><li key={index}>{reasons[issue.code]??(issue.message||explanation(issue.code))}{issue.where&&<small> · {issue.where}</small>}</li>)}</ul>}
    {pending&&<aside className="development-warning"><p>上次操作结果尚未确认。重试会使用原内容与原身份；刷新不会重新提交。</p><button type="button" disabled={busy} onClick={props.onRetry}>使用原请求重试</button></aside>}
    {state&&<><div className="development-adoption-baseline"><span>正式版本 {state.snapshotRevision}</span><span>审阅记录版本 {state.writeVersion}</span><span>{state.nativePending} 份待处理候选</span></div><p className="development-hint">{state.counts.filter(item=>item.count>0).map(item=>`${collections[item.collection]??item.collection} ${item.count}`).join(' · ')||'正式剧本尚无内容'}</p>
      {!state.actorId&&<p className="development-warning">当前账号尚未关联正式剧本身份。可以查看内容；请联系管理员后再准备或审阅候选。</p>}
      {legacy?<div className="development-adoption-intro"><h3>先为项目准备新的故事结构</h3><p>项目仍使用旧版故事结构。升级也会保存为独立候选；查看差异并明确采用后，才能接纳原创开发结果。</p><button type="button" disabled={blocked||!state.canWrite} onClick={props.onUpgrade}>{!props.allCandidates&&detail?.status==='prepared'&&detail.source.kind==='manual'?'继续准备项目升级候选':'准备项目升级候选'}</button></div>:<div className="development-actions"><button className="button primary" type="button" disabled={blocked||!state.canWrite||(props.sourceChanged&&!resumable)} onClick={props.onPrepare}>{resumable?'继续准备原候选':'准备正式采用候选'}</button></div>}
      {!state.canWrite&&<p className="development-hint">当前账号可查看正式版本，准备候选需要项目创作权限。</p>}{!state.canReview&&<p className="development-hint">采用或拒绝候选需要正式剧本审阅权限。</p>}{props.sourceChanged&&<p className="development-warning">此开发记录的来源已更新。已有候选仍可查看，请先核对最新创意与审阅。</p>}
    </>}
    <div className="development-adoption-list"><div className="development-section-heading"><h3>{props.allCandidates?'项目全部候选':'本次开发的已保存候选'}</h3>{props.onListScope&&<button type="button" disabled={blocked} onClick={props.onListScope}>{props.allCandidates?'返回本次开发候选':'查看项目全部候选'}</button>}</div>{!props.items.length&&<p className="development-hint">尚未准备候选。准备后可从这里恢复查看。</p>}{props.items.map(item=><button type="button" key={item.candidateId} disabled={blocked} aria-pressed={detail?.candidateId===item.candidateId} onClick={()=>props.onOpen(item.candidateId)}><strong>{statusNames[item.status]}</strong><span>{item.source.kind==='development'?'原创开发':item.source.kind==='unmanaged'?'外部候选':'项目结构 / 手动候选'} · 基于正式版本 {item.baseRevision}</span><small>{item.candidateId}</small></button>)}{props.nextCursor&&<button type="button" disabled={blocked} onClick={props.onMore}>更多候选</button>}</div>
    {detail&&<article className="development-adoption-detail"><div className="development-section-heading"><h3>候选变更</h3><span className="development-seal">{statusNames[detail.status]}</span></div><p className="development-audit">基于正式版本 {detail.baseRevision}{detail.baseWriteVersion!==null?` · 原审阅记录版本 ${detail.baseWriteVersion}`:''}<br/>候选作者 {detail.authorKey??detail.authorId}{detail.createdAt?` · ${detail.createdAt}`:''}</p>
      <p className="development-hint">影响范围：{detail.scope.kind==='project'?'整个项目':detail.scope.kind==='episode'?'指定分集':'指定场景'} · {detail.scope.id}</p>
      {!detail.managed&&<p className="development-warning">外部候选缺少来源记录，不能直接采用。保留原内容供核对。</p>}{detail.source.kind==='development'&&<p className={detail.source.state==='current'?'development-hint':'development-warning'}>开发来源：{detail.source.state==='current'?'与已保存审阅一致':detail.source.state==='stale'?'已有新修订，暂不能采用':'暂时无法核对来源，暂不能采用'}</p>}
      {detail.blockingReasons.length>0&&<ul className="development-issues">{detail.blockingReasons.map((code,index)=><li key={`${code}:${index}`}>{explanation(code)}</li>)}</ul>}
      {[...detail.issues,...detail.warnings].length>0&&<ul className="development-issues">{[...detail.issues,...detail.warnings].map((issue,index)=><li key={index}><strong>{reasons[issue.code]??(issue.message||explanation(issue.code))}</strong>{issue.where&&<small> · {issue.where}</small>}</li>)}</ul>}
      {!detail.differences.length&&<p className="development-hint">{detail.status==='prepared'?'原准备请求已保存，尚待完成候选内容。':'没有需要写入的内容差异。'}</p>}
      {detail.differences.map((difference,index)=><details className="development-adoption-difference" key={`${difference.collection}:${difference.id}:${index}`} open={detail.differences.length<5}><summary>{collections[difference.collection]??difference.collection} · {difference.kind==='add'?'新增':difference.kind==='remove'?'移除':'修改'}<small>{difference.id}</small></summary><div className="development-adoption-comparison"><div><h4>变更前</h4><pre>{difference.before===null?'尚无此项':JSON.stringify(difference.before,null,2)}</pre></div><div><h4>变更后</h4><pre>{difference.after===null?'移除此项':JSON.stringify(difference.after,null,2)}</pre></div></div></details>)}
      <div className="development-adoption-decision"><p>采用会更新正式剧本。请先核对以上全部变更。</p><button className="button primary" type="button" disabled={blocked||!state?.canReview||!adoptable} onClick={props.onAdopt}>采用到正式剧本</button><label className="development-field" htmlFor={reasonId}><span>拒绝理由</span><textarea id={reasonId} value={props.reason} maxLength={500} disabled={blocked||!state?.canReview||!detail.canReject} onChange={event=>props.onReason(event.target.value)} rows={2}/></label><button type="button" disabled={blocked||!state?.canReview||!detail.canReject||!props.reason.trim()} onClick={props.onReject}>保存拒绝决定</button></div>
    </article>}
  </section>;
}
