import {expect,it,vi} from 'vitest';
import {resolveProjectAuthority} from '../src/projects/authority.js';
import type {SessionIdentity} from '@camery/access';
import {fixtureId as id} from '../../ir/test/fixtures';

const subject=(role:'viewer'|'editor'|'reviewer'|'admin'='reviewer'):SessionIdentity=>({tenantId:'tenant',userId:'reviewer',sessionId:'session',grants:[{projectId:'project',role}]});
const versionKey={tenantId:id('authority-tenant'),projectId:id('authority-project')};
const principal={kind:'user' as const,id:id('authority-user')};
function resolver(){return {resolve:vi.fn(async()=>({scope:{tenantId:'tenant',projectId:'project'},versionKey:{...versionKey},principal:{...principal}}))};}
it('maps a permission-checked real session and binds version actor, project and scope',async()=>{
  const identities=resolver();const authority=await resolveProjectAuthority({identities,subject:subject(),projectId:'project',permission:'candidate:review'});
  expect(identities.resolve).toHaveBeenCalledWith({tenantId:'tenant',projectId:'project',kind:'user',key:'reviewer'});
  expect(authority.versionKey).toEqual(versionKey);expect(authority.principal).toEqual(principal);
  expect(authority.authorize(principal,versionKey,{kind:'project',id:versionKey.projectId})).toBe(true);
  expect(authority.authorize(principal,versionKey,{kind:'episode',id:id('episode')})).toBe(true);
  expect(authority.authorize({kind:'agent_run',id:principal.id},versionKey,{kind:'project',id:versionKey.projectId})).toBe(false);
  expect(authority.authorize({...principal,id:id('someone-else')},versionKey,{kind:'project',id:versionKey.projectId})).toBe(false);
  expect(authority.authorize(principal,{...versionKey,tenantId:id('other-tenant')},{kind:'project',id:versionKey.projectId})).toBe(false);
  expect(authority.authorize(principal,{...versionKey,projectId:id('other-project')},{kind:'project',id:versionKey.projectId})).toBe(false);
  expect(authority.authorize(principal,versionKey,{kind:'project',id:id('other-project')})).toBe(false);
  expect(authority.authorize(principal,versionKey,{kind:'scene',id:'invalid'})).toBe(false);
  expect(Object.isFrozen(authority.principal)).toBe(true);expect(Object.isFrozen(authority.versionKey)).toBe(true);
});
it.each(['viewer','editor'] as const)('denies %s adoption before querying identity bindings',async role=>{
  const identities=resolver();await expect(resolveProjectAuthority({identities,subject:subject(role),projectId:'project',permission:'candidate:review'})).rejects.toMatchObject({code:'FORBIDDEN'});expect(identities.resolve).not.toHaveBeenCalled();
});
it('requires the separate candidate-write permission and exact granted project',async()=>{
  const identities=resolver();await expect(resolveProjectAuthority({identities,subject:subject(),projectId:'project',permission:'candidate:write'})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(resolveProjectAuthority({identities,subject:subject('admin'),projectId:'ungranted',permission:'candidate:review'})).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(identities.resolve).not.toHaveBeenCalled();
  const editor=await resolveProjectAuthority({identities,subject:subject('editor'),projectId:'project',permission:'candidate:write'});expect(editor.principal).toEqual(principal);
  expect(editor.authorize(principal,versionKey,{kind:'project',id:versionKey.projectId})).toBe(false);
});
it('captures host identity before async resolution and ignores later mutable grants',async()=>{
  let finish=()=>{};const gate=new Promise<void>(resolve=>{finish=resolve;});const bound=resolver();const original=subject('admin');const identities={resolve:vi.fn(async()=>{await gate;return bound.resolve();})};
  const pending=resolveProjectAuthority({identities,subject:original,projectId:'project',permission:'candidate:review'});
  (original as {userId:string}).userId='injected';(original.grants[0] as {role:string}).role='viewer';finish();const authority=await pending;
  expect(identities.resolve).toHaveBeenCalledWith({tenantId:'tenant',projectId:'project',kind:'user',key:'reviewer'});expect(authority.authorize(principal,versionKey,{kind:'project',id:versionKey.projectId})).toBe(true);
});
it.each(['scope','principal','key'] as const)('fails closed on corrupt resolved %s',async field=>{
  const bound=await resolver().resolve();if(field==='scope')bound.scope.tenantId='other';if(field==='principal')(bound.principal as {kind:string}).kind='agent_run';if(field==='key')bound.versionKey.projectId='invalid';
  await expect(resolveProjectAuthority({identities:{resolve:async()=>bound},subject:subject(),projectId:'project',permission:'candidate:review'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('propagates explicit missing bindings and rejects self-reported or accessor identity',async()=>{
  const identities={resolve:vi.fn(async()=>{throw Object.assign(new Error('missing'),{code:'PROJECT_BINDING_MISSING'});})};
  await expect(resolveProjectAuthority({identities,subject:subject(),projectId:'project',permission:'candidate:review'})).rejects.toMatchObject({code:'PROJECT_BINDING_MISSING'});
  const getter=vi.fn(()=>{throw new Error('getter must not run');});const unsafe={...subject(),get userId(){return getter();}};
  await expect(resolveProjectAuthority({identities,subject:unsafe,projectId:'project',permission:'candidate:review'})).rejects.toMatchObject({code:'UNAUTHENTICATED'});expect(getter).not.toHaveBeenCalled();
});
