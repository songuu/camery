import { outlineExecution } from '@camery/script/outline/node';
import { snapshotEnvironment } from './secret-config.js';
import { readBibleConfig,type BibleTextConfig } from './bible-config.js';

const settings=['ENABLED','PROJECT_ID','DATABASE_URL_FILE','TASK_DATABASE_URL_FILE','TEXT_CONFIG_FILE','TEXT_TOKEN_FILE','WORKER_ID','POLL_MS','RUNS_PER_ROUND'] as const;
const keys=['CAMERY_TENANT_ID',...settings.map(name=>'CAMERY_OUTLINE_'+name)];
export type OutlineTextConfig=BibleTextConfig;
export interface OutlineDeploymentConfig {
  readonly tenantId:string;readonly projectId:string;readonly outlineDatabaseUrl:string;readonly taskDatabaseUrl:string;
  readonly text:OutlineTextConfig|null;readonly workerId:string;readonly pollMs:number;readonly runsPerRound:number;
}
/** Reuse the existing bounded secret reader; outlines require one balanced reservation rather than two development stages. */
export async function readOutlineConfig(env:Record<string,string|undefined>):Promise<OutlineDeploymentConfig|null>{
  try{
    const values=snapshotEnvironment(env,keys),mapped:Record<string,string|undefined>={CAMERY_TENANT_ID:values['CAMERY_TENANT_ID']};
    for(const name of settings)mapped['CAMERY_BIBLE_'+name]=values['CAMERY_OUTLINE_'+name];
    if(values['CAMERY_OUTLINE_ENABLED']==='1'&&values['CAMERY_OUTLINE_WORKER_ID']===undefined)mapped['CAMERY_BIBLE_WORKER_ID']='outline-worker';
    const config=await readBibleConfig(mapped);if(!config)return null;
    if(config.text){
      const text=config.text;
      outlineExecution({connectionId:text.connectionId,modelIdentity:text.modelIdentity,modeDigest:text.modeDigest,evidence:'live_model',modelTier:'balanced',
        currency:text.currency,reservation:text.reservation,...(text.pricing?{pricing:text.pricing}:{}),limits:text.limits});
    }
    return Object.freeze({tenantId:config.tenantId,projectId:config.projectId,outlineDatabaseUrl:config.bibleDatabaseUrl,taskDatabaseUrl:config.taskDatabaseUrl,
      text:config.text,workerId:config.workerId,pollMs:config.pollMs,runsPerRound:config.runsPerRound});
  }catch{throw new Error('Invalid Outline configuration');}
}
