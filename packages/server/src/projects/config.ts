import {open} from 'node:fs/promises';
import {z} from 'zod';
import {accessId} from '@camery/access';
import {snapshotEnvironment} from '../secret-config.js';
import {loadServerConfig} from '../config.js';

const fields=['CAMERY_PROJECTS_ENABLED','CAMERY_TENANT_ID','CAMERY_PROJECTS_READER_DATABASE_URL_FILE','CAMERY_PROJECTS_ADOPTION_DATABASE_URL_FILE','CAMERY_PROJECTS_READER_DATABASE_URL','CAMERY_PROJECTS_ADOPTION_DATABASE_URL'] as const;
// oxlint-disable-next-line eslint/no-control-regex -- Reject controls in installer-provided secret paths before opening them.
const path=z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$(?![\s\S])/);
const configuration=z.strictObject({tenantId:accessId,reader:path,adopter:path});
export interface ProjectDeploymentConfig{readonly tenantId:string;readonly readerDatabaseUrl:string;readonly adoptionDatabaseUrl:string}
async function secret(file:string):Promise<string>{
  const handle=await open(file,'r');
  try{if(!(await handle.stat()).isFile())throw new Error();const chunks:Buffer[]=[];for await(const chunk of handle.createReadStream({start:0,end:8192,autoClose:false}))chunks.push(chunk as Buffer);const bytes=Buffer.concat(chunks);if(bytes.length>8192)throw new Error();return new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/\r?\n$/,'');}
  finally{await handle.close();}
}
/** Capture before any asynchronous reads. These database credentials are deployment authority, never HTTP parameters. */
export async function readProjectConfig(env:Record<string,string|undefined>):Promise<ProjectDeploymentConfig|null>{
  try{
    const values=snapshotEnvironment(env,fields);if(values['CAMERY_PROJECTS_READER_DATABASE_URL']!==undefined||values['CAMERY_PROJECTS_ADOPTION_DATABASE_URL']!==undefined)throw new Error();
    const enabled=values['CAMERY_PROJECTS_ENABLED'];if(enabled===undefined||enabled==='0'){if(values['CAMERY_PROJECTS_READER_DATABASE_URL_FILE']!==undefined||values['CAMERY_PROJECTS_ADOPTION_DATABASE_URL_FILE']!==undefined)throw new Error();return null;}if(enabled!=='1')throw new Error();
    const input=configuration.parse({tenantId:values['CAMERY_TENANT_ID'],reader:values['CAMERY_PROJECTS_READER_DATABASE_URL_FILE'],adopter:values['CAMERY_PROJECTS_ADOPTION_DATABASE_URL_FILE']});if(input.reader===input.adopter)throw new Error();
    const readerDatabaseUrl=loadServerConfig({CAMERY_TENANT_ID:input.tenantId,CAMERY_DATABASE_URL:await secret(input.reader)}).databaseUrl;
    const adoptionDatabaseUrl=loadServerConfig({CAMERY_TENANT_ID:input.tenantId,CAMERY_DATABASE_URL:await secret(input.adopter)}).databaseUrl;
    const reader=new URL(readerDatabaseUrl);const adopter=new URL(adoptionDatabaseUrl);
    if(!reader.username||!adopter.username||reader.username===adopter.username||reader.hostname!==adopter.hostname||(reader.port||'5432')!==(adopter.port||'5432')||reader.pathname!==adopter.pathname)throw new Error();
    return Object.freeze({tenantId:input.tenantId,readerDatabaseUrl,adoptionDatabaseUrl});
  }catch{throw new Error('Invalid project configuration');}
}
