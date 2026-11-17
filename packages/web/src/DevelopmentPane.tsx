import {useEffect,useRef,useState} from 'react';
import {useInfiniteQuery,useQuery,useQueryClient} from '@tanstack/react-query';
import type {DevelopmentBriefView,DevelopmentBriefWrite,DevelopmentStart,DevelopmentFoundationConfirm,DevelopmentEpisodesConfirm,DevelopmentRedo} from '@camery/script/http';
import {ApiClient,ApiError} from './api.js';
import {DevelopmentWorkbench,type BriefFields} from './DevelopmentWorkbench.js';
import {developmentRedoKey,developmentRedoRequest} from './development-review-state.js';
interface Props {client:ApiClient;generation:number;projectId:string;permissions:readonly string[];onFailure:(error:unknown)=>void}
/** A keyed session/project lifetime keeps credentials and drafts in memory and ignores late mutation acknowledgements. */
export function DevelopmentPane({client,generation,projectId,permissions,onFailure}:Props){
  const cache=useQueryClient();const prefix=['development',generation,projectId] as const;
  const [runId,setRunId]=useState<string|null>(null);const [savedBrief,setSavedBrief]=useState<DevelopmentBriefView|null>(null);const [composeVersion,setComposeVersion]=useState(0);
  const [busy,setBusy]=useState<string|null>(null);const [error,setError]=useState<string|null>(null);const [message,setMessage]=useState<string|null>(null);
  const mounted=useRef(true);const operation=useRef(0);const draftId=useRef<string|null>(null);const pendingSave=useRef<DevelopmentBriefWrite|null>(null);const pendingStarts=useRef(new Map<string,DevelopmentStart>());const pendingRedos=useRef(new Map<string,DevelopmentRedo>());
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;operation.current++;};},[]);
  const capabilities=useQuery({queryKey:[...prefix,'capabilities'],queryFn:({signal})=>client.developmentCapabilities(projectId,signal),retry:false});
  const briefs=useInfiniteQuery({queryKey:[...prefix,'briefs'],initialPageParam:undefined as string|undefined,queryFn:({signal,pageParam})=>client.developmentBriefList(projectId,pageParam,signal),getNextPageParam:page=>page.nextCursor??undefined,retry:false});
  const runs=useInfiniteQuery({queryKey:[...prefix,'runs'],initialPageParam:undefined as string|undefined,queryFn:({signal,pageParam})=>client.developmentList(projectId,pageParam,signal),getNextPageParam:page=>page.nextCursor??undefined,retry:false});
  const status=useQuery({queryKey:[...prefix,'status',runId],enabled:!!runId,queryFn:({signal})=>client.developmentStatus(projectId,runId!,signal),retry:false,
    refetchInterval:query=>query.state.data&&['queued','running','waiting'].includes(query.state.data.state)?2000:false});
  const detail=useQuery({queryKey:[...prefix,'detail',runId],enabled:!!runId,queryFn:({signal})=>client.developmentRead(projectId,runId!,signal),retry:false});
  const redo=useQuery({queryKey:[...prefix,'redo',runId],enabled:!!runId,queryFn:({signal})=>client.developmentRedoOptions(projectId,runId!,signal),retry:false});
  const eligibility=status.data?JSON.stringify([status.data.runId,status.data.state,status.data.sourceChanged,status.data.foundationCandidateDigest,status.data.foundationReviewStatus,status.data.episodesCandidateDigest,status.data.episodesReviewStatus]):null;
  useEffect(()=>{if(runId&&eligibility)void cache.invalidateQueries({queryKey:[...prefix,'redo',runId]});},[runId,eligibility]);
  useEffect(()=>{
    const current=status.data;const stored=detail.data;if(!runId||!current||!stored||current.runId!==runId||stored.runId!==runId)return;
    if(['foundationCandidateDigest','foundationReviewStatus','episodesCandidateDigest','episodesReviewStatus','sourceChanged','state'].some(field=>current[field as keyof typeof current]!==stored[field as keyof typeof stored]))void cache.invalidateQueries({queryKey:[...prefix,'detail',runId]});
  },[runId,status.data,detail.data]);
  function failure(problem:unknown){
    if(!mounted.current||problem instanceof ApiError&&problem.code==='CANCELLED')return;
    if(problem instanceof ApiError&&['UNAUTHENTICATED','FORBIDDEN'].includes(problem.code)){onFailure(problem);return;}
    setError(problem instanceof ApiError&&problem.code==='NOT_FOUND'?'原创开发尚未开启，或这份记录不存在。':problem instanceof ApiError&&problem.code==='CONFLICT'?'创意或审阅已变化，请刷新后载入最新创意核对。':problem instanceof ApiError&&problem.code==='INVALID_REQUEST'?'内容不符合要求，请检查必填项、数量与引用。':'请求未确认，请刷新记录核对，或以相同内容重试。已有保存和运行会保留。');
  }
  useEffect(()=>{const problem=capabilities.error??briefs.error??runs.error??status.error??detail.error??redo.error;if(problem)failure(problem);},[capabilities.error,briefs.error,runs.error,status.error,detail.error,redo.error]);
  const active=(nonce:number)=>mounted.current&&operation.current===nonce;
  async function refresh(){setError(null);await cache.invalidateQueries({queryKey:prefix});}
  function openRun(id:string){operation.current++;setRunId(id);setBusy(null);setError(null);setMessage(null);}
  function newBrief(){operation.current++;pendingSave.current=null;draftId.current=null;setSavedBrief(null);setRunId(null);setComposeVersion(value=>value+1);setError(null);setMessage(null);setBusy(null);}
  async function openBrief(id:string){
    const nonce=++operation.current;setBusy('正在恢复创意');setError(null);setMessage(null);
    try{const result=await client.developmentBrief(projectId,id);if(!active(nonce))return;pendingSave.current=null;draftId.current=null;setSavedBrief(result);setComposeVersion(value=>value+1);setMessage('已载入最新保存的创意。修改后保存新修订，再明确开始开发。');}
    catch(problem){if(active(nonce))failure(problem);}finally{if(active(nonce))setBusy(null);}
  }
  async function save(fields:BriefFields){
    if(busy||!permissions.includes('task:run'))return;
    const command:DevelopmentBriefWrite={...fields,briefId:savedBrief?.brief.briefId??(draftId.current??=`idea-${crypto.randomUUID()}`),expectedRevision:savedBrief?.brief.revision??0};
    if(pendingSave.current&&JSON.stringify(pendingSave.current)!==JSON.stringify(command)){setError('上次保存结果尚未确认。请先以原内容重试，或刷新并载入已保存创意，再修改。');return;}
    pendingSave.current=command;const nonce=++operation.current;setBusy('正在保存创意');setError(null);setMessage(null);
    try{const result=await client.developmentPutBrief(projectId,command);if(!active(nonce))return;pendingSave.current=null;draftId.current=null;setSavedBrief(result);setMessage('创意已保存。点击“开始新的两阶段开发”才会使用模型。');await cache.invalidateQueries({queryKey:prefix});}
    catch(problem){if(active(nonce))failure(problem);}finally{if(active(nonce))setBusy(null);}
  }
  async function start(){
    if(busy||!savedBrief||!capabilities.data?.canStart||!permissions.includes('task:run'))return;
    const brief=savedBrief.brief;let command=pendingStarts.current.get(brief.digest);
    if(!command){command={runId:`development-${crypto.randomUUID()}`,briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest};pendingStarts.current.set(brief.digest,command);}
    const nonce=++operation.current;setBusy('正在开始两阶段开发');setError(null);setMessage(null);
    try{const result=await client.developmentStart(projectId,command);if(!active(nonce))return;pendingStarts.current.delete(brief.digest);setRunId(result.runId);setMessage('开发已开始。先审阅设定，再继续生成分集；可离开页面后恢复。');await cache.invalidateQueries({queryKey:prefix});}
    catch(problem){if(active(nonce))failure(problem);}finally{if(active(nonce))setBusy(null);}
  }
  async function review(stage:'foundation'|'episodes',decision:DevelopmentFoundationConfirm|DevelopmentEpisodesConfirm|string){
    if(!runId||busy||!permissions.includes('candidate:review')||stage==='foundation'&&detail.data?.origin?.foundation)return;
    const selected=runId;const nonce=++operation.current;setBusy(typeof decision==='string'?'正在保存拒绝决定':'正在保存阶段审阅');setError(null);setMessage(null);
    try{const result=typeof decision==='string'?await client.developmentReject(projectId,selected,stage,decision):await client.developmentConfirm(projectId,selected,stage,decision);if(!active(nonce))return;
      cache.setQueryData([...prefix,'detail',selected],result);setMessage(typeof decision==='string'?'拒绝决定已保存。':stage==='foundation'?'设定审阅已保存，分集生成已解锁。':'分集审阅已保存，尚未采用到正式剧本。');await cache.invalidateQueries({queryKey:prefix});
    }catch(problem){if(active(nonce)){failure(problem);await cache.invalidateQueries({queryKey:prefix});}}finally{if(active(nonce))setBusy(null);}
  }
  async function redoStage(stage:'foundation'|'episodes'){
    const source=detail.data;if(!source||source.runId!==runId||busy||!permissions.includes('task:run'))return;
    const key=developmentRedoKey(source,stage);const stages=['foundation','episodes'] as const;
    if(!pendingRedos.current.has(key)){
      const options=redo.data;
      if(stages.some(other=>pendingRedos.current.has(developmentRedoKey(source,other)))||!options||options.runId!==source.runId||options.runDigest!==source.runDigest||options.briefDigest!==source.brief.digest||!options[stage].canRedo||!options[stage].budget)return;
    }
    const request=developmentRedoRequest(pendingRedos.current,source,stage,()=>`development-${crypto.randomUUID()}`);if(!request)return;
    const nonce=++operation.current;setBusy(stage==='foundation'?'正在创建新的设定与分集分支':'正在创建新的分集分支');setError(null);setMessage(null);
    try{const result=await client.developmentRedo(projectId,source.runId,stage,request.command);if(!active(nonce))return;
      pendingRedos.current.delete(request.key);cache.setQueryData([...prefix,'detail',result.runId],result);setRunId(result.runId);setMessage(stage==='foundation'?'新分支已开始重新开发设定与分集，旧记录仍保留。':'新分支已开始生成分集，沿用设定与原审阅记录；新分集仍需审阅。');await cache.invalidateQueries({queryKey:prefix});
    }catch(problem){if(active(nonce)){failure(problem);await cache.invalidateQueries({queryKey:prefix});}}finally{if(active(nonce))setBusy(null);}
  }
  const pendingRedoStages=detail.data?(['foundation','episodes'] as const).filter(stage=>pendingRedos.current.has(developmentRedoKey(detail.data!,stage))):[];
  return <DevelopmentWorkbench capabilities={capabilities.data??null} briefs={briefs.data?{items:briefs.data.pages.flatMap(page=>page.items),nextCursor:briefs.data.pages.at(-1)?.nextCursor??null}:null}
    runs={runs.data?{items:runs.data.pages.flatMap(page=>page.items),nextCursor:runs.data.pages.at(-1)?.nextCursor??null}:null} savedBrief={savedBrief} composeVersion={composeVersion}
    detail={detail.data??null} status={status.data??null} canEdit={permissions.includes('task:run')} canReview={permissions.includes('candidate:review')} busy={busy??(detail.isFetching&&runId?'正在恢复开发记录':null)} error={error} message={message}
    redoOptions={redo.data??null} pendingRedoStages={pendingRedoStages} onRedo={stage=>{void redoStage(stage);}}
    onSave={fields=>{void save(fields);}} onStart={()=>{void start();}} onNew={newBrief} onOpenBrief={id=>{void openBrief(id);}} onOpenRun={openRun} onMoreBriefs={()=>{void briefs.fetchNextPage();}} onMoreRuns={()=>{void runs.fetchNextPage();}} onRefresh={()=>{void refresh();}}
    onConfirm={(stage,decision)=>{void review(stage,decision);}} onReject={(stage,reason)=>{void review(stage,reason);}}/>;
}
