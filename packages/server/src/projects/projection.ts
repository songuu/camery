import {isDeepStrictEqual} from 'node:util';
import {StableId,type StoryboardPackage} from '@camery/ir';
import {WorkbenchCandidateDetailSchema,WorkbenchPreviewResultSchema} from '@camery/ir/workbench';
import type {WorkbenchCandidateDetail,WorkbenchPreviewResult} from '@camery/ir/workbench';
import type {ChangeResult,StoredChange,VersionState} from '@camery/versioning';
import {ProjectApplicationError} from './intent-contracts.js';
import type {CandidateIntent,ProjectActionReceipt} from './intent-contracts.js';
import {redactReadObject} from './read-projection.js';

type Row={collection:string;value:Record<string,unknown>};
type Difference=WorkbenchCandidateDetail['differences'][number];
export function redactDifference(row:Difference):Difference{return {...row,before:row.before?redactReadObject(row.collection,row.before):null,after:row.after?redactReadObject(row.collection,row.after):null};}
function previewObjects(snapshot:StoryboardPackage){
  const objects=new Map<string,Row>();
  for(const [collection,rows] of Object.entries(snapshot))if(Array.isArray(rows))for(const value of rows){
    if(value!==null&&typeof value==='object'&&'id' in value&&typeof value.id==='string'&&'version' in value)objects.set(value.id,{collection,value:value as Record<string,unknown>});
  }
  return objects;
}
function historyObjects(state:VersionState,revision:number){
  const latest=new Map<string,VersionState['revisions'][number]>();
  for(const row of state.revisions){
    if(row.snapshot_revision>revision)continue;const previous=latest.get(row.object_id);
    if(!previous||row.snapshot_revision>previous.snapshot_revision||row.snapshot_revision===previous.snapshot_revision&&row.version>previous.version)latest.set(row.object_id,row);
  }
  const objects=new Map<string,Row>();for(const [id,row] of latest)if(row.value!==null)objects.set(id,{collection:row.collection,value:row.value});return objects;
}
/** Native adoption refreshes the saved preview; compare that result with the actual adoption base. */
function differences(state:VersionState,stored:StoredChange):Difference[]{
  if(!stored.preview)return [];
  const adopted=stored.status==='adopted'?state.adoptions.find(row=>row.change_set_id===stored.request.id):undefined;
  if(stored.status==='adopted'&&!adopted)throw new ProjectApplicationError('STORAGE_FAILED','adopted difference baseline');
  const before=historyObjects(state,adopted?.from_revision??stored.prepared_from_revision);const after=previewObjects(stored.preview);const rows:Difference[]=[];
  const push=(row:Difference)=>{if(rows.length===500)throw new ProjectApplicationError('INPUT_LIMIT','candidate differences');rows.push(redactDifference(row));};
  const upgrade=stored.request.ops.find(op=>op.op==='upgrade_schema');const beforeSchema=upgrade?.op==='upgrade_schema'?upgrade.from:stored.request.schema_version;
  if(beforeSchema!==stored.preview.schema_version)push({collection:'projects',id:state.head.project.id,kind:'replace',before:{schema_version:beforeSchema},after:{schema_version:stored.preview.schema_version}});
  for(const id of [...new Set([...before.keys(),...after.keys()])].sort()){
    const old=before.get(id);const current=after.get(id);if(old&&current&&old.collection===current.collection&&isDeepStrictEqual(old.value,current.value))continue;
    push({collection:(current??old)!.collection,id,kind:!old?'add':!current?'remove':'replace',before:old?.value??null,after:current?.value??null});
  }
  return rows;
}
interface CandidateProjectionInput {projectKey:string;state:VersionState;writeVersion:number;candidateId:string;intent:CandidateIntent|null;preparation:ProjectActionReceipt|null;canReview:boolean;sourceState?:'current'|'stale'|'unavailable'}
export function projectCandidateDetail(input:CandidateProjectionInput):WorkbenchCandidateDetail{
  const {projectKey,state,writeVersion,candidateId,intent,preparation,canReview}=input;const stored=state.changes.find(row=>row.request.id===candidateId);
  if(!stored&&!intent)throw new ProjectApplicationError('NOT_FOUND','candidate projection');
  if(intent&&(intent.changeId!==candidateId||intent.scope.projectId!==projectKey||intent.target.projectId!==state.head.project.id)||preparation&&preparation.changeId!==candidateId)throw new ProjectApplicationError('STORAGE_FAILED','candidate projection binding');
  const status=stored?.status??preparation?.status??'prepared';
  const source:WorkbenchCandidateDetail['source']=!intent?{kind:'unmanaged'}:intent.source.kind==='manual'?{kind:'manual'}:{kind:'development',runId:intent.source.source.runId,state:input.sourceState??'unavailable'};
  const blockingReasons:string[]=[];
  if(!intent)blockingReasons.push('SOURCE_POLICY_MISSING');
  else{
    if(source.kind==='development'&&source.state!=='current')blockingReasons.push(source.state==='stale'?'SOURCE_STALE':'SOURCE_UNAVAILABLE');
    if(!stored&&status!=='unchanged')blockingReasons.push('PREPARATION_INCOMPLETE');
    if(!canReview)blockingReasons.push('REVIEW_PERMISSION_REQUIRED');
  }
  const live=!!intent&&!!stored&&stored.status==='candidate';
  const current=previewObjects(state.head),readDependenciesCurrent=!live||stored.request.base_revisions.every(ref=>current.get(ref.id)?.value['version']===ref.version);
  if(!readDependenciesCurrent)blockingReasons.push('READ_DEPENDENCY_CHANGED');
  const operations=intent?(stored?.request??intent.request)?.ops.map(op=>({operationId:op.op_id,kind:op.op,collection:'collection' in op?op.collection:null,
    target:'target' in op?op.target:op.op==='add'&&StableId.safeParse(op.value['id']).success?op.value['id'] as string:null,
    selectable:live&&!intent.derivation&&['add','update','replace','remove','move'].includes(op.op)})):undefined;
  return WorkbenchCandidateDetailSchema.parse({contractVersion:1,projectKey,candidateId,applicationId:intent?.applicationId??null,managed:!!intent,status,
    authorId:intent?.actor.id??stored!.request.author.id,authorKey:intent?.actor.key??null,createdAt:intent?.createdAt??null,baseRevision:intent?.expectation.expectedSnapshotRevision??stored!.request.base_revision,
    baseWriteVersion:intent?.expectation.expectedWriteVersion??null,source,snapshotRevision:state.head.revision.number,writeVersion,scope:{kind:'project',id:state.head.project.id},
    differences:stored?differences(state,stored):[],issues:structuredClone(stored?.issues??preparation?.issues??[]),warnings:structuredClone(stored?.warnings??preparation?.warnings??[]),
    canAdopt:live&&canReview&&readDependenciesCurrent&&!!stored?.preview&&(source.kind!=='development'||source.state==='current'),canReject:live&&canReview,blockingReasons,preparation:structuredClone(preparation),...(intent?.derivation?{derivation:structuredClone(intent.derivation)}:{}),...(operations?{operations}:{}),
  });
}
export function projectPreview({state,writeVersion,result,candidateId}:{state:VersionState;writeVersion:number;result:ChangeResult;candidateId?:string}):WorkbenchPreviewResult{
  if(result.status==='adopted')throw new ProjectApplicationError('CONFLICT','preview already adopted');
  // Failed validation may produce no stored record; it must not borrow an unrelated earlier candidate.
  const previous=new Map(state.changes.map(row=>[row.request.id,row]));
  const changed=result.state.changes.filter(row=>!previous.has(row.request.id)||!isDeepStrictEqual(previous.get(row.request.id),row));
  if(changed.length>1)throw new ProjectApplicationError('STORAGE_FAILED','preview projection binding');
  const stored=candidateId===undefined?changed[0]:result.state.changes.find(row=>row.request.id===candidateId);
  // A duplicate ID with different content can fail before touching its stored candidate.
  const evidence=stored&&stored.status===result.status&&isDeepStrictEqual(stored.issues,result.issues)&&isDeepStrictEqual(stored.warnings,result.warnings)?stored:undefined;
  return WorkbenchPreviewResultSchema.parse({contractVersion:1,status:result.status,snapshotRevision:state.head.revision.number,writeVersion,differences:evidence?differences(result.state,evidence):[],issues:structuredClone(result.issues),warnings:structuredClone(result.warnings)});
}
