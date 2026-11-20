import {EditableCollection,StoryboardPackage,validatePackage} from '@camery/ir';
import {VersioningError} from './errors';
import {jsonSignature,objects} from './objects';

export interface VersionDifference {
  collection:string; id:string; kind:'add'|'replace'|'remove';
  before:Record<string,unknown>|null; after:Record<string,unknown>|null;
}

function snapshot(input:StoryboardPackage,where:string):StoryboardPackage{
  jsonSignature(input);
  const parsed=StoryboardPackage.safeParse(input);
  if(!parsed.success||!validatePackage(parsed.data).valid)
    throw new VersioningError('INVALID_SNAPSHOT',where,'Comparison requires a valid version snapshot');
  return parsed.data;
}

function comparisonRows(pkg:StoryboardPackage){
  const rows=new Map<string,{collection:string;value:Record<string,unknown>&{id:string}}>([...objects(pkg)].map(([id,row])=>[row.collection+'/'+id,row]));
  // Native edits update project scope counts even though project has no object revision counter.
  rows.set('projects/'+pkg.project.id,{collection:'projects',value:pkg.project});
  return rows;
}

/** Snapshot revision metadata identifies the compared inputs; non-object content must never disappear from a comparison. */
export function compareVersionSnapshots(before:StoryboardPackage,after:StoryboardPackage):VersionDifference[]{
  const left=snapshot(before,'/before'),right=snapshot(after,'/after');
  if(left.project.id!==right.project.id||left.package_id!==right.package_id)
    throw new VersioningError('COMPARE_IDENTITY','/after','Comparison requires the same project and package');
  if(left.schema_version!==right.schema_version)
    throw new VersioningError('COMPARE_SCHEMA','/after/schema_version','Cross-schema comparison requires a dedicated adapter');
  const collections=new Set<string>([...EditableCollection.options,'locks']);
  for(const field of Object.keys(left)){
    if(field==='revision'||field==='project'||collections.has(field))continue;
    if(jsonSignature(left[field as keyof StoryboardPackage])!==jsonSignature(right[field as keyof StoryboardPackage]))
      throw new VersioningError('COMPARE_UNSUPPORTED','/'+field,'Changed metadata or lineage cannot be represented as object differences');
  }
  const oldRows=comparisonRows(left),newRows=comparisonRows(right);
  const differences:VersionDifference[]=[];
  for(const key of [...new Set([...oldRows.keys(),...newRows.keys()])].sort()){
    const old=oldRows.get(key),current=newRows.get(key);
    if(old&&current&&jsonSignature(old.value)===jsonSignature(current.value))continue;
    if(differences.length===500)throw new VersioningError('INPUT_LIMIT','/differences','Comparison exceeds 500 object differences');
    differences.push({collection:(current??old)!.collection,id:(current??old)!.value.id,
      kind:old?(current?'replace':'remove'):'add',before:old?structuredClone(old.value):null,after:current?structuredClone(current.value):null});
  }
  return differences;
}
