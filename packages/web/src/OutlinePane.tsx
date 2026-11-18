import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {useInfiniteQuery,useQuery,useQueryClient} from '@tanstack/react-query';
import type {OutlineBriefView,OutlineBriefWrite,OutlineSourceSelection,OutlineStart,OutlineConfirm} from '@camery/script/outline/http';
import {ApiClient,ApiError} from './api.js';
import type {Identity} from './api.js';
import {OutlineWorkbench,type OutlineBriefFields} from './OutlineWorkbench.js';
import {FormalProjectBoundary} from './FormalProjectBoundary.js';
const OutlineAdoptionPane=lazy(async()=>({default:(await import('./OutlineAdoptionPane.js')).OutlineAdoptionPane}));
interface Props{client:ApiClient;generation:number;projectId:string;permissions:readonly string[];onFailure:(error:unknown)=>void;identity?:Identity}
/** The parent keys identity/project lifetimes; operation fences additionally isolate record switches and late ACKs. */
export function OutlinePane({client,generation,projectId,permissions,onFailure,identity}:Props){
  const cache=useQueryClient(),prefix=['outline',generation,projectId] as const;
  const [runId,setRunId]=useState<string|null>(null),[savedBrief,setSavedBrief]=useState<OutlineBriefView|null>(null),[composeVersion,setComposeVersion]=useState(0);
  const [kind,setKind]=useState<'development'|'bible'>('development'),[selection,setSelection]=useState<OutlineSourceSelection|null>(null);
  const [busy,setBusy]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null);
  const [adoptionOpen,setAdoptionOpen]=useState(true);
  const mounted=useRef(true),operation=useRef(0),draftId=useRef<string|null>(null),pendingSave=useRef<OutlineBriefWrite|null>(null),pendingStart=useRef<OutlineStart|null>(null);
  const pendingReviews=useRef(new Map<string,OutlineConfirm|string>());
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;operation.current++;};},[]);
  const capabilities=useQuery({queryKey:[...prefix,'capabilities'],queryFn:({signal})=>client.outlineCapabilities(projectId,signal),retry:false});
  const briefs=useInfiniteQuery({queryKey:[...prefix,'briefs'],initialPageParam:undefined as string|undefined,queryFn:({signal,pageParam})=>client.outlineBriefList(projectId,pageParam,signal),getNextPageParam:page=>page.nextCursor??undefined,retry:false});
  const runs=useInfiniteQuery({queryKey:[...prefix,'runs'],initialPageParam:undefined as string|undefined,queryFn:({signal,pageParam})=>client.outlineList(projectId,pageParam,signal),getNextPageParam:page=>page.nextCursor??undefined,retry:false});
  const sources=useInfiniteQuery({queryKey:[...prefix,'sources',kind],initialPageParam:undefined as string|undefined,queryFn:({signal,pageParam})=>client.outlineSources(projectId,kind,pageParam,signal),getNextPageParam:page=>page.nextCursor??undefined,retry:false});
  const status=useQuery({queryKey:[...prefix,'status',runId],enabled:!!runId,queryFn:({signal})=>client.outlineStatus(projectId,runId!,signal),retry:false,refetchInterval:query=>query.state.data&&['queued','running','waiting'].includes(query.state.data.state)?2000:false});
  const detail=useQuery({queryKey:[...prefix,'detail',runId],enabled:!!runId,queryFn:({signal})=>client.outlineRead(projectId,runId!,signal),retry:false});
  useEffect(()=>{const current=status.data,stored=detail.data;if(current&&stored&&current.runId===runId&&stored.runId===runId&&(['candidateDigest','reviewStatus','sourceChanged','state'] as const).some(field=>current[field]!==stored[field]))void cache.invalidateQueries({queryKey:[...prefix,'detail',runId]});},[status.data,detail.data,runId]);
  function failure(problem:unknown){
    if(!mounted.current||problem instanceof ApiError&&problem.code==='CANCELLED')return;
    if(problem instanceof ApiError&&['UNAUTHENTICATED','FORBIDDEN'].includes(problem.code)){onFailure(problem);return;}
    setError(problem instanceof ApiError&&problem.code==='NOT_FOUND'?'大纲服务尚未开启，或这份记录不存在。':problem instanceof ApiError&&problem.code==='CONFLICT'?'来源、简报或审阅已变化，请刷新后核对最新记录。':problem instanceof ApiError&&problem.code==='INVALID_REQUEST'?'内容不符合要求，请核对必填项、容量与引用。':'请求未确认。请刷新记录核对，或用相同内容重试；已有运行和保存内容会保留。');
  }
  useEffect(()=>{const problem=capabilities.error??briefs.error??runs.error??sources.error??status.error??detail.error;if(problem)failure(problem);},[capabilities.error,briefs.error,runs.error,sources.error,status.error,detail.error]);
  const active=(nonce:number)=>mounted.current&&operation.current===nonce;
  async function refresh(){setError(null);await cache.invalidateQueries({queryKey:prefix});}
  function openRun(id:string){operation.current++;setRunId(id);setBusy(null);setError(null);setMessage(null);}
  function newBrief(){operation.current++;pendingSave.current=null;draftId.current=null;setSavedBrief(null);setRunId(null);setComposeVersion(value=>value+1);setBusy(null);setError(null);setMessage(null);}
  async function openBrief(id:string){const nonce=++operation.current;setBusy('正在恢复简报');setError(null);try{const value=await client.outlineBrief(projectId,id);if(!active(nonce))return;pendingSave.current=null;draftId.current=null;setSavedBrief(value);setComposeVersion(v=>v+1);setMessage('已载入最新简报。保存修改后再明确开始生成。');}catch(problem){if(active(nonce))failure(problem);}finally{if(active(nonce))setBusy(null);}}
  async function save(fields:OutlineBriefFields){
    if(busy||!permissions.includes('task:run'))return;
    const command:OutlineBriefWrite={...fields,briefId:savedBrief?.brief.briefId??(draftId.current??=`outline-brief-${crypto.randomUUID()}`),expectedRevision:savedBrief?.brief.revision??0};
    if(pendingSave.current&&JSON.stringify(pendingSave.current)!==JSON.stringify(command)){setError('上次保存尚未确认。请先以原内容重试，或载入已保存简报后再修改。');return;}
    pendingSave.current=command;const nonce=++operation.current;setBusy('正在保存简报');setError(null);
    try{const value=await client.outlineSaveBrief(projectId,command);if(!active(nonce))return;pendingSave.current=null;draftId.current=null;setSavedBrief(value);setComposeVersion(v=>v+1);setMessage('简报已保存，尚未调用模型。');await cache.invalidateQueries({queryKey:prefix});}catch(problem){if(active(nonce))failure(problem);}finally{if(active(nonce))setBusy(null);}
  }
  async function start(){
    if(busy||!permissions.includes('task:run'))return;
    if(!pendingStart.current){if(!savedBrief||!selection||!capabilities.data?.canStart)return;const brief=savedBrief.brief;pendingStart.current={runId:`outline-${crypto.randomUUID()}`,briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest,source:structuredClone(selection)};}
    const command=pendingStart.current,nonce=++operation.current;setBusy('正在开始大纲生成');setError(null);
    try{const value=await client.outlineStart(projectId,command);if(!active(nonce))return;pendingStart.current=null;setRunId(value.runId);setMessage('大纲已开始生成，可稍后恢复；候选仍需你明确审阅。');await cache.invalidateQueries({queryKey:prefix});}catch(problem){if(active(nonce)){
      // A 409 can follow a committed run too. Only a successful read or an authoritative 404 resolves that uncertainty.
      if(problem instanceof ApiError&&problem.code==='CONFLICT')try{const original=await client.outlineRead(projectId,command.runId);if(active(nonce)){pendingStart.current=null;setRunId(original.runId);setMessage('原运行已存在，请核对记录后继续。');}}catch(check){if(active(nonce)&&check instanceof ApiError&&check.code==='NOT_FOUND')pendingStart.current=null;}
      failure(problem);
    }}finally{if(active(nonce))setBusy(null);}
  }
  async function review(decision:OutlineConfirm|string){
    const view=detail.data;if(!view||view.runId!==runId||busy||!permissions.includes('candidate:review'))return;
    const key=`${view.runId}:${view.candidateDigest}`,old=pendingReviews.current.get(key);
    if(old!==undefined&&JSON.stringify(old)!==JSON.stringify(decision)){setError('上次审阅尚未确认。请先以原内容重试，或刷新核对已保存的人审。');return;}
    pendingReviews.current.set(key,structuredClone(decision));const selected=view.runId,nonce=++operation.current;setBusy('正在保存人审');setError(null);
    try{const value=typeof decision==='string'?await client.outlineReject(projectId,selected,decision):await client.outlineConfirm(projectId,selected,decision);if(!active(nonce))return;pendingReviews.current.delete(key);cache.setQueryData([...prefix,'detail',selected],value);setMessage('人审已保存，尚未采用到正式剧本。');await cache.invalidateQueries({queryKey:prefix});}catch(problem){if(active(nonce)){failure(problem);await cache.invalidateQueries({queryKey:prefix});}}finally{if(active(nonce))setBusy(null);}
  }
  return <OutlineWorkbench capabilities={capabilities.data??null} briefs={briefs.data?{items:briefs.data.pages.flatMap(p=>p.items),nextCursor:briefs.data.pages.at(-1)?.nextCursor??null}:null} runs={runs.data?{items:runs.data.pages.flatMap(p=>p.items),nextCursor:runs.data.pages.at(-1)?.nextCursor??null}:null} sources={sources.data?{items:sources.data.pages.flatMap(p=>p.items),nextCursor:sources.data.pages.at(-1)?.nextCursor??null}:null}
    kind={kind} selection={selection} savedBrief={savedBrief} composeVersion={composeVersion} detail={detail.data??null} status={status.data??null} canEdit={permissions.includes('task:run')} canReview={permissions.includes('candidate:review')} busy={busy??(detail.isFetching&&runId?'正在恢复大纲记录':null)} error={error} message={message} pendingStart={pendingStart.current?.runId??null}
    formal={capabilities.data?.formalAdoption&&identity?(adoptionOpen?<FormalProjectBoundary onClose={()=>setAdoptionOpen(false)}><Suspense fallback={<p role="status">正在打开正式采用…</p>}><OutlineAdoptionPane client={client} generation={generation} projectId={projectId} identity={identity} run={detail.data?.runId===runId?detail.data:null} permissions={permissions} onFailure={onFailure} onOpenRun={openRun}/></Suspense></FormalProjectBoundary>:<button type="button" onClick={()=>setAdoptionOpen(true)}>重新打开正式采用</button>):null}
    onKind={value=>{setKind(value);setSelection(null);}} onSource={setSelection} onSave={fields=>{void save(fields);}} onStart={()=>{void start();}} onNew={newBrief} onOpenBrief={id=>{void openBrief(id);}} onOpenRun={openRun} onMoreBriefs={()=>{void briefs.fetchNextPage();}} onMoreRuns={()=>{void runs.fetchNextPage();}} onMoreSources={()=>{void sources.fetchNextPage();}} onRefresh={()=>{void refresh();}} onConfirm={decision=>{void review(decision);}} onReject={reason=>{void review(reason);}}/>;
}
