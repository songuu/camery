import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SourcePage } from '@camery/ingest/contracts';
import type { BibleConfirm, BibleEvidence } from '@camery/bible/http';
import { BibleWorkbench } from './BibleWorkbench.js';
import { ApiClient, ApiError } from './api.js';

interface Props {client:ApiClient;generation:number;projectId:string;permissions:readonly string[];startSource:SourcePage|null;onFailure:(error:unknown)=>void}
/** Credentials stay in the parent session; a project/generation key destroys all drafts and late operation handles. */
export function BiblePane({client,generation,projectId,permissions,startSource,onFailure}:Props){
  const cache=useQueryClient();const [runId,setRunId]=useState<string|null>(null);
  const [offset,setOffset]=useState<number|null>(null);const [evidence,setEvidence]=useState<BibleEvidence|null>(null);
  const [direction,setDirection]=useState<'before'|undefined>();
  const [busy,setBusy]=useState<string|null>(null);const [error,setError]=useState<string|null>(null);const [message,setMessage]=useState<string|null>(null);
  const operation=useRef(0);const mounted=useRef(true);const startIdentity=useRef<{source:string;runId:string}|null>(null);
  const prefix=['bible',generation,projectId] as const;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;operation.current++;};},[]);
  const caps=useQuery({queryKey:[...prefix,'capabilities'],enabled:!!projectId,queryFn:({signal})=>client.bibleCapabilities(projectId,signal),retry:false});
  const runs=useInfiniteQuery({queryKey:[...prefix,'runs'],enabled:!!projectId,initialPageParam:undefined as string|undefined,
    queryFn:({signal,pageParam})=>client.bibleList(projectId,pageParam,signal),getNextPageParam:page=>page.nextCursor??undefined,retry:false});
  const status=useQuery({queryKey:[...prefix,'status',runId],enabled:!!runId,queryFn:({signal})=>client.bibleStatus(projectId,runId!,signal),retry:false,
    refetchInterval:query=>query.state.data&&['queued','running','waiting'].includes(query.state.data.state)?2000:false});
  const detail=useQuery({queryKey:[...prefix,'detail',runId],enabled:!!runId,
    queryFn:({signal})=>client.bibleRead(projectId,runId!,signal),retry:false});
  useEffect(()=>{
    if(!runId||!status.data||!detail.data||status.data.runId!==runId||detail.data.runId!==runId)return;
    if(status.data.candidateDigest!==detail.data.candidateDigest||status.data.reviewStatus!==detail.data.reviewStatus)
      void cache.invalidateQueries({queryKey:[...prefix,'detail',runId]});
  },[runId,status.data?.candidateDigest,status.data?.reviewStatus,detail.data?.candidateDigest,detail.data?.reviewStatus]);
  const source=useQuery({queryKey:[...prefix,'source',runId,offset,direction],enabled:!!runId&&offset!==null,
    queryFn:({signal})=>client.bibleSource(projectId,runId!,offset!,signal,direction),retry:false});
  function failure(problem:unknown){
    if(!mounted.current)return;
    if(problem instanceof ApiError&&problem.code==='CANCELLED')return;
    if(problem instanceof ApiError&&['UNAUTHENTICATED','FORBIDDEN'].includes(problem.code)){onFailure(problem);return;}
    setError(problem instanceof ApiError&&problem.code==='NOT_FOUND'?'此工作区尚未开启知识提取，或记录不存在。':problem instanceof ApiError&&problem.code==='CONFLICT'?'来源或审阅记录已变化，请刷新后核对。':'操作未完成，请刷新或重试；已有运行会保留。');
  }
  useEffect(()=>{const problem=caps.error??runs.error??status.error??detail.error??source.error;if(problem)failure(problem);},[caps.error,runs.error,status.error,detail.error,source.error]);
  function open(id:string){operation.current++;setRunId(id);setOffset(null);setEvidence(null);setBusy(null);setMessage(null);setError(null);}
  async function refresh(){setError(null);await cache.invalidateQueries({queryKey:prefix});}
  async function start(){
    if(!startSource||!caps.data?.canStart||!permissions.includes('task:run')||busy)return;
    const sourceKey=`${startSource.kind}:${startSource.documentId}:${startSource.revision}:${startSource.sourceDigest}`;
    if(startIdentity.current?.source!==sourceKey)startIdentity.current={source:sourceKey,runId:`run-${crypto.randomUUID()}`};
    const nonce=++operation.current;setBusy('正在提交提取');setError(null);setMessage(null);
    try{
      const result=await client.bibleStart(projectId,{runId:startIdentity.current.runId,documentId:startSource.documentId,kind:startSource.kind,expectedRevision:startSource.revision,expectedSourceDigest:startSource.sourceDigest});
      if(!mounted.current||nonce!==operation.current)return;
      // Preserve the identity only until a response acknowledges this start; a new deliberate start must create a new run.
      startIdentity.current=null;
      setRunId(result.runId);setOffset(null);setEvidence(null);setMessage('提取已排入队列，可离开页面后继续查看。');
      await cache.invalidateQueries({queryKey:prefix});
    }catch(problem){if(nonce===operation.current)failure(problem);}
    finally{if(mounted.current&&nonce===operation.current)setBusy(null);}
  }
  async function review(action:'confirm'|'reject',input:BibleConfirm|string){
    if(!runId||busy||!permissions.includes('candidate:review'))return;
    const nonce=++operation.current;setBusy(action==='confirm'?'正在确认候选':'正在拒绝候选');setError(null);setMessage(null);
    try{
      if(action==='confirm')await client.bibleConfirm(projectId,runId,input as BibleConfirm);else await client.bibleReject(projectId,runId,input as string);
      if(!mounted.current||nonce!==operation.current)return;
      setMessage(action==='confirm'?'审阅决定已保存为知识快照，尚未采用到正式剧本。':'拒绝决定已保存。');await cache.invalidateQueries({queryKey:prefix});
    }catch(problem){if(nonce===operation.current){failure(problem);await cache.invalidateQueries({queryKey:prefix});}}
    finally{if(mounted.current&&nonce===operation.current)setBusy(null);}
  }
  return <BibleWorkbench capabilities={caps.data??null} runs={runs.data?{items:runs.data.pages.flatMap(page=>page.items),nextCursor:runs.data.pages.at(-1)?.nextCursor??null}:null}
    selectedRunId={runId} status={status.data??null} detail={detail.data??null} source={source.data??null} startSource={startSource} evidence={evidence}
    canStart={permissions.includes('task:run')} canReview={permissions.includes('candidate:review')}
    busy={busy??(detail.isFetching&&runId?'正在读取提取记录':source.isFetching?'正在读取提取时原文':null)} error={error} message={message}
    onStart={()=>{void start();}} onOpen={open} onMore={()=>{void runs.fetchNextPage();}} onRefresh={()=>{void refresh();}}
    onEvidence={value=>{setEvidence(value);setDirection(undefined);setOffset(value.start);}} onSourcePage={(target,way)=>{setDirection(way);setOffset(target);}}
    onConfirm={decision=>{void review('confirm',decision);}} onReject={reason=>{void review('reject',reason);}}/>;
}
