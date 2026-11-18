import {Readable} from 'node:stream';
import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({close:vi.fn(async()=>{})}));
vi.mock('node:fs/promises',()=>({open:vi.fn(async()=>({stat:async()=>({isFile:()=>true,size:1}),createReadStream:(options:{end:number})=>{expect(options.end).toBe(8192);return Readable.from([Buffer.alloc(8193,97)]);},close:state.close}))}));
import {readOutlineAdoptionConfig} from '../src/projects/outline-adoption-config.js';
it('bounds the actual adopter secret read after it grows beyond stat size and closes the owned file',async()=>{await expect(readOutlineAdoptionConfig({CAMERY_OUTLINE_ADOPTION_ENABLED:'1',CAMERY_TENANT_ID:'tenant',CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE:'adopter'})).rejects.toThrow('Invalid Outline adoption configuration');expect(state.close).toHaveBeenCalledOnce();});
