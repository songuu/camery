import {ChangeSet,StableId,StoryboardPackage,validatePackage} from '@camery/ir';
import {VersioningError} from './errors';
import {jsonSignature} from './objects';
import type {Principal,VersionState} from './types';

export interface ChangeOperationSelection {
  sourceChangeId:string; operationIds:readonly string[]; changeId:string; author:Principal;
}

/** The trusted host supplies the human author; this pure builder never grants authority or submits its result. */
export function selectChangeOperations(state:VersionState,input:ChangeOperationSelection):ChangeSet{
  jsonSignature(input);
  if(!input||!StableId.safeParse(input.sourceChangeId).success||!StableId.safeParse(input.changeId).success||input.changeId===input.sourceChangeId)
    throw new VersioningError('SELECTION_INVALID','/changeId','Selection requires canonical, distinct source and new change identities');
  if(input.author?.kind!=='user'||!StableId.safeParse(input.author.id).success)
    throw new VersioningError('SELECTION_AUTHORITY','/author','Selection requires a human identity supplied by the trusted host');
  if(!Array.isArray(input.operationIds)||input.operationIds.length===0||new Set(input.operationIds).size!==input.operationIds.length)
    throw new VersioningError('SELECTION_INVALID','/operationIds','Select at least one unique original operation');
  if(input.operationIds.length>500)throw new VersioningError('INPUT_LIMIT','/operationIds','Selection exceeds 500 operations');
  const source=state.changes.find(change=>change.request.id===input.sourceChangeId);
  if(!source||source.status!=='candidate'||source.preview===null)
    throw new VersioningError('SELECTION_SOURCE','/sourceChangeId','Selection requires a live candidate with a valid preview');
  jsonSignature(source.request);jsonSignature(source.preview);
  const request=ChangeSet.safeParse(source.request),preview=StoryboardPackage.safeParse(source.preview);
  if(!request.success||request.data.status!=='candidate'||!preview.success||!validatePackage(preview.data).valid||preview.data.revision.status!=='candidate')
    throw new VersioningError('SELECTION_SOURCE','/sourceChangeId','Original candidate request or preview is invalid');
  const wanted=new Set(input.operationIds),ops=request.data.ops.filter(op=>wanted.has(op.op_id));
  if(ops.length!==wanted.size)throw new VersioningError('SELECTION_INVALID','/operationIds','Selected operations must exist in the original request');
  if(ops.some(op=>!['add','update','replace','remove','move'].includes(op.op)))
    throw new VersioningError('SELECTION_UNSUPPORTED','/operationIds','Split, merge, lock and schema operations require their complete original decision path');
  const selected=ChangeSet.safeParse({...request.data,id:input.changeId,author:input.author,base_revision:state.head.revision.number,ops});
  if(!selected.success)throw new VersioningError('SELECTION_INVALID','/selection','Selected request does not satisfy the ChangeSet contract');
  return structuredClone(selected.data);
}
