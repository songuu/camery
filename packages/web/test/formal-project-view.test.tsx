import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {FormalProjectView} from '../src/FormalProjectPane.js';
import {FormalProjectLoadError} from '../src/FormalProjectBoundary.js';
import type {WorkbenchSnapshot,WorkbenchObjectHistory} from '@camery/ir/workbench';
const id='01ARZ3NDEKTSV4RRFFQ69G5FAV';const asset='01ARZ3NDEKTSV4RRFFQ69G5FAW';
const snapshot:WorkbenchSnapshot={contractVersion:1,projectKey:'project',projectId:id,schemaVersion:'0.6.0-draft',snapshotRevision:8,writeVersion:12,scope:{kind:'project',id},renditionId:null,nextCursor:'more',counts:[{collection:'shots',count:1}],capabilities:{canWrite:false,canReview:false,canReadMedia:false},rows:[{ref:{collection:'shots',id,version:2},role:'owned',value:{id,version:2,action:'船驶入雾中',duration:{planned:1.123456789,measured:null}}},{ref:{collection:'assets',id:asset,version:1},role:'context',value:{id:asset,version:1,file:{path:'C:\\secret\\movie.mp4',sha256:'hash'}}}],relations:[{kind:'provenance',from:{collection:'shots',id,version:2},to:{collection:'assets',id:asset,version:1},field:'asset_ref',pin:'explicit',currentVersion:2,stale:true}],lineage:[{from_ids:[asset],to_ids:[id],revision:8}],locks:[{ref:{collection:'locks',id:asset,version:1},target:id,fields:['action'],ownerId:id,reason:'已确认动作'}]};
const history:WorkbenchObjectHistory={contractVersion:1,projectKey:'project',projectId:id,collection:'shots',objectId:id,snapshotRevision:8,writeVersion:12,nextCursor:'history-more',items:[{ref:{collection:'shots',id,version:3},parentVersion:2,snapshotRevision:7,changeId:asset,deleted:true,value:null}]};
it('shows adopted content, exact timing, source pins, locks and tombstones without leaking a local media path',()=>{
  const markup=renderToStaticMarkup(<FormalProjectView pages={[snapshot]} history={history} filter={{scope:'project',scopeId:'',renditionId:'',collection:''}} busy={false} stale={false} error={null} mediaMessage="素材尚未就绪，当前无法读取媒体。" onFilter={()=>{}} onApply={()=>{}} onRefresh={()=>{}} onMore={()=>{}} onHistory={()=>{}} onHistoryMore={()=>{}} onHistoryClose={()=>{}} onScope={()=>{}} onAsset={()=>{}} onClose={()=>{}}/>);
  for(const text of ['正式版本 8','船驶入雾中','1.123456789','来源依据','固定版本','已过期','已确认动作','内容锁定','已删除（墓碑）','快照 7',asset,'素材尚未就绪'])expect(markup).toContain(text);
  expect(markup).not.toContain('secret');expect(markup).not.toContain('movie.mp4');expect(markup).not.toContain('<img');expect(markup).toContain('查看更多对象');expect(markup).toContain('更多历史');
});
it('keeps historical lookup available for deleted objects that no longer have a current row',()=>{
  const markup=renderToStaticMarkup(<FormalProjectView pages={[{...snapshot,rows:[]}]} history={null} historyTarget={{collection:'shots',id:asset}} onHistoryTarget={()=>{}} onHistoryLookup={()=>{}} filter={{scope:'project',scopeId:'',renditionId:'',collection:''}} busy={false} stale={false} error={null} mediaMessage={null} onFilter={()=>{}} onApply={()=>{}} onRefresh={()=>{}} onMore={()=>{}} onHistory={()=>{}} onHistoryMore={()=>{}} onHistoryClose={()=>{}} onScope={()=>{}} onAsset={()=>{}} onClose={()=>{}}/>);
  expect(markup).toContain('历史对象类型');expect(markup).toContain('历史对象标识');expect(markup).toMatch(/<button type="button">查找对象历史<\/button>/);expect(markup).toContain(`value="${asset}"`);
});
it('offers a local close after lazy loading fails without promising a cached import retry or forcing a page reload',()=>{
  const markup=renderToStaticMarkup(<FormalProjectLoadError onClose={()=>{}}/>);
  expect(markup).toContain('正式内容界面暂时无法加载');expect(markup).toContain('可关闭后继续处理当前内容');expect(markup).toContain('关闭正式内容');expect(markup).toContain('重新加载页面后再尝试打开');expect(markup).not.toContain('立即重试');expect(markup).not.toContain('location.reload');
});
it('clearly requires a fresh snapshot after staleness and never renders the old rows in that state',()=>{
  const markup=renderToStaticMarkup(<FormalProjectView pages={[]} history={null} filter={{scope:'project',scopeId:'',renditionId:'',collection:''}} busy={false} stale={true} error="正式内容已更新，请刷新后重新查看。" mediaMessage={null} onFilter={()=>{}} onApply={()=>{}} onRefresh={()=>{}} onMore={()=>{}} onHistory={()=>{}} onHistoryMore={()=>{}} onHistoryClose={()=>{}} onScope={()=>{}} onAsset={()=>{}} onClose={()=>{}}/>);
  expect(markup).toContain('正式内容已更新');expect(markup).toContain('读取最新正式版本');expect(markup).not.toContain('船驶入雾中');
});
