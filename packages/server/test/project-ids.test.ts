import {expect,it,vi} from 'vitest';
import {StableId} from '@camery/ir';
import {newProjectObjectId} from '../src/projects/ids.js';
it('allocates canonical random ULIDs with the actual 48-bit timestamp prefix',()=>{
  const now=1794902400123;const spy=vi.spyOn(Date,'now').mockReturnValue(now);
  try{const values=Array.from({length:1000},()=>newProjectObjectId());expect(new Set(values).size).toBe(values.length);for(const value of values)expect(StableId.safeParse(value).success).toBe(true);const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let timestamp=0n;for(const char of values[0]!.slice(0,10))timestamp=timestamp*32n+BigInt(alphabet.indexOf(char));expect(timestamp).toBe(BigInt(now));}
  finally{spy.mockRestore();}
});
it.each([-1,NaN,Infinity,281474976710656,1.5])('rejects an invalid host timestamp %s',now=>{const spy=vi.spyOn(Date,'now').mockReturnValue(now);try{expect(()=>newProjectObjectId()).toThrow('Project identity allocation unavailable');}finally{spy.mockRestore();}});
