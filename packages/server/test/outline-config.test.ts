import { mkdtemp,writeFile,unlink,rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect,it } from 'vitest';
import { readOutlineConfig } from '../src/outline-config.js';

const profile={label:'大纲配置测试模型',baseUrl:'https://models.example/v1',connectionId:'outline-text',modelIdentity:'fixture-model',structuredOutput:'json_schema',timeoutMs:1000,
  currency:'CNY',reservation:{tokens:1000,costMicros:10},pricing:{inputMicrosPerMillionTokens:100,outputMicrosPerMillionTokens:100},limits:{steps:1,tokens:1000,costMicros:10}};
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'camery-outline-config-')),files=['outline','tasks','text','token'].map(name=>join(directory,name));
  await Promise.all(files.map((path,index)=>writeFile(path,index===2?JSON.stringify(profile):index===3?'fixture-token\n':`postgresql://role_${index}:fixture@localhost/camery`,{mode:0o600})));
  const env:Record<string,string|undefined>={CAMERY_OUTLINE_ENABLED:'1',CAMERY_TENANT_ID:'tenant-a',CAMERY_OUTLINE_PROJECT_ID:'project-a',CAMERY_OUTLINE_DATABASE_URL_FILE:files[0],CAMERY_OUTLINE_TASK_DATABASE_URL_FILE:files[1],CAMERY_OUTLINE_TEXT_CONFIG_FILE:files[2],CAMERY_OUTLINE_TEXT_TOKEN_FILE:files[3]};
  return {directory,files,env,cleanup:async()=>{await Promise.all(files.map(path=>unlink(path)));await rmdir(directory);}};
}
it('defaults off without requiring credentials or accepting disabled residual settings',async()=>{
  expect(await readOutlineConfig({})).toBeNull();expect(await readOutlineConfig({CAMERY_OUTLINE_ENABLED:'0',CAMERY_TENANT_ID:'tenant-a'})).toBeNull();
  for(const env of [{CAMERY_OUTLINE_ENABLED:'yes'},{CAMERY_OUTLINE_PROJECT_ID:'project-a'},{CAMERY_OUTLINE_ENABLED:'1'},{CAMERY_OUTLINE_ENABLED:'0',CAMERY_OUTLINE_WORKER_ID:'worker'}])await expect(readOutlineConfig(env)).rejects.toThrow('Invalid Outline configuration');
});
it('captures every declared environment value before the first await and freezes the shared reader output',async()=>{
  const f=await fixture();try{
    const pending=readOutlineConfig(f.env);for(const name of Object.keys(f.env))f.env[name]='changed';const result=await pending;
    expect(result).toMatchObject({tenantId:'tenant-a',projectId:'project-a',workerId:'outline-worker',pollMs:1000,runsPerRound:20,outlineDatabaseUrl:'postgresql://role_0:fixture@localhost/camery',taskDatabaseUrl:'postgresql://role_1:fixture@localhost/camery',text:{modelIdentity:'fixture-model',token:'fixture-token',allowPrivateNetworks:false,allowInsecureHttp:false,modeDigest:expect.stringMatching(/^[a-f0-9]{64}$/)}});
    expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result?.text)).toBe(true);expect(Object.isFrozen(result?.text?.reservation)).toBe(true);
  }finally{await f.cleanup();}
});
it('allows enabled scoped storage and cached recovery without text, but rejects half of a profile',async()=>{
  const f=await fixture();try{
    const noText={...f.env,CAMERY_OUTLINE_TEXT_CONFIG_FILE:undefined,CAMERY_OUTLINE_TEXT_TOKEN_FILE:undefined};expect(await readOutlineConfig(noText)).toMatchObject({text:null,workerId:'outline-worker'});
    await expect(readOutlineConfig({...noText,CAMERY_OUTLINE_TEXT_CONFIG_FILE:f.files[2]})).rejects.toThrow('Invalid Outline configuration');
    await expect(readOutlineConfig({...noText,CAMERY_OUTLINE_TEXT_TOKEN_FILE:f.files[3]})).rejects.toThrow('Invalid Outline configuration');
    for(const key of ['CAMERY_TENANT_ID','CAMERY_OUTLINE_PROJECT_ID','CAMERY_OUTLINE_DATABASE_URL_FILE','CAMERY_OUTLINE_TASK_DATABASE_URL_FILE'])await expect(readOutlineConfig({...noText,[key]:undefined})).rejects.toThrow('Invalid Outline configuration');
  }finally{await f.cleanup();}
});
it('accepts exactly one balanced reservation and preserves bounded explicit host settings',async()=>{
  const f=await fixture();try{
    expect(await readOutlineConfig({...f.env,CAMERY_OUTLINE_WORKER_ID:'specific-worker',CAMERY_OUTLINE_POLL_MS:'50',CAMERY_OUTLINE_RUNS_PER_ROUND:'1'})).toMatchObject({workerId:'specific-worker',pollMs:50,runsPerRound:1,text:{limits:profile.limits,reservation:profile.reservation}});
    for(const limits of [{...profile.limits,tokens:999},{...profile.limits,costMicros:9},{...profile.limits,steps:0}]){await writeFile(f.files[2]!,JSON.stringify({...profile,limits}));await expect(readOutlineConfig(f.env)).rejects.toThrow('Invalid Outline configuration');}
  }finally{await f.cleanup();}
});
it.each([{CAMERY_OUTLINE_POLL_MS:'49'},{CAMERY_OUTLINE_POLL_MS:'60001'},{CAMERY_OUTLINE_RUNS_PER_ROUND:'0'},{CAMERY_OUTLINE_RUNS_PER_ROUND:'51'},{CAMERY_OUTLINE_WORKER_ID:'bad worker'}])('rejects invalid bounded host configuration %#',async change=>{
  const f=await fixture();try{await expect(readOutlineConfig({...f.env,...change})).rejects.toThrow('Invalid Outline configuration');}finally{await f.cleanup();}
});
it('permits missing pricing only with a positive conservative reservation',async()=>{
  const f=await fixture();try{
    const {pricing:_pricing,...unpriced}=profile;await writeFile(f.files[2]!,JSON.stringify(unpriced));expect((await readOutlineConfig(f.env))?.text?.pricing).toBeUndefined();
    await writeFile(f.files[2]!,JSON.stringify({...unpriced,reservation:{tokens:1000,costMicros:0}}));await expect(readOutlineConfig(f.env)).rejects.toThrow('Invalid Outline configuration');
  }finally{await f.cleanup();}
});
it('rejects environment getters and non-data values without evaluating them',async()=>{
  const f=await fixture();let invoked=false;try{
    await expect(readOutlineConfig(Object.defineProperty({...f.env},'CAMERY_OUTLINE_PROJECT_ID',{get(){invoked=true;throw new Error('fixture-secret');}}))).rejects.toThrow('Invalid Outline configuration');expect(invoked).toBe(false);
    await expect(readOutlineConfig({...f.env,CAMERY_OUTLINE_POLL_MS:10 as never})).rejects.toThrow('Invalid Outline configuration');
  }finally{await f.cleanup();}
});
it('redacts missing, invalid and oversized credential files while reusing the existing file reader',async()=>{
  const f=await fixture();try{
    for(const path of ['',f.directory,join(f.directory,'missing')])await expect(readOutlineConfig({...f.env,CAMERY_OUTLINE_DATABASE_URL_FILE:path})).rejects.toThrow(/^Invalid Outline configuration$/);
    await writeFile(f.files[0]!,'x'.repeat(8193));await expect(readOutlineConfig(f.env)).rejects.toThrow(/^Invalid Outline configuration$/);
    await writeFile(f.files[0]!,'https://fixture-private.example');await expect(readOutlineConfig(f.env)).rejects.toThrow(/^Invalid Outline configuration$/);
  }finally{await f.cleanup();}
});
it('rejects malformed text, unsupported evidence and unusable tokens without leaking their content',async()=>{
  const f=await fixture();try{
    for(const body of ['{',JSON.stringify({...profile,evidence:'synthetic_replay'}),'x'.repeat(8193)]){await writeFile(f.files[2]!,body);await expect(readOutlineConfig(f.env)).rejects.toThrow(/^Invalid Outline configuration$/);}
    await writeFile(f.files[2]!,JSON.stringify(profile));for(const token of ['', 'fixture\nsecret','x'.repeat(8193),Buffer.from([0xff])]){await writeFile(f.files[3]!,token);await expect(readOutlineConfig(f.env)).rejects.toThrow(/^Invalid Outline configuration$/);}
  }finally{await f.cleanup();}
});
