import {createDefaultQualityPolicy} from '../src/quality/catalog.js';
import type {QualityCatalogInput,QualityPolicy} from '../src/quality/contracts.js';
export function qualityCatalogFixture(){
  const policy:QualityPolicy=structuredClone(createDefaultQualityPolicy());policy.cliches=[{id:'literal',tier:1,label:'合成提示',literal:'aba',mode:'exact',recognition:'仅检验字面位置，不代表创作结论。',remedy:'结合完整剧情人工核对。'}];policy.naming={blacklistedNames:[],blacklistedSurnames:[],blacklistedCharacters:[],surnamePrefixes:[],distinctPrincipalSurnames:false};
  const input:QualityCatalogInput={scope:{tenantId:'quality-tenant',projectId:'project',taskId:'quality-task',objectId:'episode',sourceDigest:'a'.repeat(64)},texts:[{id:'first',path:'/draft/title',text:'ababa',episodeNumber:1}],names:[]};return {policy,input};
}
