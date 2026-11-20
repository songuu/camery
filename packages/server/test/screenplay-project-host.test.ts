import {expect,it} from 'vitest';
import type {Role} from '@camery/access';
import {createScreenplayProjectHost} from '../src/projects/screenplay-project-host.js';

const at='2026-11-20T09:00:00.000Z';
function identity(role:Role){return {tenantId:'tenant',userId:'actual-human',sessionId:'session',grants:[{projectId:'project',role}]};}
it.each(['viewer','editor','reviewer','admin'] as const)('binds %s to actual read/finalize permissions rather than the allow flag or human label',role=>{
  const host=createScreenplayProjectHost(identity(role),'tenant','project',at,true);expect(host.actor).toEqual({kind:'human',id:'actual-human'});expect(host.authorize({action:'screenplay:read',scope:host.scope})).toBe(true);
  expect(host.authorize({action:'screenplay:finalize',scope:host.scope})).toBe(role==='reviewer'||role==='admin');
  for(const action of ['screenplay:prepare','screenplay:review'] as const)expect(host.authorize({action,scope:host.scope})).toBe(false);
});
it('keeps the complete captured authority detached and denies a changed scope, unknown action or read-only host',()=>{
  const subject=identity('reviewer'),host=createScreenplayProjectHost(subject,'tenant','project',at,true);subject.userId='later-user';subject.grants[0]!.role='viewer';
  expect(host.actor.id).toBe('actual-human');expect(host.authorize({action:'screenplay:finalize',scope:{tenantId:'tenant',projectId:'project'}})).toBe(true);expect(Object.isFrozen(host)).toBe(true);expect(Object.isFrozen(host.scope)).toBe(true);
  for(const scope of [{tenantId:'other',projectId:'project'},{tenantId:'tenant',projectId:'other'}])expect(host.authorize({action:'screenplay:read',scope})).toBe(false);
  const reader=createScreenplayProjectHost(identity('reviewer'),'tenant','project',at,false);expect(reader.authorize({action:'screenplay:finalize',scope:reader.scope})).toBe(false);
});
it('checks each new request and refuses cross-tenant, revoked access and malformed time before source work',()=>{
  expect(()=>createScreenplayProjectHost(identity('reviewer'),'other','project',at,true)).toThrow(expect.objectContaining({code:'FORBIDDEN'}));
  expect(()=>createScreenplayProjectHost({...identity('reviewer'),grants:[]},'tenant','project',at,true)).toThrow(expect.objectContaining({code:'FORBIDDEN'}));
  expect(()=>createScreenplayProjectHost(identity('reviewer'),'tenant','project','invalid',true)).toThrow(expect.objectContaining({code:'INVALID_INPUT'}));
  const revoked=createScreenplayProjectHost(identity('viewer'),'tenant','project',at,true);expect(revoked.authorize({action:'screenplay:finalize',scope:revoked.scope})).toBe(false);
});
