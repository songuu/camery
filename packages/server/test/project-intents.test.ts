import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {PostgresProjectIntents} from '../src/projects/intent-store.js';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';
import {adoptChangeSet,createVersionState,rejectChangeSet,submitChangeSet} from '@camery/versioning';
import type {CandidateIntentBody,DecisionIntentBody,CandidateIntent,DecisionIntent} from '../src/projects/intent-contracts.js';
import {mappingFixture} from '../../script/test/development-mapping-fixture.js';

const scope={tenantId:'tenant',projectId:'project'};
function candidate():CandidateIntentBody{return {version:1,scope,applicationId:'application',actor:{kind:'user',key:'editor',id:id('user_1')},target:{tenantId:id('tenant'),projectId:id('prj_demo')},commandDigest:'a'.repeat(64),source:{kind:'manual'},expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1},changeId:id('intent-change'),request:changeSet([{op:'update',op_id:id('intent-op'),collection:'shots',target:id('sh_1'),set:{action:'Reviewed intent'}}],{id:id('intent-change'),base_revisions:[{id:id('sh_1'),version:1}]})};}
function decision():DecisionIntentBody{return {version:1,scope,requestId:'decision',actor:{kind:'user',key:'reviewer',id:id('reviewer')},changeId:id('intent-change'),action:'reject',adoptionScope:{kind:'project',id:id('prj_demo')},expectation:{expectedSnapshotRevision:5,expectedWriteVersion:2},reason:'Requires another review',at:'2026-11-17T06:00:00.000Z'};}
const preparationContext=(intent:CandidateIntent)=>({operation:'submit' as const,project:intent.target,expectation:intent.expectation,requestSignature:JSON.stringify(intent.request)});
const rejectionContext=(intent:DecisionIntent,candidate:CandidateIntent)=>({operation:'reject' as const,project:candidate.target,expectation:intent.expectation,changeId:intent.changeId,actor:{kind:intent.actor.kind,id:intent.actor.id},scope:intent.adoptionScope,at:intent.at,reason:intent.reason!});
function database(){
  const rows=new Map<string,unknown>();const statements:string[]=[];const events=new EventEmitter();
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    statements.push(sql);
    if(sql.startsWith('INSERT INTO camery_projects.candidate_intents')||sql.startsWith('INSERT INTO camery_projects.decision_intents')){
      const body=JSON.parse(values.at(-3) as string);const row={record:body,digest:values.at(-2),business_digest:values.at(-1),created_at:new Date('2026-11-17T06:00:00.000Z'),tenant_id:body.scope.tenantId,project_id:body.scope.projectId,actor_kind:body.actor.kind,actor_key:body.actor.key,ir_actor_id:body.actor.id,application_id:body.applicationId,request_id:body.requestId,change_id:body.changeId,ir_tenant_id:body.target?.tenantId,ir_project_id:body.target?.projectId};rows.set(sql.includes('candidate_intents')?'candidate':'decision',row);return {rows:[row]};
    }
    if(sql.startsWith('SELECT')&&sql.includes('camery_projects.candidate_intents'))return {rows:rows.has('candidate')?[rows.get('candidate')]:[]};
    if(sql.startsWith('SELECT')&&sql.includes('camery_projects.decision_intents'))return {rows:rows.has('decision')?[rows.get('decision')]:[]};
    if(sql.startsWith('SELECT')&&sql.includes('camery_projects.candidate_receipts'))return {rows:rows.has('preparation')?[rows.get('preparation')]:[]};
    if(sql.startsWith('SELECT')&&sql.includes('camery_projects.decision_receipts'))return {rows:rows.has('receipt')?[rows.get('receipt')]:[]};
    if(sql.startsWith('INSERT INTO camery_projects.candidate_receipts')||sql.startsWith('INSERT INTO camery_projects.decision_receipts')){const key=sql.includes('candidate_receipts')?'preparation':'receipt';if(rows.has(key))return {rows:[]};const row={record:JSON.parse(values.at(-2) as string),digest:values.at(-1),intent_digest:values.at(-3)};rows.set(key,row);return {rows:[row]};}
    return {rows:[]};
  });
  const release=vi.fn();const client=Object.assign(events,{query,release});const pool={query,connect:vi.fn(async()=>client)} as unknown as Pool;return {pool,client,rows,query,release,statements,store:new PostgresProjectIntents(pool)};
}
it('captures an immutable candidate intent and preserves first IDs under same-command producer races',async()=>{
  const db=database();const original=candidate();const first=await db.store.putCandidate(original);expect(first.request?.id).toBe(original.changeId);expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  const second=candidate();second.changeId=id('second-change');second.request!.id=second.changeId;second.request!.ops[0]!.op_id=id('second-op');
  expect(await db.store.putCandidate(second)).toEqual(first);expect(db.statements.filter(sql=>sql.startsWith('INSERT INTO camery_projects.candidate_intents'))).toHaveLength(1);
});
it.each(['actor','command','content'] as const)('rejects changed %s without overwriting a prepared candidate',async field=>{
  const db=database();await db.store.putCandidate(candidate());const changed=candidate();if(field==='actor')changed.actor.key='someone';if(field==='command')changed.commandDigest='b'.repeat(64);if(field==='content'&&changed.request!.ops[0]!.op==='update')changed.request!.ops[0]!.set.action='Changed';
  await expect(db.store.putCandidate(changed)).rejects.toMatchObject({code:'CONFLICT'});expect(db.statements.filter(sql=>sql.startsWith('INSERT INTO camery_projects.candidate_intents'))).toHaveLength(1);
});
it('preserves a first decision timestamp, scope and reason under exact retry',async()=>{
  const db=database();await db.store.putCandidate(candidate());const first=await db.store.putDecision(decision());const retry=decision();retry.at='2026-11-17T06:00:01.000Z';expect(await db.store.putDecision(retry)).toEqual(first);
  const changed=decision();changed.reason='Different reason';await expect(db.store.putDecision(changed)).rejects.toMatchObject({code:'CONFLICT'});
});
it('rejects malformed/getter candidate input before checkout and redacts raw driver errors',async()=>{
  const db=database();const getter=vi.fn(()=>{throw new Error('secret');});const unsafe={...candidate(),get request(){return getter();}};await expect(db.store.putCandidate(unsafe)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(getter).not.toHaveBeenCalled();expect((db.pool.connect as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  db.query.mockRejectedValue(new Error('postgresql://secret@private'));await expect(db.store.findCandidate({scope,applicationId:'application'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('writes the actual preparation receipt only on the supplied version transaction client',async()=>{
  const db=database();const intent=await db.store.putCandidate(candidate());const write=db.store.preparationReceiptWriter(intent);const result={...submitChangeSet(createVersionState(makePackage()),intent.request),writeVersion:2};
  const before=db.statements.length;await write(db.client as never,result,preparationContext(intent));const calls=db.statements.slice(before);expect(calls.some(sql=>sql.startsWith('INSERT INTO camery_projects.candidate_receipts'))).toBe(true);expect(calls).not.toContain('COMMIT');expect(calls).not.toContain('BEGIN');
  expect((await db.store.readPreparationReceipt({scope,applicationId:'application'}))?.status).toBe('candidate');
});
it('validates stored intent and receipt digests before returning historical evidence',async()=>{
  const db=database();const intent=await db.store.putCandidate(candidate());(db.rows.get('candidate') as {digest:string}).digest='0'.repeat(64);await expect(db.store.findCandidate({scope,applicationId:'application'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const other=database();const valid=await other.store.putCandidate(candidate());await other.store.preparationReceiptWriter(valid)(other.client as never,{...submitChangeSet(createVersionState(makePackage()),valid.request),writeVersion:2},preparationContext(valid));(other.rows.get('preparation') as {digest:string}).digest=intent.digest;
  await expect(other.store.readPreparationReceipt({scope,applicationId:'application'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('records and reads an actual rejected decision on the supplied transaction without allocating another connection',async()=>{
  const db=database();const intent=await db.store.putCandidate(candidate());const command=await db.store.putDecision(decision());const state=submitChangeSet(createVersionState(makePackage()),intent.request).state;
  const rejected=rejectChangeSet(state,intent.changeId,{actor:{kind:'user',id:command.actor.id},scope:command.adoptionScope,at:command.at,authorize:()=>true},command.reason!);
  const callsBefore=(db.pool.connect as ReturnType<typeof vi.fn>).mock.calls.length;await db.store.decisionReceiptWriter(command,intent)(db.client as never,{...rejected,writeVersion:3},rejectionContext(command,intent));expect((db.pool.connect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  expect((await db.store.readDecisionReceipt({scope,actorKind:'user',actorKey:'reviewer',requestId:'decision'}))?.rejection).toEqual({actor_id:command.actor.id,reason:command.reason,at:command.at});expect(await db.store.findDecision({scope,actorKind:'user',actorKey:'reviewer',requestId:'decision'})).toEqual(command);
});
it('returns null for absent records and never allocates an identity or writes during lookup',async()=>{
  const db=database();expect(await db.store.findCandidate({scope,applicationId:'absent'})).toBeNull();expect(await db.store.candidateForChange({scope,changeId:id('absent')})).toBeNull();expect(await db.store.findDecision({scope,actorKind:'user',actorKey:'reviewer',requestId:'absent'})).toBeNull();expect(await db.store.readPreparationReceipt({scope,applicationId:'absent'})).toBeNull();expect(await db.store.readDecisionReceipt({scope,actorKind:'user',actorKey:'reviewer',requestId:'absent'})).toBeNull();expect(db.statements.every(sql=>sql.startsWith('SELECT'))).toBe(true);
});
it('preserves the first preparation receipt after a candidate is adopted instead of fabricating a new original acknowledgement',async()=>{
  const db=database();const intent=await db.store.putCandidate(candidate());const submitted=submitChangeSet(createVersionState(makePackage()),intent.request);await db.store.preparationReceiptWriter(intent)(db.client as never,{...submitted,writeVersion:2},preparationContext(intent));const first=await db.store.readPreparationReceipt({scope,applicationId:intent.applicationId});
  const adopted=adoptChangeSet(submitted.state,intent.changeId,{actor:{kind:'user',id:id('reviewer')},scope:{kind:'project',id:id('prj_demo')},at:'2026-11-17T06:00:00.000Z',authorize:()=>true});await db.store.preparationReceiptWriter(intent)(db.client as never,{...adopted,writeVersion:3},preparationContext(intent));expect(await db.store.readPreparationReceipt({scope,applicationId:intent.applicationId})).toEqual(first);
});
it.each(['actor_key','ir_actor_id','ir_tenant_id','change_id'] as const)('rejects stored column/record disagreement for %s even with an intact record digest',async field=>{
  const db=database();await db.store.putCandidate(candidate());(db.rows.get('candidate') as Record<string,unknown>)[field]='inconsistent';await expect(db.store.findCandidate({scope,applicationId:'application'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('rejects invalid candidate and decision bindings before checkout or receipt writing',async()=>{
  const db=database();const invalid=candidate();invalid.request!.author.id=id('different');await expect(db.store.putCandidate(invalid)).rejects.toMatchObject({code:'INVALID_INPUT'});expect((db.pool.connect as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  await db.store.putCandidate(candidate());const wrong=decision();wrong.adoptionScope.id=id('another-project');await expect(db.store.putDecision(wrong)).rejects.toMatchObject({code:'CONFLICT'});
  const nullReason=decision();nullReason.reason=null;await expect(db.store.putDecision(nullReason)).rejects.toMatchObject({code:'INVALID_INPUT'});
  const missing=database();await expect(missing.store.putDecision(decision())).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('does not invoke unknown error code getters or expose arbitrary driver exceptions',async()=>{
  const db=database();const getter=vi.fn(()=>{throw new Error('private driver context');});const error={get code(){return getter();}};db.query.mockRejectedValueOnce(error);
  await expect(db.store.putCandidate(candidate())).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(getter).not.toHaveBeenCalled();expect(db.release).toHaveBeenCalled();expect(db.client.listenerCount('error')).toBe(0);
});
it('captures receipt factories and rejects a mismatched actual version request before writing a receipt',async()=>{
  const db=database();const intent=await db.store.putCandidate(candidate());const write=db.store.preparationReceiptWriter(intent);const wrong=submitChangeSet(createVersionState(makePackage()),changeSet([{op:'update',op_id:id('different-op'),collection:'shots',target:id('sh_1'),set:{action:'different'}}],{id:intent.changeId,base_revisions:[{id:id('sh_1'),version:1}]}));
  await expect(write(db.client as never,{...wrong,writeVersion:2},preparationContext(intent))).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.rows.has('preparation')).toBe(false);
  const bad={...intent,digest:'0'.repeat(64)};expect(()=>db.store.preparationReceiptWriter(bad)).toThrowError();
});
it('persists an unchanged development intent relative to its frozen baseline without creating an empty ChangeSet',async()=>{
  const db=database();const source=await mappingFixture();const body:CandidateIntentBody={...candidate(),scope:{tenantId:source.source.tenantId,projectId:source.source.projectId},target:source.identities.target,source:{kind:'development',mapperVersion:1,source:source.source,identities:source.identities,reviewers:source.reviewers},request:null};
  const stored=await db.store.putCandidate(body);const receipt=await db.store.readPreparationReceipt({scope:body.scope,applicationId:body.applicationId});expect(receipt?.status).toBe('unchanged');expect(receipt?.snapshotRevision).toBe(body.expectation.expectedSnapshotRevision);expect(stored.request).toBeNull();expect(db.statements.filter(sql=>sql.startsWith('INSERT INTO camery_projects.candidate_receipts'))).toHaveLength(1);
  const invalid=structuredClone(body);if(invalid.source.kind==='development')invalid.source.source.projectId='another';await expect(database().store.putCandidate(invalid)).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(database().store.putCandidate({...body,request:candidate().request})).rejects.toMatchObject({code:'INVALID_INPUT'});
});
it('rejects a request above the explicit ChangeSet byte budget before checking out storage',async()=>{
  const db=database();const body=candidate();if(body.request!.ops[0]!.op==='update')body.request!.ops[0]!.set.action='x'.repeat(524288);await expect(db.store.putCandidate(body)).rejects.toMatchObject({code:'INPUT_LIMIT'});expect((db.pool.connect as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
});
it('captures the original command before an asynchronous connection is acquired',async()=>{
  const db=database();let finish=()=>{};const gate=new Promise<void>(resolve=>{finish=resolve;});const connect=vi.fn(async()=>{await gate;return db.client;});const store=new PostgresProjectIntents({connect} as unknown as Pool);
  const body=candidate();const pending=store.putCandidate(body);body.actor.key='injected';if(body.request!.ops[0]!.op==='update')body.request!.ops[0]!.set.action='Injected after capture';finish();const stored=await pending;expect(stored.actor.key).toBe('editor');expect(stored.request!.ops[0]).toMatchObject({set:{action:'Reviewed intent'}});
});
it('destroys an unavailable rollback connection and safely reports release and checkout failures',async()=>{
  const db=database();db.query.mockRejectedValueOnce(new Error('private begin')).mockRejectedValueOnce(new Error('private rollback'));await expect(db.store.putCandidate(candidate())).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.release).toHaveBeenCalledWith(true);expect(db.client.listenerCount('error')).toBe(0);
  const release=database();release.release.mockImplementation(()=>{throw new Error('private release');});await expect(release.store.putCandidate(candidate())).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const checkout=database();(checkout.pool.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('private checkout'));await expect(checkout.store.putDecision(decision())).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('rejects duplicate driver rows and wrong receipt-intent associations instead of choosing arbitrary evidence',async()=>{
  const db=database();await db.store.putCandidate(candidate());const row=db.rows.get('candidate');db.query.mockResolvedValueOnce({rows:[row,row]});await expect(db.store.findCandidate({scope,applicationId:'application'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const other=database();const intent=await other.store.putCandidate(candidate());await other.store.preparationReceiptWriter(intent)(other.client as never,{...submitChangeSet(createVersionState(makePackage()),intent.request),writeVersion:2},preparationContext(intent));(other.rows.get('preparation') as {intent_digest:string}).intent_digest='f'.repeat(64);await expect(other.store.readPreparationReceipt({scope,applicationId:'application'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('cannot bind a frozen reject intent to a different successful action or reason',async()=>{
  const db=database();const candidateIntent=await db.store.putCandidate(candidate());const command=await db.store.putDecision(decision());const submitted=submitChangeSet(createVersionState(makePackage()),candidateIntent.request);
  const adopted=adoptChangeSet(submitted.state,candidateIntent.changeId,{actor:{kind:'user',id:command.actor.id},scope:command.adoptionScope,at:command.at,authorize:()=>true});
  await expect(db.store.decisionReceiptWriter(command,candidateIntent)(db.client as never,{...adopted,writeVersion:3},{operation:'adopt',project:candidateIntent.target,expectation:command.expectation,changeId:command.changeId,actor:{kind:'user',id:command.actor.id},scope:command.adoptionScope,at:command.at,replayed:false})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.rows.has('receipt')).toBe(false);
});
it('cannot create a successful adoption receipt without an authoritative adoption record',async()=>{
  const db=database();const intent=await db.store.putCandidate(candidate());const submitted=submitChangeSet(createVersionState(makePackage()),intent.request);const adopted=adoptChangeSet(submitted.state,intent.changeId,{actor:{kind:'user',id:id('reviewer')},scope:{kind:'project',id:id('prj_demo')},at:'2026-11-17T06:00:00.000Z',authorize:()=>true});adopted.state.adoptions=[];
  await expect(db.store.preparationReceiptWriter(intent)(db.client as never,{...adopted,writeVersion:3},preparationContext(intent))).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.rows.has('preparation')).toBe(false);
});
it.each([false,true])('binds an actual adoption receipt and preserves historical evidence when replayed=%s',async replayed=>{
  const db=database();const candidateIntent=await db.store.putCandidate(candidate());const body=decision();body.action='adopt';body.reason=null;if(replayed)body.at='2026-11-17T06:00:01.000Z';const command=await db.store.putDecision(body);const submitted=submitChangeSet(createVersionState(makePackage()),candidateIntent.request);
  const adopted=adoptChangeSet(submitted.state,candidateIntent.changeId,{actor:{kind:'user',id:command.actor.id},scope:command.adoptionScope,at:replayed?'2026-11-17T06:00:00.000Z':command.at,authorize:()=>true});
  await db.store.decisionReceiptWriter(command,candidateIntent)(db.client as never,{...adopted,writeVersion:3},{operation:'adopt',project:candidateIntent.target,expectation:command.expectation,changeId:command.changeId,actor:{kind:'user',id:command.actor.id},scope:command.adoptionScope,at:command.at,replayed});expect((await db.store.readDecisionReceipt({scope,actorKind:'user',actorKey:'reviewer',requestId:'decision'}))?.adoption).toEqual(adopted.state.adoptions[0]);
});
it.each(['actor','scope','at','reason'] as const)('requires the real execution %s to match the frozen rejection before receipt insertion',async field=>{
  const db=database();const candidateIntent=await db.store.putCandidate(candidate());const command=await db.store.putDecision(decision());const submitted=submitChangeSet(createVersionState(makePackage()),candidateIntent.request);const result=rejectChangeSet(submitted.state,candidateIntent.changeId,{actor:{kind:'user',id:command.actor.id},scope:command.adoptionScope,at:command.at,authorize:()=>true},command.reason!);
  const context=rejectionContext(command,candidateIntent);if(field==='actor')context.actor={kind:'user',id:id('another')};if(field==='scope')context.scope={kind:'project',id:id('other-project')};if(field==='at')context.at='2026-11-17T06:00:01.000Z';if(field==='reason')context.reason='Different';
  await expect(db.store.decisionReceiptWriter(command,candidateIntent)(db.client as never,{...result,writeVersion:3},context)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.rows.has('receipt')).toBe(false);
});
it.each(['tenant','project','snapshot','write','request'] as const)('refuses a preparation receipt for a different actual %s',async field=>{
  const db=database();const intent=await db.store.putCandidate(candidate());const result=submitChangeSet(createVersionState(makePackage()),intent.request);const context=preparationContext(intent);
  if(field==='tenant')context.project={...context.project,tenantId:id('other-tenant')};if(field==='project')context.project={...context.project,projectId:id('other-project')};if(field==='snapshot')context.expectation={...context.expectation,expectedSnapshotRevision:99};if(field==='write')context.expectation={...context.expectation,expectedWriteVersion:99};if(field==='request')context.requestSignature=JSON.stringify({...intent.request,id:id('other-change')});
  await expect(db.store.preparationReceiptWriter(intent)(db.client as never,{...result,writeVersion:2},context)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.rows.has('preparation')).toBe(false);
});
it('never preserves a failed first decision receipt while committing a new successful decision under that same intent',async()=>{
  const db=database();const candidateIntent=await db.store.putCandidate(candidate());const body=decision();body.action='adopt';body.reason=null;const intent=await db.store.putDecision(body);const submitted=submitChangeSet(createVersionState(makePackage()),candidateIntent.request);const options={actor:{kind:'user' as const,id:intent.actor.id},scope:intent.adoptionScope,at:intent.at,authorize:()=>false};const denied=adoptChangeSet(submitted.state,candidateIntent.changeId,options);
  const context={operation:'adopt' as const,project:candidateIntent.target,expectation:intent.expectation,changeId:intent.changeId,actor:options.actor,scope:options.scope,at:options.at,replayed:false};await db.store.decisionReceiptWriter(intent,candidateIntent)(db.client as never,{...denied,writeVersion:2},context);const first=await db.store.readDecisionReceipt({scope,actorKind:'user',actorKey:'reviewer',requestId:'decision'});
  const adopted=adoptChangeSet(submitted.state,candidateIntent.changeId,{...options,authorize:()=>true});await expect(db.store.decisionReceiptWriter(intent,candidateIntent)(db.client as never,{...adopted,writeVersion:3},context)).rejects.toMatchObject({code:'CONFLICT'});expect(await db.store.readDecisionReceipt({scope,actorKind:'user',actorKey:'reviewer',requestId:'decision'})).toEqual(first);
});
it('distinguishes a persisted command without a receipt from a missing command',async()=>{
  const db=database();await db.store.putCandidate(candidate());await db.store.putDecision(decision());expect(await db.store.readPreparationReceipt({scope,applicationId:'application'})).toBeNull();expect(await db.store.readDecisionReceipt({scope,actorKind:'user',actorKey:'reviewer',requestId:'decision'})).toBeNull();
});
it.each(['digest','column','time'] as const)('refuses corrupt stored decision %s before returning or retrying it',async field=>{
  const db=database();await db.store.putCandidate(candidate());await db.store.putDecision(decision());const row=db.rows.get('decision') as Record<string,unknown>;if(field==='digest')row.digest='0'.repeat(64);if(field==='column')row.actor_key='someone-else';if(field==='time')row.created_at='2026-11-17T06:00:00Z';await expect(db.store.findDecision({scope,actorKind:'user',actorKey:'reviewer',requestId:'decision'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('never commits an intent after its checked-out connection emits an error',async()=>{
  const db=database();db.query.mockImplementationOnce(async()=>{db.client.emit('error',new Error('private connection'));return {rows:[]};});await expect(db.store.putCandidate(candidate())).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.statements).not.toContain('COMMIT');expect(db.release).toHaveBeenCalledWith(true);expect(db.client.listenerCount('error')).toBe(0);
});
it.each(['23503','23505'])('classifies SQLSTATE %s as a binding or identity conflict without raw driver text',async code=>{
  const db=database();db.query.mockRejectedValueOnce(Object.assign(new Error('private database detail'),{code}));await expect(db.store.putCandidate(candidate())).rejects.toMatchObject({code:'CONFLICT'});expect(db.release).toHaveBeenCalled();
});
it('rejects an oversized outer intent envelope before checkout and rejects manual unchanged claims',async()=>{
  const db=database();const body=candidate();if(body.request!.ops[0]!.op==='update')body.request!.ops[0]!.set.action='x'.repeat(1048576);await expect(db.store.putCandidate(body)).rejects.toMatchObject({code:'INPUT_LIMIT'});await expect(db.store.putCandidate({...candidate(),request:null})).rejects.toMatchObject({code:'INVALID_INPUT'});expect((db.pool.connect as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
});
it('rejects cross-phase and wrong-change receipt writers even when a real candidate result is available',async()=>{
  const db=database();const candidateIntent=await db.store.putCandidate(candidate());const command=await db.store.putDecision(decision());const submitted=submitChangeSet(createVersionState(makePackage()),candidateIntent.request);const context=rejectionContext(command,candidateIntent);
  await expect(db.store.preparationReceiptWriter(candidateIntent)(db.client as never,{...submitted,writeVersion:2},context)).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(db.store.decisionReceiptWriter(command,candidateIntent)(db.client as never,{...submitted,writeVersion:2},{...context,changeId:id('other-change')})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.rows.has('preparation')).toBe(false);expect(db.rows.has('receipt')).toBe(false);
});
it('verifies rejection facts in addition to matching execution metadata',async()=>{
  const db=database();const candidateIntent=await db.store.putCandidate(candidate());const command=await db.store.putDecision(decision());const submitted=submitChangeSet(createVersionState(makePackage()),candidateIntent.request);const rejected=rejectChangeSet(submitted.state,candidateIntent.changeId,{actor:{kind:'user',id:command.actor.id},scope:command.adoptionScope,at:command.at,authorize:()=>true},'A different actual rejection');
  await expect(db.store.decisionReceiptWriter(command,candidateIntent)(db.client as never,{...rejected,writeVersion:3},rejectionContext(command,candidateIntent))).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.rows.has('receipt')).toBe(false);
});
it('cannot label an adoption by another actual actor as a first execution of the saved intent',async()=>{
  const db=database();const candidateIntent=await db.store.putCandidate(candidate());const body=decision();body.action='adopt';body.reason=null;const command=await db.store.putDecision(body);const submitted=submitChangeSet(createVersionState(makePackage()),candidateIntent.request);const adopted=adoptChangeSet(submitted.state,candidateIntent.changeId,{actor:{kind:'user',id:id('another-adopter')},scope:command.adoptionScope,at:command.at,authorize:()=>true});
  const context={operation:'adopt' as const,project:candidateIntent.target,expectation:command.expectation,changeId:command.changeId,actor:{kind:'user' as const,id:command.actor.id},scope:command.adoptionScope,at:command.at,replayed:false};await expect(db.store.decisionReceiptWriter(command,candidateIntent)(db.client as never,{...adopted,writeVersion:3},context)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.rows.has('receipt')).toBe(false);
});
it('redacts unknown primitive and proxy exceptions without evaluating prototype or descriptor traps outside the safe boundary',async()=>{
  const opaque=new Proxy({},{getPrototypeOf(){throw new Error('private prototype trap');},getOwnPropertyDescriptor(){throw new Error('private descriptor trap');}});
  for(const error of ['private primitive',opaque]){const db=database();db.query.mockRejectedValueOnce(error);await expect(db.store.putCandidate(candidate())).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.release).toHaveBeenCalled();}
});
