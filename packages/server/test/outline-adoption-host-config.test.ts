import {mkdtemp,writeFile,rm,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {readOutlineAdoptionConfig,resolveOutlineAdoptionDeployment} from '../src/projects/outline-adoption-config.js';

const credentials={reader:'postgresql://reader:fixture@localhost/camery',old:'postgresql://old_adopter:fixture@localhost/camery',adopter:'postgresql://outline_adopter:fixture@localhost/camery',data:'postgresql://outline_data:fixture@localhost/camery'};
const project={tenantId:'tenant',readerDatabaseUrl:credentials.reader,adoptionDatabaseUrl:credentials.old};
const outline={tenantId:'tenant',projectId:'project',outlineDatabaseUrl:credentials.data,taskDatabaseUrl:'postgresql://outline_tasks:fixture@localhost/camery',text:null,workerId:'outline-worker',pollMs:1000,runsPerRound:1};
const configuration={tenantId:'tenant',adoptionDatabaseUrl:credentials.adopter};
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'camery-outline-adoption-config-')),file=join(directory,'adopter');await writeFile(file,credentials.adopter+'\n');
  return {directory,file,env:{CAMERY_TENANT_ID:'tenant',CAMERY_OUTLINE_ADOPTION_ENABLED:'1',CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE:file},cleanup:async()=>{await rm(file,{force:true});await rmdir(directory);}};
}
it('keeps the host disabled by default and refuses incomplete, ambiguous or leftover credentials',async()=>{
  expect(await readOutlineAdoptionConfig({})).toBeNull();expect(await readOutlineAdoptionConfig({CAMERY_TENANT_ID:'tenant',CAMERY_OUTLINE_ADOPTION_ENABLED:'0'})).toBeNull();
  for(const env of [{CAMERY_OUTLINE_ADOPTION_ENABLED:'true'},{CAMERY_OUTLINE_ADOPTION_ENABLED:'1'},{CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE:'leftover'}, {CAMERY_OUTLINE_ADOPTION_ENABLED:'0',CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE:'leftover'}, {CAMERY_OUTLINE_ADOPTION_DATABASE_URL:'postgresql://private@elsewhere/secret'}])await expect(readOutlineAdoptionConfig(env)).rejects.toThrow('Invalid Outline adoption configuration');
});
it('captures its own tenant, flag and secret path before yielding and never evaluates a getter',async()=>{
  const f=await fixture();try{
    const pending=readOutlineAdoptionConfig(f.env);f.env.CAMERY_TENANT_ID='changed';f.env.CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE='missing';expect(await pending).toEqual(configuration);
    const getter=vi.fn(()=>credentials.adopter);await expect(readOutlineAdoptionConfig(Object.defineProperty({...f.env},'CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE',{get:getter}))).rejects.toThrow('Invalid Outline adoption configuration');expect(getter).not.toHaveBeenCalled();
  }finally{await f.cleanup();}
});
it('requires a regular bounded fatal UTF-8 secret and strips only one line terminator',async()=>{
  const f=await fixture();try{
    for(const file of ['',f.directory,join(f.directory,'missing')])await expect(readOutlineAdoptionConfig({...f.env,CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE:file})).rejects.toThrow('Invalid Outline adoption configuration');
    for(const body of [Buffer.from([0xff]),'x'.repeat(8193),'https://private.example','postgresql://outline_adopter:fixture@localhost/camery\n\n']){await writeFile(f.file,body);await expect(readOutlineAdoptionConfig(f.env)).rejects.toThrow('Invalid Outline adoption configuration');}
    await writeFile(f.file,credentials.adopter+'\r\n');const value=await readOutlineAdoptionConfig(f.env);expect(value).toEqual(configuration);expect(Object.isFrozen(value)).toBe(true);
  }finally{await f.cleanup();}
});
it('composes only the configured project reader and distinct Outline adopter on the same database authority',()=>{
  const value=resolveOutlineAdoptionDeployment(configuration,project,outline);expect(value).toEqual({tenantId:'tenant',readerDatabaseUrl:credentials.reader,adoptionDatabaseUrl:credentials.adopter});expect(Object.isFrozen(value)).toBe(true);
  expect(resolveOutlineAdoptionDeployment(null,null,null)).toBeNull();
  for(const [projects,outlines] of [[null,outline],[project,null],[{...project,tenantId:'foreign'},outline],[project,{...outline,tenantId:'foreign'}]] as const)expect(()=>resolveOutlineAdoptionDeployment(configuration,projects,outlines)).toThrow('Invalid Outline adoption composition');
});
it.each(['reader','old','data'] as const)('rejects an adopter sharing the actual %s LOGIN after URI decoding',key=>{
  expect(()=>resolveOutlineAdoptionDeployment({tenantId:'tenant',adoptionDatabaseUrl:credentials[key]},project,outline)).toThrow('Invalid Outline adoption composition');
  const duplicate=new URL(credentials[key]);duplicate.username='%'+duplicate.username.charCodeAt(0).toString(16)+duplicate.username.slice(1);expect(()=>resolveOutlineAdoptionDeployment({tenantId:'tenant',adoptionDatabaseUrl:duplicate.href},project,outline)).toThrow('Invalid Outline adoption composition');
});
it.each(['postgresql://outline_adopter:fixture@elsewhere/camery','postgresql://outline_adopter:fixture@localhost:5555/camery','postgresql://outline_adopter:fixture@localhost/another','postgresql://outline_adopter:fixture@localhost/','postgresql://localhost/camery'])('rejects missing or different authority in %s',adoptionDatabaseUrl=>{
  expect(()=>resolveOutlineAdoptionDeployment({tenantId:'tenant',adoptionDatabaseUrl},project,outline)).toThrow('Invalid Outline adoption composition');
});
it('compares default ports and encoded database names while accepting explicit connection-only settings',()=>{
  expect(resolveOutlineAdoptionDeployment({...configuration,adoptionDatabaseUrl:credentials.adopter.replace('/camery',':5432/%63amery')+'?sslmode=require&application_name=outline'},project,outline)).toMatchObject({tenantId:'tenant'});
});
it.each(['host=elsewhere','user=reader','password=private','database=foreign','dbname=foreign','port=6543','options=-c%20role%3Dadmin','sslmode=require&sslmode=disable','unexpected=value'])('rejects URI query authority overrides or ambiguous options: %s',query=>{
  for(const position of ['adopter','reader','outline'] as const){
    const next=credentials[position==='adopter'?'adopter':position==='reader'?'reader':'data']+'?'+query;
    expect(()=>resolveOutlineAdoptionDeployment(position==='adopter'?{...configuration,adoptionDatabaseUrl:next}:configuration,position==='reader'?{...project,readerDatabaseUrl:next}:project,position==='outline'?{...outline,outlineDatabaseUrl:next}:outline)).toThrow('Invalid Outline adoption composition');
  }
});
it('captures composition records and rejects accessors before they become endpoint authority',()=>{
  const getter=vi.fn(()=>credentials.reader);expect(()=>resolveOutlineAdoptionDeployment(configuration,Object.defineProperty({...project},'readerDatabaseUrl',{get:getter}),outline)).toThrow('Invalid Outline adoption composition');expect(getter).not.toHaveBeenCalled();
});
