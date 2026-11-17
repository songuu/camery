import { executionForDevelopment } from '@camery/script/node';
import { snapshotEnvironment } from './secret-config.js';
import { readBibleConfig, type BibleTextConfig } from './bible-config.js';

const settings=['ENABLED','PROJECT_ID','DATABASE_URL_FILE','TASK_DATABASE_URL_FILE','TEXT_CONFIG_FILE','TEXT_TOKEN_FILE','WORKER_ID','POLL_MS','RUNS_PER_ROUND'] as const;
const keys=['CAMERY_TENANT_ID',...settings.map(name=>'CAMERY_DEVELOPMENT_'+name)];
export type DevelopmentTextConfig=BibleTextConfig;
export interface DevelopmentDeploymentConfig {
  readonly tenantId:string;readonly projectId:string;readonly developmentDatabaseUrl:string;readonly taskDatabaseUrl:string;
  readonly text:DevelopmentTextConfig|null;readonly workerId:string;readonly pollMs:number;readonly runsPerRound:number;
}
/** Both text workers share the same bounded secret/profile reader; only the workflow budget and model tier differ. */
export async function readDevelopmentConfig(env:Record<string,string|undefined>):Promise<DevelopmentDeploymentConfig|null>{
  try{
    const values=snapshotEnvironment(env,keys);const mapped:Record<string,string|undefined>={CAMERY_TENANT_ID:values['CAMERY_TENANT_ID']};
    for(const name of settings)mapped['CAMERY_BIBLE_'+name]=values['CAMERY_DEVELOPMENT_'+name];
    if(values['CAMERY_DEVELOPMENT_ENABLED']==='1'&&values['CAMERY_DEVELOPMENT_WORKER_ID']===undefined)mapped['CAMERY_BIBLE_WORKER_ID']='development-worker';
    const config=await readBibleConfig(mapped);if(!config)return null;
    if(config.text){
      const text=config.text;
      executionForDevelopment({connectionId:text.connectionId,modelIdentity:text.modelIdentity,modeDigest:text.modeDigest,evidence:'live_model',modelTier:'balanced',
        currency:text.currency,reservation:text.reservation,...(text.pricing?{pricing:text.pricing}:{}),limits:text.limits});
    }
    return Object.freeze({tenantId:config.tenantId,projectId:config.projectId,developmentDatabaseUrl:config.bibleDatabaseUrl,taskDatabaseUrl:config.taskDatabaseUrl,
      text:config.text,workerId:config.workerId,pollMs:config.pollMs,runsPerRound:config.runsPerRound});
  }catch{throw new Error('Invalid Development configuration');}
}
