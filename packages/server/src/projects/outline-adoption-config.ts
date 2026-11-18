import {z} from 'zod';
import {accessId} from '@camery/access';
import {snapshotEnvironment} from '../secret-config.js';
import {loadServerConfig} from '../config.js';
import type {OutlineDeploymentConfig} from '../outline-config.js';
import {readProjectDatabaseSecret} from './config.js';
import type {ProjectDeploymentConfig} from './config.js';

export interface OutlineAdoptionConfig{readonly tenantId:string;readonly adoptionDatabaseUrl:string}
export interface OutlineAdoptionDeployment extends OutlineAdoptionConfig{readonly readerDatabaseUrl:string}
const keys=['CAMERY_TENANT_ID','CAMERY_OUTLINE_ADOPTION_ENABLED','CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE','CAMERY_OUTLINE_ADOPTION_DATABASE_URL'] as const;
// oxlint-disable-next-line eslint/no-control-regex -- Deployment paths must be own bounded data before opening a file.
const SecretPath=z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$(?![\s\S])/);
const allowedOptions=new Set(['ssl','sslmode','sslcert','sslkey','sslrootcert','sslpassword','sslnegotiation','application_name','connect_timeout']);
/** pg query parameters can override URL host/user. Compare only explicit authorities and a fixed connection-option allowlist. */
function authority(value:string){
  const url=new URL(value),seen=new Set<string>();
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||url.pathname.length<=1||url.hash)throw new Error();
  for(const [key] of url.searchParams){if(!allowedOptions.has(key)||seen.has(key))throw new Error();seen.add(key);}
  return {user:decodeURIComponent(url.username),host:decodeURIComponent(url.hostname).toLowerCase(),port:url.port||'5432',database:decodeURI(url.pathname.slice(1))};
}
export function assertOutlineAdoptionAuthority(readerUrl:string,adopterUrl:string):void{
  try{const reader=authority(readerUrl),adopter=authority(adopterUrl);if(reader.user===adopter.user||reader.host!==adopter.host||reader.port!==adopter.port||reader.database!==adopter.database)throw new Error();}
  catch{throw new Error('Invalid Outline adoption storage');}
}
export async function readOutlineAdoptionConfig(env:Record<string,string|undefined>):Promise<OutlineAdoptionConfig|null>{
  try{
    const data=snapshotEnvironment(env,keys),enabled=data['CAMERY_OUTLINE_ADOPTION_ENABLED'],file=data['CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE'];
    if(data['CAMERY_OUTLINE_ADOPTION_DATABASE_URL']!==undefined)throw new Error();
    if(enabled===undefined||enabled==='0'){if(file!==undefined)throw new Error();return null;}if(enabled!=='1')throw new Error();
    const tenantId=accessId.parse(data['CAMERY_TENANT_ID']),path=SecretPath.parse(file),adoptionDatabaseUrl=loadServerConfig({CAMERY_TENANT_ID:tenantId,CAMERY_DATABASE_URL:await readProjectDatabaseSecret(path)}).databaseUrl;authority(adoptionDatabaseUrl);
    return Object.freeze({tenantId,adoptionDatabaseUrl});
  }catch{throw new Error('Invalid Outline adoption configuration');}
}
/** Source and version services must name the same database. Separate verified LOGINs keep their capabilities distinct. */
export function resolveOutlineAdoptionDeployment(config:OutlineAdoptionConfig|null,projects:ProjectDeploymentConfig|null,outline:OutlineDeploymentConfig|null):OutlineAdoptionDeployment|null{
  if(config===null)return null;
  try{
    const adopted=snapshotEnvironment(config as unknown as Record<string,string|undefined>,['tenantId','adoptionDatabaseUrl']);
    if(!projects||!outline)throw new Error();
    const project=snapshotEnvironment(projects as unknown as Record<string,string|undefined>,['tenantId','readerDatabaseUrl','adoptionDatabaseUrl']),source=snapshotEnvironment(outline as unknown as Record<string,string|undefined>,['tenantId','outlineDatabaseUrl']);
    const tenantId=accessId.parse(adopted['tenantId']),adoptionDatabaseUrl=loadServerConfig({CAMERY_TENANT_ID:tenantId,CAMERY_DATABASE_URL:adopted['adoptionDatabaseUrl']}).databaseUrl;
    if(project['tenantId']!==tenantId||source['tenantId']!==tenantId)throw new Error();
    const readerDatabaseUrl=loadServerConfig({CAMERY_TENANT_ID:tenantId,CAMERY_DATABASE_URL:project['readerDatabaseUrl']}).databaseUrl;
    assertOutlineAdoptionAuthority(readerDatabaseUrl,adoptionDatabaseUrl);assertOutlineAdoptionAuthority(project['adoptionDatabaseUrl']!,adoptionDatabaseUrl);assertOutlineAdoptionAuthority(source['outlineDatabaseUrl']!,adoptionDatabaseUrl);
    return Object.freeze({tenantId,readerDatabaseUrl,adoptionDatabaseUrl});
  }catch{throw new Error('Invalid Outline adoption composition');}
}
