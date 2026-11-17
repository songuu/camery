import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SourcePage, SourceSummary } from '@camery/ingest/contracts';
import { ApiClient, ApiError } from './api.js';
import { createSessionStore } from './session.js';
import { appendPreparedNovel, prepareSourceFile, UploadError } from './uploads.js';
import { ImportWorkbench } from './ImportWorkbench.js';
import { BiblePane } from './BiblePane.js';
import { DevelopmentPane } from './DevelopmentPane.js';
import type { UploadFormat } from './view-types.js';

const session = createSessionStore();
type WorkbenchTab='sources'|'bible'|'development';
function messageFor(error: unknown): string {
  const code = error instanceof ApiError || error instanceof UploadError ? error.code : 'UNKNOWN';
  return ({ INVALID_CREDENTIAL: '访问凭证格式不正确。', UNAUTHENTICATED: '连接已失效，请重新连接工作区。', FORBIDDEN: '当前账号没有此操作的项目权限。',
    NOT_FOUND: '来源不存在，或来源功能尚未开启。', CONFLICT: '来源或进度已变化，请刷新后重试。', INPUT_LIMIT: '文件或结构超过支持上限，请分批导入或缩小文件。',
    MALFORMED_DOCUMENT: '文件结构损坏或无法识别，原文件未改动。', INVALID_ENCODING: '请使用有效的 UTF-8 文本文件。', INVALID_TEXT: '文本包含无效字符。',
    INVALID_FILE: '文件为空、名称过长或格式不受支持。', READ_FAILED: '无法读取文件，请重新选择。', HASH_FAILED: '无法校验文件，请使用 HTTPS 或本机地址。',
    NETWORK_FAILED: '连接中断，请重试；相同文件的已完成批次不会重复追加。', TIMEOUT: '请求超时，可重试；相同文件的已完成批次不会重复追加。', UPLOAD_FAILED: '导入未完成，可重新选择同一文件继续。', STORAGE_FAILED: '来源存储暂不可用，请稍后重试。',
    BAD_RESPONSE: '服务返回了无法识别的结果，请检查服务版本。', UNSUPPORTED_FORMAT: '当前文件格式或 Word 内容暂不支持。' } as Record<string,string>)[code] ?? '操作未完成，请重试。';
}

export function App() {
  const state = useStore(session); const cache = useQueryClient();
  const [projectId,setProject] = useState(''); const [format,setFormat] = useState<UploadFormat>('novel');
  const scope=`${state.generation}:${projectId}`;
  const [navigation,setNavigation]=useState<{scope:string;tab:WorkbenchTab;visited:readonly WorkbenchTab[]}>({scope:'',tab:'sources',visited:[]});
  // Scope is checked during render, before any child can schedule a request for a new identity/project.
  const tab=navigation.scope===scope?navigation.tab:'sources';
  const hasVisited=(pane:WorkbenchTab)=>tab===pane||navigation.scope===scope&&navigation.visited.includes(pane);
  const setTab=(next:WorkbenchTab)=>setNavigation(current=>{
    const visited=current.scope===scope?current.visited:[];
    return {scope,tab:next,visited:next==='sources'||visited.includes(next)?visited:[...visited,next]};
  });
  const resetNavigation=()=>setNavigation({scope:'',tab:'sources',visited:[]});
  const [selected,setSelected] = useState<SourceSummary|null>(null); const [offset,setOffset] = useState<number|undefined>();
  const [before,setBefore] = useState<number|undefined>();
  const [busy,setBusy] = useState<string|null>(null); const [progress,setProgress] = useState<number|null>(null);
  const [error,setError] = useState<string|null>(null); const [message,setMessage] = useState<string|null>(null);
  const operation = useRef(0);
  const alive = useRef({ generation: state.generation, projectId }); alive.current = { generation: state.generation, projectId };
  const permission = useQuery({ queryKey:['permission',state.generation,projectId], enabled:!!state.client && !!projectId,
    queryFn:({signal})=>state.client!.access(projectId,signal), retry:false });
  const sources = useInfiniteQuery({ queryKey:['sources',state.generation,projectId], enabled:!!state.client && !!projectId, initialPageParam:undefined as string|undefined,
    queryFn:({signal,pageParam})=>state.client!.list(projectId,pageParam,signal), getNextPageParam:last=>last.nextCursor??undefined, retry:false });
  const reading = useQuery({ queryKey:['source',state.generation,projectId,selected?.kind,selected?.documentId,offset,before], enabled:!!state.client && !!projectId && !!selected,
    queryFn:({signal})=>state.client!.read(projectId,selected!.kind,selected!.documentId,offset,signal,before), retry:false });
  const page = reading.data ?? null;
  const canImport = permission.data?.permissions.includes('candidate:write') ?? false;

  const clear = () => {
    operation.current++; session.getState().reset(); void cache.cancelQueries(); cache.clear();
    resetNavigation();
    setProject(''); setSelected(null); setOffset(undefined); setBefore(undefined); setBusy(null); setProgress(null); setMessage(null); setError(null);
  };
  const failure = (problem: unknown) => {
    if (problem instanceof ApiError && problem.code === 'CANCELLED' || problem instanceof UploadError && problem.code === 'CANCELLED') return;
    if (problem instanceof ApiError && problem.code === 'UNAUTHENTICATED') clear();
    if (problem instanceof ApiError && problem.code === 'FORBIDDEN') {
      operation.current++; resetNavigation();setProject(''); setSelected(null); setBusy(null); setProgress(null); setMessage(null);
      void cache.cancelQueries(); cache.clear();
    }
    setError(messageFor(problem));
  };
  useEffect(() => {
    if (session.getState().generation !== state.generation || alive.current.projectId !== projectId) return;
    const problem = permission.error ?? sources.error ?? reading.error; if (problem) failure(problem);
  },[permission.error,sources.error,reading.error,state.generation,projectId]);

  const connect = async (token: string) => {
    clear(); const generation = session.getState().generation; setBusy('正在连接工作区');
    try {
      const client = new ApiClient(token.trim()); const identity = await client.me();
      if (session.getState().connected(generation,client,identity)) { setProject(identity.grants[0]?.projectId ?? ''); if (!identity.grants.length) setMessage('此账号尚未加入项目，请联系项目管理员。'); }
    } catch (problem) { if (session.getState().generation === generation) failure(problem); }
    finally { if (session.getState().generation === generation) setBusy(null); }
  };
  const disconnect = async () => {
    const client = state.client; clear(); const generation = session.getState().generation;
    try { await client?.signOut(); } catch { if (session.getState().generation === generation) setError('本机已断开，服务端退出确认失败。'); }
  };
  const chooseProject = (id: string) => {
    resetNavigation();
    operation.current++; setProject(id); setSelected(null); setOffset(undefined); setBefore(undefined); setError(null); setMessage(null); setBusy(null); setProgress(null);
  };
  const chooseSource = (source: SourceSummary) => { operation.current++; setSelected(source); setOffset(undefined); setBefore(undefined); setError(null); setMessage(null); };
  const read = (target: number) => {
    if (!page) return;
    setBefore(undefined); setOffset(target);
    setError(null); setMessage(null);
  };
  const previous = () => { if (page && page.excerpt.start>0) { setBefore(page.excerpt.start); setOffset(undefined); setError(null); setMessage(null); } };
  const upload = async (file: File, append: boolean) => {
    if (!state.client || !projectId || !canImport) return;
    const client = state.client; const generation = state.generation; const project = projectId; const job = ++operation.current;
    const active = () => session.getState().generation === generation && alive.current.projectId === project && operation.current === job;
    let apiProblem: unknown;
    setBusy('正在校验来源'); setProgress(0); setError(null); setMessage(null);
    try {
      const prepared = await prepareSourceFile(file,format); if (!active()) return;
      const existing = append && prepared.format === 'novel' && page?.kind === 'novel' ? page : null;
      // A stable file identity also survives a browser reload; reselecting the same file resumes existing batches.
      const documentId = existing?.documentId ?? `source-${prepared.format}-${prepared.digest}`;
      setBusy('正在导入来源');
      let result: SourceSummary;
      if (prepared.format === 'novel') {
        result = await appendPreparedNovel(prepared,existing?.revision??0,async input => {
          try { return await client.append(project,documentId,input); } catch (problem) { apiProblem=problem; throw problem; }
        },value=>{if(active())setProgress(value);},active,!existing);
      } else result = await client.script(project,documentId,prepared.format,prepared.title,prepared.bytes);
      if (!active()) return;
      setSelected(result); setOffset(0); setBefore(undefined); setMessage('来源已保存。识别结果是候选，尚未采用到剧本。');
      await cache.invalidateQueries({ queryKey:['sources',generation,project] });
      await cache.invalidateQueries({ queryKey:['source',generation,project,result.kind,result.documentId] });
    } catch (problem) { if (active()) failure(apiProblem??problem); }
    finally { if (active()) { setBusy(null); setProgress(null); } }
  };
  const save = async (current: SourcePage|null) => {
    if (!state.client || !current || current.kind !== 'novel') return;
    if (current.excerpt.end <= (current.checkpoint?.offset??-1)) { setMessage('这一段已标记为读过。'); return; }
    const generation=state.generation; const project=projectId; const job=++operation.current;
    const active=()=>session.getState().generation===generation && alive.current.projectId===project && operation.current===job;
    setBusy('正在保存阅读位置'); setError(null); setMessage(null);
    try {
      await state.client.checkpoint(project,current.documentId,{sourceDigest:current.sourceDigest,offset:current.excerpt.end,expectedVersion:current.checkpoint?.version??0});
      if (active()) { setMessage('阅读位置已保存，下次可以从这里继续。'); await cache.invalidateQueries({queryKey:['source',generation,project,current.kind,current.documentId]}); }
    } catch (problem) { if(active())failure(problem); }
    finally { if(active())setBusy(null); }
  };
  return <>{state.client&&<nav aria-label="工作台" style={{display:'flex',gap:12,padding:'12px 24px',flexWrap:'wrap'}}>
    <button type="button" aria-pressed={tab==='sources'} onClick={()=>setTab('sources')}>来源与阅读</button>
    <button type="button" aria-pressed={tab==='bible'} onClick={()=>setTab('bible')}>知识提取与审阅</button>
    <button type="button" aria-pressed={tab==='development'} onClick={()=>setTab('development')}>原创开发</button>
    {tab!=='sources'&&<button type="button" onClick={()=>{void disconnect();}}>断开工作区</button>}
  </nav>}<div style={{display:tab==='sources'||!state.client?'block':'none'}}><ImportWorkbench key={`${state.generation}:${projectId}`} connected={!!state.client} projectId={projectId}
    projects={(state.identity?.grants??[]).map(grant=>({id:grant.projectId,canImport:grant.projectId===projectId && canImport}))}
    sources={sources.data ? {items:sources.data.pages.flatMap(part=>part.items),nextCursor:sources.data.pages.at(-1)?.nextCursor??null}:null}
    page={page} format={format} busy={busy??(reading.isFetching?'正在读取来源':sources.isFetching?'正在读取来源列表':null)} progress={progress}
    error={error} message={message} canImport={canImport} onConnect={token=>{void connect(token);}} onDisconnect={()=>{void disconnect();}}
    onProject={chooseProject} onFormat={setFormat} onFile={(file,append)=>{void upload(file,append);}} onOpen={chooseSource} onRead={read}
    onPrevious={previous} onCheckpoint={()=>{void save(page);}} onMore={()=>{void sources.fetchNextPage();}}/></div>
    {state.client&&projectId&&hasVisited('bible')&&<div style={{display:tab==='bible'?'block':'none'}}><BiblePane key={`${state.generation}:${projectId}`} client={state.client} generation={state.generation} projectId={projectId}
      permissions={permission.data?.permissions??[]} startSource={page} onFailure={failure}/></div>}
    {state.client&&projectId&&hasVisited('development')&&<div style={{display:tab==='development'?'block':'none'}}><DevelopmentPane key={`${state.generation}:${projectId}`} client={state.client} generation={state.generation} projectId={projectId} permissions={permission.data?.permissions??[]} onFailure={failure}/></div>}</>;
}
