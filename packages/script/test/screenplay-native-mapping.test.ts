import {expect,it} from 'vitest';
import {adoptChangeSet,createVersionState,submitChangeSet} from '@camery/versioning';
import {screenplayFormalFixture} from './screenplay-formal-support.js';
import {createScreenplayCandidate,reviewScreenplayCandidate} from '../src/screenplay/node/review.js';
import {prepareScreenplayNativeMapping,screenplayNativeSlots} from '../src/screenplay/node/native-mapping.js';
async function fixture(){const f=await screenplayFormalFixture(),candidate=createScreenplayCandidate(f.scope,f.context,f.draft),host={scope:f.scope,actor:{kind:'human' as const,id:'editor'},at:'2026-11-19T05:00:00.000Z',authorize:()=>true};
  const review=reviewScreenplayCandidate(f.context,candidate,{candidateDigest:candidate.digest,draft:f.draft,waivers:candidate.issues.filter(row=>row.severity==='warning').map(row=>({issueId:row.id,reason:'逐项人工决定。'}))},host);
  const slots=screenplayNativeSlots(f.draft),ids=slots.map(slot=>({slot,id:f.id('screenplay-map-'+slot)}));
  return {...f,candidate,review,input:{head:f.head,context:f.context,candidate,review,target:f.target,changeId:f.id('screenplay-map-change'),author:{kind:'user' as const,id:f.id('screenplay-map-author')},ids}};}
it('publishes the full body and explicit text locks in one native adoption, preserving v1 evidence and all voice content',async()=>{
  const f=await fixture(),mapping=prepareScreenplayNativeMapping(f.input),submitted=submitChangeSet(createVersionState(f.head),mapping.request);
  expect(submitted.status).toBe('candidate');expect(mapping.request.ops.filter(row=>row.op==='lock')).toHaveLength(1);
  const adopted=adoptChangeSet(submitted.state,mapping.request.id,{actor:f.input.author,scope:{kind:'episode',id:f.context.episode.id},at:'2026-11-19T05:00:00.000Z',authorize:()=>true});expect(adopted.status).toBe('adopted');
  const line=adopted.state.head.lines[0]!;expect(line).toMatchObject({version:1,locked:true,text:f.draft.scenes[0]!.beats[1]!.lines[0]!.text});
  expect(adopted.state.revisions.filter(row=>row.object_id===line.id)).toHaveLength(1);expect(adopted.state.head.scenes[0]!.script_text).toContain(line.text);
  expect(mapping.events.find(row=>row.localId==='line-0')!.ref).toEqual({kind:'line',id:line.id,version:1});
  expect(mapping.reviewDigest).toBe(f.review.digest);expect(mapping.candidateDigest).toBe(f.candidate.digest);
});
it.each(['missing','duplicate','collision','stale','review','target','occupied','operation'] as const)('refuses %s before constructing native authority',async mode=>{
  const f=await fixture();
  if(mode==='missing')f.input.ids.pop();if(mode==='duplicate')f.input.ids.push(f.input.ids[0]!);
  if(mode==='collision')f.input.ids[0]!.id=f.head.characters[0]!.id;
  if(mode==='stale')f.input.context={...f.context,snapshotRevision:f.context.snapshotRevision+1};
  if(mode==='review')f.input.review={...f.review,digest:'b'.repeat(64)};
  if(mode==='target')f.input.target={...f.target,projectId:f.id('wrong-project')};
  if(mode==='occupied'){const mapping=prepareScreenplayNativeMapping(f.input),result=adoptChangeSet(submitChangeSet(createVersionState(f.head),mapping.request).state,mapping.request.id,{actor:f.input.author,scope:{kind:'episode',id:f.context.episode.id},at:'2026-11-19T05:00:00.000Z',authorize:()=>true});f.input.head=result.state.head as typeof f.head;}
  if(mode==='operation')f.input.ids[0]!.slot='unknown-slot';
  expect(()=>prepareScreenplayNativeMapping(f.input)).toThrow();
});
