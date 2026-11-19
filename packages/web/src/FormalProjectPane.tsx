import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {WorkbenchCollectionSchema,WorkbenchReadQuerySchema} from '@camery/ir/workbench';
import type {WorkbenchSnapshot,WorkbenchReadQuery,WorkbenchObjectHistory,WorkbenchObjectRef} from '@camery/ir/workbench';
import {ApiClient,ApiError} from './api.js';
import {AdoptionLifetime as ReadLifetime} from './DevelopmentAdoptionState.js';
import {FormalProjectPages,formalVisibleValue,formalHistoryTarget,type FormalHistoryTarget} from './FormalProjectState.js';
import './FormalProject.css';

interface Props {client:ApiClient;generation:number;projectId:string;onFailure:(error:unknown)=>void;onClose:()=>void}
export interface FormalProjectFilter {scope:'project'|'episode'|'scene';scopeId:string;renditionId:string;collection:''|WorkbenchObjectRef['collection']}
const emptyFilter:FormalProjectFilter={scope:'project',scopeId:'',renditionId:'',collection:''};
const labels:Record<WorkbenchObjectRef['collection'],string>={adaptation_plans:'改编规划',outline_beats:'大纲节拍',outline_episode_plans:'大纲分集',asset_plans:'资产规划',outline_plot_units:'大纲PlotUnit',outline_adaptation_decisions:'大纲取舍',worlds:'世界设定',characters:'人物',character_relationships:'人物关系',development_plans:'故事开发方案',episode_plans:'分集计划',episodes:'分集',scenes:'场景',shots:'镜头',assets:'素材',sources:'来源',appearances:'人物造型',props:'道具',locations:'地点',claims:'来源论据',beats:'情节点',lines:'对白',renditions:'版本表现',panels:'分镜',audio_tracks:'音轨',audio_cues:'声音提示',asset_references:'素材引用',adaptation_decisions:'改编决定',segments:'段落',shot_takes:'镜头方案',plot_units:'情节单元',episode_state_snapshots:'分集状态',continuity_snapshots:'连续性四账',locks:'内容锁定'};
function filterQuery(filter:FormalProjectFilter):WorkbenchReadQuery{
  const result=WorkbenchReadQuerySchema.safeParse({...(filter.scope==='episode'?{episodeId:filter.scopeId.trim()}:filter.scope==='scene'?{sceneId:filter.scopeId.trim()}:{}),...(filter.renditionId.trim()?{renditionId:filter.renditionId.trim()}:{}),...(filter.collection?{collection:filter.collection}:{}),limit:50});
  if(!result.success)throw new ApiError('INVALID_REQUEST');return result.data;
}
function readError(problem:unknown){
  const code=problem instanceof ApiError?problem.code:'';
  return ({FORBIDDEN:'当前账号没有读取此内容的权限。已读取的内容仍保留在页面中。',SNAPSHOT_STALE:'正式内容已更新，请读取最新正式版本后重新查看。',NOT_FOUND:'正式内容或对象不存在，请核对范围后刷新。',PROJECT_BINDING_MISSING:'此项目尚未关联正式剧本，请由管理员完成项目关联。',INVALID_REQUEST:'请填写所选分集、场景或版本的有效标识，再查看内容。',INVALID_INPUT:'所选范围不符合要求，请检查后重试。',CONFLICT:'正式版本与当前范围不一致，请刷新后重新选择。'}[code]??'暂时无法读取可靠的正式内容，请稍后刷新重试。');
}
export function FormalProjectPane(props:Props){
  const context=useRef({client:props.client,generation:props.generation,projectId:props.projectId,key:0});const old=context.current;
  if(old.client!==props.client||old.generation!==props.generation||old.projectId!==props.projectId)context.current={client:props.client,generation:props.generation,projectId:props.projectId,key:old.key+1};
  return <FormalSession key={context.current.key} {...props}/>;
}
function FormalSession({client,projectId,onFailure,onClose}:Props){
  const lifetime=useRef(new ReadLifetime());const stored=useRef(new FormalProjectPages());
  const [pages,setPages]=useState<WorkbenchSnapshot[]>([]);const [filter,setFilter]=useState<FormalProjectFilter>(emptyFilter);const [history,setHistory]=useState<WorkbenchObjectHistory|null>(null);
  const [historyTarget,setHistoryTarget]=useState<FormalHistoryTarget>({collection:'characters',id:''});
  const [busy,setBusy]=useState(false);const [stale,setStale]=useState(false);const [error,setError]=useState<string|null>(null);const [mediaMessage,setMediaMessage]=useState<string|null>(null);
  useLayoutEffect(()=>()=>{lifetime.current.close();stored.current.clear();},[]);
  function failure(problem:unknown){
    if(problem instanceof ApiError&&problem.code==='UNAUTHENTICATED'){onFailure(problem);return;}
    if(problem instanceof ApiError&&problem.code==='SNAPSHOT_STALE'){stored.current.clear();setPages([]);setHistory(null);setStale(true);}
    setError(readError(problem));
  }
  async function load(query:WorkbenchReadQuery,append=false){
    if(busy)return;const ticket=lifetime.current.next();setBusy(true);setError(null);setMediaMessage(null);
    try{const page=await client.readWorkbenchSnapshot(projectId,query,ticket.signal);if(!lifetime.current.current(ticket))return;
      if(append)stored.current.append(page);else{stored.current.replace(page,query);setHistory(null);}setPages([...stored.current.pages]);setStale(false);
    }catch(problem){if(lifetime.current.current(ticket))failure(problem);}finally{if(lifetime.current.current(ticket))setBusy(false);}
  }
  useEffect(()=>{void load({limit:50});},[]);
  function apply(next=filter){if(busy)return;try{const query=filterQuery(next);setFilter(next);void load(query);}catch(problem){failure(problem);}}
  async function inspect(ref:FormalHistoryTarget,more=false){
    const snapshot=stored.current.pages[0];if(!snapshot||busy||stale)return;const target=formalHistoryTarget(ref);if(!target){setError('请填写规范的历史对象标识，再查找历史。');return;}setHistoryTarget(target);const ticket=lifetime.current.next();setBusy(true);setError(null);
    try{const page=await client.readWorkbenchObjectHistory(projectId,target.collection,target.id,{expectedRevision:snapshot.snapshotRevision,limit:50,...(more&&history?.nextCursor?{cursor:history.nextCursor}:{})},ticket.signal);if(!lifetime.current.current(ticket))return;
      if(more&&history&&history.snapshotRevision===page.snapshotRevision&&history.objectId===page.objectId)setHistory({...page,items:[...history.items,...page.items]});else setHistory(page);
    }catch(problem){if(lifetime.current.current(ticket))failure(problem);}finally{if(lifetime.current.current(ticket))setBusy(false);}
  }
  async function checkAsset(ref:WorkbenchObjectRef){
    const snapshot=stored.current.pages[0];if(!snapshot||busy||stale)return;const ticket=lifetime.current.next();setBusy(true);setError(null);setMediaMessage(null);
    try{await client.checkWorkbenchReadyAsset(projectId,ref.id,ref.version,snapshot.snapshotRevision,ticket.signal);}
    catch(problem){if(!lifetime.current.current(ticket))return;if(problem instanceof ApiError&&['ASSET_NOT_READY','NOT_FOUND'].includes(problem.code))setMediaMessage('素材尚未就绪，当前无法读取媒体。');else failure(problem);}
    finally{if(lifetime.current.current(ticket))setBusy(false);}
  }
  return <FormalProjectView pages={pages} history={history} filter={filter} busy={busy} stale={stale} error={error} mediaMessage={mediaMessage} onFilter={setFilter} onApply={()=>apply()} onRefresh={()=>apply()} onMore={()=>{const query=stored.current.nextQuery();if(query)void load(query,true);}}
    historyTarget={historyTarget} onHistoryTarget={setHistoryTarget} onHistoryLookup={()=>{void inspect(historyTarget);}}
    onHistory={ref=>{void inspect(ref);}} onHistoryMore={()=>{if(history)void inspect({collection:history.collection,id:history.objectId},true);}} onHistoryClose={()=>setHistory(null)} onScope={(kind,id)=>apply(kind==='rendition'?{...filter,renditionId:id,collection:''}:{...filter,scope:kind,scopeId:id,collection:''})} onAsset={ref=>{void checkAsset(ref);}} onClose={onClose}/>;
}
interface ViewProps {pages:readonly WorkbenchSnapshot[];history:WorkbenchObjectHistory|null;filter:FormalProjectFilter;busy:boolean;stale:boolean;error:string|null;mediaMessage:string|null;historyTarget?:FormalHistoryTarget;onHistoryTarget?:(target:FormalHistoryTarget)=>void;onHistoryLookup?:()=>void;onFilter:(filter:FormalProjectFilter)=>void;onApply:()=>void;onRefresh:()=>void;onMore:()=>void;onHistory:(ref:FormalHistoryTarget)=>void;onHistoryMore:()=>void;onHistoryClose:()=>void;onScope:(kind:'episode'|'scene'|'rendition',id:string)=>void;onAsset:(ref:WorkbenchObjectRef)=>void;onClose:()=>void}
const relationNames={ownership:'所属范围',reference:'对象引用',provenance:'来源依据',shot_take:'镜头方案',continuity:'连续性'};
function title(value:Record<string,unknown>,fallback:string){for(const key of ['title','name','summary','text','action','label'])if(typeof value[key]==='string')return value[key];return fallback;}
function exactDuration(value:Record<string,unknown>){
  const duration=value['duration'];if(duration&&typeof duration==='object'&&!Array.isArray(duration)){const timing=duration as Record<string,unknown>;if(typeof timing['planned']==='number')return `计划 ${timing['planned']} 秒${typeof timing['measured']==='number'?` · 实测 ${timing['measured']} 秒`:' · 尚无实测时长'}`;}
  return typeof value['target_seconds']==='number'?`目标 ${value['target_seconds']} 秒`:null;
}
export function FormalProjectView(props:ViewProps){
  const {filter,busy,stale}=props;const first=props.pages[0];const controlId=useId();
  const historyTarget=props.historyTarget??{collection:'characters',id:''};
  const rows=[...new Map(props.pages.flatMap(page=>page.rows).map(row=>[`${row.ref.collection}:${row.ref.id}:${row.ref.version}`,row])).values()];
  const relations=[...new Map(props.pages.flatMap(page=>page.relations).map(relation=>[JSON.stringify(relation),relation])).values()];
  const locks=[...new Map(props.pages.flatMap(page=>page.locks).map(lock=>[`${lock.ref.id}:${lock.ref.version}`,lock])).values()];
  const lineage=[...new Map(props.pages.flatMap(page=>page.lineage).map(edge=>[JSON.stringify(edge),edge])).values()];
  return <section className="formal-project" aria-label="正式内容浏览"><header className="development-section-heading"><div><p className="development-kicker">已采用的故事与制作内容</p><h2>正式内容</h2></div><button type="button" onClick={props.onClose}>关闭正式内容</button></header>
    <p className="development-hint">这里展示已采用的正式快照。分页固定在同一正式版本；候选内容请返回候选变更查看。</p>
    <div className="formal-project-filter"><label className="development-field" htmlFor={`${controlId}-collection`}><span>内容类型</span><select id={`${controlId}-collection`} value={filter.collection} disabled={busy} onChange={event=>props.onFilter({...filter,collection:event.target.value as FormalProjectFilter['collection']})}><option value="">全部内容</option>{WorkbenchCollectionSchema.options.map(collection=><option value={collection} key={collection}>{labels[collection]}</option>)}</select></label>
      <label className="development-field" htmlFor={`${controlId}-scope`}><span>查看范围</span><select id={`${controlId}-scope`} value={filter.scope} disabled={busy} onChange={event=>props.onFilter({...filter,scope:event.target.value as FormalProjectFilter['scope'],scopeId:''})}><option value="project">整个项目</option><option value="episode">指定分集</option><option value="scene">指定场景</option></select></label>
      {filter.scope!=='project'&&<label className="development-field" htmlFor={`${controlId}-id`}><span>{filter.scope==='episode'?'分集标识':'场景标识'}</span><input id={`${controlId}-id`} value={filter.scopeId} disabled={busy} onChange={event=>props.onFilter({...filter,scopeId:event.target.value})}/></label>}
      <label className="development-field" htmlFor={`${controlId}-rendition`}><span>版本表现标识（可选）</span><input id={`${controlId}-rendition`} value={filter.renditionId} disabled={busy} onChange={event=>props.onFilter({...filter,renditionId:event.target.value})}/></label></div>
    <div className="development-actions"><button type="button" disabled={busy} onClick={props.onApply}>查看所选范围</button><button type="button" disabled={busy} onClick={props.onRefresh}>读取最新正式版本</button></div><p className="development-hint">也可直接点击当前页分集、场景或版本表现中的范围按钮。</p>
    {props.error&&<p className="development-warning" role="alert">{props.error}</p>}{busy&&<p className="development-hint" role="status">正在读取正式内容…</p>}{props.mediaMessage&&<p className="development-warning" role="status">{props.mediaMessage}</p>}
    {first&&!stale&&<><div className="formal-project-version"><strong>正式版本 {first.snapshotRevision}</strong><span>记录版本 {first.writeVersion}</span><span>{first.scope.kind==='project'?'整个项目':first.scope.kind==='episode'?'所选分集':'所选场景'}</span></div><p className="development-hint">{first.counts.filter(item=>item.count>0).map(item=>`${labels[item.collection]} ${item.count}`).join(' · ')||'当前范围尚无正式内容'}</p>
      <section className="formal-project-history-lookup" aria-label="查找已删除或历史对象"><h3>查找对象历史</h3><p className="development-hint">已删除的对象也可通过原标识查找。选择当前对象的“查看历史”会自动填入类型与标识。</p><div className="formal-project-filter"><label className="development-field" htmlFor={`${controlId}-history-collection`}><span>历史对象类型</span><select id={`${controlId}-history-collection`} disabled={busy} value={historyTarget.collection} onChange={event=>props.onHistoryTarget?.({...historyTarget,collection:event.target.value as FormalHistoryTarget['collection']})}>{WorkbenchCollectionSchema.options.map(collection=><option value={collection} key={collection}>{labels[collection]}</option>)}</select></label><label className="development-field" htmlFor={`${controlId}-history-id`}><span>历史对象标识</span><input id={`${controlId}-history-id`} value={historyTarget.id} disabled={busy} onChange={event=>props.onHistoryTarget?.({...historyTarget,id:event.target.value})}/></label></div><button type="button" disabled={busy||!formalHistoryTarget(historyTarget)} onClick={props.onHistoryLookup}>查找对象历史</button></section>
      {!rows.length&&<p className="formal-project-empty">此范围没有可显示的正式对象。</p>}{rows.map(row=><article className="formal-project-row" key={`${row.ref.collection}:${row.ref.id}:${row.ref.version}`}><header><div><p className="development-kicker">{labels[row.ref.collection]} · 版本 {row.ref.version} · {row.role==='owned'?'范围内内容':'关联内容'}</p><h3>{title(row.value,labels[row.ref.collection])}</h3></div><button type="button" disabled={busy} onClick={()=>props.onHistory({collection:row.ref.collection,id:row.ref.id})}>查看历史</button></header><small className="formal-project-id">{row.ref.id}</small>{exactDuration(row.value)&&<p className="formal-project-duration">{exactDuration(row.value)}</p>}
        <details open={rows.length<=8}><summary>完整内容</summary><pre>{JSON.stringify(formalVisibleValue(row.value),null,2)}</pre></details><div className="development-actions">{row.ref.collection==='episodes'&&<button type="button" disabled={busy} onClick={()=>props.onScope('episode',row.ref.id)}>查看此分集范围</button>}{row.ref.collection==='scenes'&&<button type="button" disabled={busy} onClick={()=>props.onScope('scene',row.ref.id)}>查看此场景范围</button>}{row.ref.collection==='renditions'&&<button type="button" disabled={busy} onClick={()=>props.onScope('rendition',row.ref.id)}>查看此版本表现</button>}{row.ref.collection==='assets'&&<button type="button" disabled={busy} onClick={()=>props.onAsset(row.ref)}>检查此版本素材是否就绪</button>}</div></article>)}
      {!!props.pages.at(-1)?.nextCursor&&<button type="button" disabled={busy} onClick={props.onMore}>查看更多对象（固定正式版本 {first.snapshotRevision}）</button>}
      <details className="formal-project-evidence" open={relations.some(relation=>relation.stale)}><summary>关系与来源依据 · {relations.length}</summary>{relations.map((relation,index)=><article key={index}><p>{relationNames[relation.kind]} · {relation.field}</p><p>{labels[relation.from.collection]} {relation.from.id} / {relation.from.version} → {labels[relation.to.collection]} {relation.to.id} / {relation.to.version}</p><strong className={relation.stale?'formal-project-stale':''}>{relation.pin==='explicit'?`固定版本 ${relation.to.version}，当前版本 ${relation.currentVersion}`:'使用本次正式快照的对象版本'}{relation.stale?' · 已过期，请核对来源':''}</strong></article>)}</details>
      <details className="formal-project-evidence" open={locks.length>0}><summary>内容锁定 · {locks.length}</summary>{locks.map(lock=><article key={`${lock.ref.id}:${lock.ref.version}`}><p>{lock.reason}</p><p>保护对象 {lock.target} · 字段 {lock.fields.join('、')||'全部内容'}</p><small>锁定成员 {lock.ownerId}</small></article>)}</details>
      <details className="formal-project-evidence"><summary>镜头沿革 · {lineage.length}</summary>{lineage.map((edge,index)=><p key={index}>正式版本 {edge.revision} · {edge.from_ids.join('、')} → {edge.to_ids.join('、')}</p>)}</details>
    </>}
    {props.history&&!stale&&<aside className="formal-project-history" aria-label="对象历史"><header className="development-section-heading"><h3>{labels[props.history.collection]}历史</h3><button type="button" disabled={busy} onClick={props.onHistoryClose}>关闭历史</button></header><p className="development-hint">对象 {props.history.objectId} · 查看截至正式版本 {props.history.snapshotRevision} 的真实记录</p>{props.history.items.map(item=><article key={`${item.ref.version}:${item.snapshotRevision}`}><h4>对象版本 {item.ref.version} · 快照 {item.snapshotRevision}</h4><p>{item.deleted?'已删除（墓碑）':'保存的对象内容'} · 前一版本 {item.parentVersion??'无'}</p><small>采用变更 {item.changeId??'初始快照'}</small>{item.value!==null&&<pre>{JSON.stringify(formalVisibleValue(item.value),null,2)}</pre>}</article>)}{props.history.nextCursor&&<button type="button" disabled={busy} onClick={props.onHistoryMore}>更多历史（每页最多 50 条）</button>}</aside>}
  </section>;
}
