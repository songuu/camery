import {StoryboardPackageV07,StoryboardPackageV08,LEGACY_SCHEMA_VERSION,DEVELOPMENT_SCHEMA_VERSION,CONTINUITY_SCHEMA_VERSION} from './schema';
import type {StoryboardPackage} from './schema';
import {validatePackage as validateV06,validateParsedDevelopment,parsedDevelopmentDependencyIssues} from './legacy/v06-validate';
import {validateOutlineGraph} from './outline-validate';
import {validateContinuityGraph} from './continuity-validate';
export {continuityDependencyIssues} from './continuity-validate';
export type {ContinuityDependencyIssue} from './continuity-validate';
import type {ValidationOptions,ValidationReport} from './legacy/v05-validate';
export type {Issue,ValidationOptions,ValidationReport} from './legacy/v05-validate';
export type {DevelopmentDependencyIssue} from './legacy/v06-validate';
export {outlineDependencyIssues} from './outline-validate';
export type {OutlineDependencyIssue} from './outline-validate';
export function developmentDependencyIssues(pkg:StoryboardPackage){return pkg.schema_version===LEGACY_SCHEMA_VERSION?[]:parsedDevelopmentDependencyIssues(pkg);}
export function validatePackage(input:unknown,options:ValidationOptions={}):ValidationReport{
  const version=input!==null&&typeof input==='object'?Object.getOwnPropertyDescriptor(input,'schema_version')?.value:undefined;
  if(version===LEGACY_SCHEMA_VERSION||version===DEVELOPMENT_SCHEMA_VERSION)return validateV06(input,options);
  const parsed=version===CONTINUITY_SCHEMA_VERSION?StoryboardPackageV08.safeParse(input):StoryboardPackageV07.safeParse(input);
  if(!parsed.success)return {valid:false,errors:parsed.error.issues.map(issue=>({code:'SCHEMA',where:'/'+issue.path.join('/'),message:issue.message})),warnings:[],meaning:'仅检查结构、引用、版本和声明；不代表真实模型质量或人工批准。'};
  // Pass the complete graph through existing ID, lock, snapshot and development checks before the outline-specific checks.
  const base=validateParsedDevelopment(parsed.data,options),outline=validateOutlineGraph(parsed.data),continuity=parsed.data.schema_version===CONTINUITY_SCHEMA_VERSION?validateContinuityGraph(parsed.data):{errors:[],warnings:[]},errors=[...base.errors,...outline.errors,...continuity.errors];
  return {...base,valid:errors.length===0,errors,warnings:[...base.warnings,...outline.warnings,...continuity.warnings]};
}
