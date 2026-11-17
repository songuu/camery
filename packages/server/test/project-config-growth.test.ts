import {Readable} from 'node:stream';
import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({size:8193,close:vi.fn(async()=>{})}));
vi.mock('node:fs/promises',()=>({open:vi.fn(async()=>({stat:async()=>({isFile:()=>true,size:1}),createReadStream:(options:{end:number})=>{expect(options.end).toBe(8192);return Readable.from([Buffer.alloc(state.size,97)]);},close:state.close}))}));
import {readProjectConfig} from '../src/projects/config.js';
it('bounds the actual read after a secret grows beyond its stat size and always closes it',async()=>{await expect(readProjectConfig({CAMERY_PROJECTS_ENABLED:'1',CAMERY_TENANT_ID:'tenant',CAMERY_PROJECTS_READER_DATABASE_URL_FILE:'reader',CAMERY_PROJECTS_ADOPTION_DATABASE_URL_FILE:'adopter'})).rejects.toThrow('Invalid project configuration');expect(state.close).toHaveBeenCalledOnce();});
