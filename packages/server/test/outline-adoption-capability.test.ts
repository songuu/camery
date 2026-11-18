import {afterEach,expect,it,vi} from 'vitest';
import type {SessionIdentity,SessionStore} from '@camery/access';
import {createApplication} from '../src/app.js';
import type {OutlineApiOptions} from '../src/outline-options.js';
import type {ProjectApplicationOptions} from '../src/projects/options.js';
import type {OutlineAdoptionOptions} from '../src/projects/outline-adoption-options.js';
import type {OutlineFormalReadOptions} from '../src/projects/outline-formal-options.js';
const apps:Awaited<ReturnType<typeof createApplication>>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
it.each([0,1,2,3,4,5,6,7])('advertises formal adoption only when the complete trusted composition is present: %s',async mask=>{
  const subject:SessionIdentity={tenantId:'tenant',userId:'viewer',sessionId:'session',grants:[{projectId:'project',role:'viewer'}]};
  const store={lookup:vi.fn(async()=>subject),revoke:vi.fn(async()=>{})} satisfies SessionStore,presetFor=vi.fn(()=>null);
  const app=await createApplication({tenantId:'tenant',store,outlines:{presetFor,formalAdoption:true} as unknown as OutlineApiOptions,
    ...(mask&1?{projects:{tenantId:'tenant'} as ProjectApplicationOptions}:{}),...(mask&2?{outlineAdoption:{tenantId:'tenant'} as OutlineAdoptionOptions}:{}),...(mask&4?{outlineFormal:{tenantId:'tenant'} as OutlineFormalReadOptions}:{})});apps.push(app);
  const url='/api/v1/projects/project/outlines/capabilities',headers={authorization:`Bearer cmry_${'f'.repeat(43)}`};
  const response=await app.inject({url,headers});expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({canStart:false,modelLabel:null,formalAdoption:mask===7});
  presetFor.mockClear();expect((await app.inject({url})).statusCode).toBe(401);expect((await app.inject({url:url.replace('/project/','/foreign/'),headers})).statusCode).toBe(403);expect(presetFor).not.toHaveBeenCalled();
});
