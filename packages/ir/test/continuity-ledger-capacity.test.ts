import {expect,it} from 'vitest';
import {validatePackage} from '../src/index';
import {makeContinuityPackage} from './continuity-ledger-fixture';
import {fixtureId as id} from './fixtures';
import type {StoryboardPackageV08} from '../src/index';
function capacityPackage(size:number):StoryboardPackageV08{
  const p=makeContinuityPackage(),beat=p.beats[0]!,line=p.lines[0]!;
  for(let i=0;i<size;i++){const beatId=id('continuity-capacity-beat-'+i);p.beats.push({...beat,id:beatId,required:false,order_key:'u'+i.toString().padStart(5,'0')});p.lines.push({...line,id:id('continuity-capacity-line-'+i),beat_id:beatId,order_key:'a0'});}return p;
}
it('validates an 8k beat/line native script while preserving the complete four-ledger record',()=>{
  const p=capacityPackage(8192),saved=structuredClone(p.continuity_snapshots),bytes=new TextEncoder().encode(JSON.stringify(p)).byteLength;expect(bytes).toBeGreaterThan(4_000_000);expect(bytes).toBeLessThan(67_108_864);expect(validatePackage(p).errors).toEqual([]);expect(p.continuity_snapshots).toEqual(saved);expect(p.beats.length).toBeGreaterThan(8192);expect(p.lines.length).toBeGreaterThan(8192);
});
