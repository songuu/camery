import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {DevelopmentAdoptionView} from '../src/DevelopmentAdoptionPane.js';
import type {WorkbenchCandidateDetail,WorkbenchState} from '@camery/ir/workbench';
import {decisionReceiptFeedback} from '../src/DevelopmentAdoptionState.js';
const id='01ARZ3NDEKTSV4RRFFQ69G5FAV';
const state:WorkbenchState={contractVersion:1,projectId:id,projectKey:'project',schemaVersion:'0.6.0-draft',snapshotRevision:2,writeVersion:4,actorId:id,canWrite:true,canReview:true,nativePending:1,counts:[{collection:'characters',count:2}]};
const candidate:WorkbenchCandidateDetail={contractVersion:1,projectKey:'project',candidateId:id,applicationId:null,managed:false,status:'candidate',authorId:id,authorKey:null,createdAt:null,baseRevision:1,baseWriteVersion:null,source:{kind:'unmanaged'},snapshotRevision:2,writeVersion:4,scope:{kind:'project',id},differences:[{collection:'characters',id,kind:'replace',before:{name:'旧人物',desire:'离开'},after:{name:'新人 物',desire:'回家',unknown_business_field:'完整保留'}}],issues:[],warnings:[],canAdopt:false,canReject:false,blockingReasons:['UNMANAGED_CANDIDATE'],preparation:null};
it('shows full before/after business data and a readable reason that a native candidate cannot be adopted',()=>{
  const markup=renderToStaticMarkup(<DevelopmentAdoptionView state={state} items={[candidate]} detail={candidate} busy={false} error={null} message={null} pending={false} reason="" nextCursor={null} sourceChanged={false} onRefresh={()=>{}} onPrepare={()=>{}} onUpgrade={()=>{}} onOpen={()=>{}} onMore={()=>{}} onAdopt={()=>{}} onReject={()=>{}} onRetry={()=>{}} onReason={()=>{}}/>);
  for(const text of ['旧人物','新人 物','离开','回家','完整保留','外部候选','不能直接采用','正式剧本','人物'])expect(markup).toContain(text);
  expect(markup).toMatch(/disabled=""[^>]*>采用到正式剧本/);
});
it('shows a known failed decision and its issues while retaining the real candidate without an unknown-result retry',()=>{
  const feedback=decisionReceiptFeedback('adopt',{version:1,changeId:id,status:'rejected',snapshotRevision:2,writeVersion:4,issues:[{code:'LOCK_AUTHORITY',where:'/actor',message:'Trusted actor mismatch'}],warnings:[],adoption:null,rejection:null});
  const markup=renderToStaticMarkup(<DevelopmentAdoptionView state={state} items={[candidate]} detail={candidate} busy={false} error={feedback.error} message={feedback.message} decisionIssues={feedback.issues} pending={false} reason="" nextCursor={null} sourceChanged={false} onRefresh={()=>{}} onPrepare={()=>{}} onUpgrade={()=>{}} onOpen={()=>{}} onMore={()=>{}} onAdopt={()=>{}} onReject={()=>{}} onRetry={()=>{}} onReason={()=>{}}/>);
  expect(markup).toContain('本次采用未完成');expect(markup).toContain('只有获得授权的成员才能变更内容锁定');expect(markup).toContain('待采用');expect(markup).not.toContain('候选已拒绝');expect(markup).not.toContain('使用原请求重试');
});
it('requires an explicit schema upgrade and does not offer ordinary preparation in a legacy project',()=>{
  const markup=renderToStaticMarkup(<DevelopmentAdoptionView state={{...state,schemaVersion:'0.5.0-draft'}} items={[]} detail={null} busy={false} error={null} message={null} pending={false} reason="" nextCursor={null} sourceChanged={false} onRefresh={()=>{}} onPrepare={()=>{}} onUpgrade={()=>{}} onOpen={()=>{}} onMore={()=>{}} onAdopt={()=>{}} onReject={()=>{}} onRetry={()=>{}} onReason={()=>{}}/>);
  expect(markup).toContain('准备项目升级候选');expect(markup).not.toContain('>准备正式采用候选<');
});
it('keeps a reviewer from preparing and a writer from adopting while preserving the complete diff',()=>{
  const render=(canWrite:boolean,canReview:boolean)=>renderToStaticMarkup(<DevelopmentAdoptionView state={{...state,canWrite,canReview}} items={[]} detail={{...candidate,managed:true,canAdopt:true,canReject:true,source:{kind:'development',runId:'run',state:'stale'}}} busy={false} error="当前账号没有执行此操作的权限。已有内容仍可查看。" message={null} pending={false} reason="修改人物" nextCursor={null} sourceChanged={true} onRefresh={()=>{}} onPrepare={()=>{}} onUpgrade={()=>{}} onOpen={()=>{}} onMore={()=>{}} onAdopt={()=>{}} onReject={()=>{}} onRetry={()=>{}} onReason={()=>{}}/>);
  const writer=render(true,false);expect(writer).toContain('完整保留');expect(writer).toContain('已有新修订，暂不能采用');expect(writer).toMatch(/disabled=""[^>]*>采用到正式剧本/);
  const reviewer=render(false,true);expect(reviewer).toMatch(/disabled=""[^>]*>准备正式采用候选/);expect(reviewer).toContain('已有内容仍可查看');
});
it('summarizes only nonempty formal collections using ordinary Chinese labels',()=>{
  const render=(counts:WorkbenchState['counts'])=>renderToStaticMarkup(<DevelopmentAdoptionView state={{...state,counts}} items={[]} detail={null} busy={false} error={null} message={null} pending={false} reason="" nextCursor={null} sourceChanged={false} onRefresh={()=>{}} onPrepare={()=>{}} onUpgrade={()=>{}} onOpen={()=>{}} onMore={()=>{}} onAdopt={()=>{}} onReject={()=>{}} onRetry={()=>{}} onReason={()=>{}}/>);
  const empty=render([{collection:'sources',count:0},{collection:'characters',count:0},{collection:'audio_cues',count:0}]);
  expect(empty).toContain('正式剧本尚无内容');expect(empty).not.toContain('sources 0');expect(empty).not.toContain('audio_cues');expect(empty).not.toContain('人物 0');
  const populated=render([{collection:'sources',count:2},{collection:'appearances',count:3},{collection:'locks',count:1},{collection:'audio_cues',count:0}]);
  for(const text of ['来源 2','人物造型 3','内容锁定 1'])expect(populated).toContain(text);expect(populated).not.toContain('sources');expect(populated).not.toContain('audio_cues');
});
it('does not offer to resume an unrelated manual preparation from the all-candidates directory',()=>{
  const markup=renderToStaticMarkup(<DevelopmentAdoptionView state={{...state,schemaVersion:'0.5.0-draft'}} allCandidates={true} items={[]} detail={{...candidate,managed:true,status:'prepared',applicationId:'unrelated-manual',baseWriteVersion:1,source:{kind:'manual'}}} busy={false} error={null} message={null} pending={false} reason="" nextCursor={null} sourceChanged={false} onRefresh={()=>{}} onPrepare={()=>{}} onUpgrade={()=>{}} onOpen={()=>{}} onMore={()=>{}} onAdopt={()=>{}} onReject={()=>{}} onRetry={()=>{}} onReason={()=>{}}/>);
  expect(markup).toContain('>准备项目升级候选<');expect(markup).not.toContain('继续准备项目升级候选');
});
