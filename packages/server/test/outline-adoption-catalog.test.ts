import type {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {PostgresOutlineCandidateCatalog} from '../src/projects/outline-adoption-catalog.js';
import {fixtureId as id} from '../../ir/test/fixtures.js';

const query={scope:{tenantId:'tenant',projectId:'project'},target:{tenantId:id('formal-tenant'),projectId:id('formal-project')},subjectId:'editor'};
const rows=()=>[3,2,1].map(index=>({tenantId:query.scope.tenantId,projectKey:query.scope.projectId,irTenantId:query.target.tenantId,irProjectId:query.target.projectId,candidateId:`0000000000000000000000000${index}`,applicationId:'application-'+index,runId:'run',status:'candidate',authorId:id('editor'),createdAt:'2026-11-18T06:00:00.000Z',baseRevision:1,operationCount:1249}));
function fixture(data:unknown[]=rows()){const call=vi.fn().mockResolvedValue({rows:data}),connect=vi.fn();return {call,connect,catalog:new PostgresOutlineCandidateCatalog({query:call,connect} as unknown as Pool)};}
async function refused(action:Promise<unknown>,code='STORAGE_FAILED'){
  let caught:unknown;try{await action;}catch(error){caught=error;}expect(caught).toMatchObject({name:'ProjectApplicationError',code});expect(String(caught)).not.toContain('private');
}

it('captures an immutable ordinary/formal scope and queries only scalar header hints with a bounded lookahead',async()=>{
  const f=fixture(),input=structuredClone({...query,limit:2}),pending=f.catalog.list(input);input.scope.projectId='mutated';input.target.tenantId=id('mutated');input.subjectId='mutated';const page=await pending;
  expect(page.items).toHaveLength(2);expect(page.items[0]).toEqual({candidateId:rows()[0]!.candidateId,applicationId:'application-3',runId:'run',status:'candidate',authorId:id('editor'),createdAt:'2026-11-18T06:00:00.000Z',baseRevision:1,operationCount:1249});
  expect(page.nextCursor).not.toBeNull();expect(Object.isFrozen(page.items[0])).toBe(true);expect(f.connect).not.toHaveBeenCalled();
  const [sql,parameters]=f.call.mock.calls[0]!;expect(parameters).toEqual(['tenant','project',query.target.tenantId,query.target.projectId,null,null,3]);expect(sql).toContain('LIMIT $7');expect(sql).toContain('COLLATE "C" DESC');expect(sql).toContain('v.tenant_id=c.ir_tenant_id');expect(sql).toContain('v.project_id=c.ir_project_id');expect(sql).toContain('r.intent_digest=c.digest');expect(sql).toContain('jsonb_array_length');expect(sql).not.toMatch(/SELECT\s+(?:c|v|r)\.record(?:\s|,)|SELECT\s+\*/);
});
it('binds continuation to both projects, subject and exact optional run while allowing a different page size',async()=>{
  const f=fixture(),page=await f.catalog.list({...query,limit:2});
  for(const changed of [{...query,scope:{...query.scope,tenantId:'other'}},{...query,scope:{...query.scope,projectId:'other'}},{...query,target:{...query.target,tenantId:id('other')}},{...query,target:{...query.target,projectId:id('other')}},{...query,subjectId:'reviewer'},{...query,runId:'run'}])await refused(f.catalog.list({...changed,cursor:page.nextCursor!}),'INVALID_INPUT');
  expect(f.call).toHaveBeenCalledOnce();f.call.mockResolvedValue({rows:[]});expect(await f.catalog.list({...query,limit:1,cursor:page.nextCursor!})).toEqual({contractVersion:1,items:[],nextCursor:null});expect(f.call.mock.calls[1]![1]).toEqual(['tenant','project',query.target.tenantId,query.target.projectId,null,rows()[1]!.candidateId,2]);
});
it('keeps the source run filter pinned in SQL and in the returned page metadata',async()=>{
  const f=fixture();expect((await f.catalog.list({...query,runId:'run',limit:50})).items).toHaveLength(3);const [sql,parameters]=f.call.mock.calls[0]!;expect(sql).toContain('$5::text IS NULL OR c.run_id=$5');expect(parameters[4]).toBe('run');
  await refused(fixture([{...rows()[0],runId:'other'}]).catalog.list({...query,runId:'run'}));
});
it('returns a terminal empty page and uses the default twenty-row plus-one budget',async()=>{
  const f=fixture([]);expect(await f.catalog.list(query)).toEqual({contractVersion:1,items:[],nextCursor:null});expect(f.call.mock.calls[0]![1][6]).toBe(21);expect(f.connect).not.toHaveBeenCalled();
});
it('does not produce a next cursor when the bounded result contains exactly the selected page',async()=>{
  const f=fixture(rows().slice(0,2));const page=await f.catalog.list({...query,limit:2});expect(page.items).toHaveLength(2);expect(page.nextCursor).toBeNull();
});
it('rejects unknown selectors, invalid limits, missing authority and malformed cursors before any query',async()=>{
  const f=fixture(),getter=vi.fn(()=>{throw new Error('private getter');});
  for(const input of [{...query,limit:0},{...query,limit:51},{...query,limit:1.5},{...query,limit:true},{...query,limit:''},{...query,actorId:id('forged')},{...query,target:undefined},{...query,scope:{...query.scope,projectId:'bad\n'}},{...query,cursor:'x'.repeat(4097)},{...query,cursor:'%%%='},{...query,cursor:Buffer.from('{}').toString('base64url')},Object.defineProperty({...query},'subjectId',{enumerable:true,get:getter})])await refused(f.catalog.list(input as never),'INVALID_INPUT');
  expect(f.call).not.toHaveBeenCalled();expect(getter).not.toHaveBeenCalled();
});
it('rejects records that escape any ordinary or formal project scope',async()=>{
  for(const [field,value] of [['tenantId','other'],['projectKey','other'],['irTenantId',id('other')],['irProjectId',id('other')]] as const)await refused(fixture([{...rows()[0],[field]:value}]).catalog.list(query));
});
it.each(['candidateId','applicationId','runId','authorId','createdAt','baseRevision','operationCount','status'])('rejects invalid stored %s metadata instead of forwarding a broken header',async field=>{
  const invalid:Record<string,unknown[]>={candidateId:['bad','000000000000000000000000000'],applicationId:['','bad\n'],runId:['','bad\n'],authorId:['bad'],createdAt:['not-a-date','2026-11-18T06:00:00Z'],baseRevision:[0,1.5,Number.MAX_SAFE_INTEGER+1,'1'],operationCount:[-1,4097,1.5,null],status:['invented']};
  for(const value of invalid[field]!)await refused(fixture([{...rows()[0],[field]:value}]).catalog.list(query));
});
it('rejects duplicate, ascending, over-lookahead and cursor-overlapping results',async()=>{
  await refused(fixture([rows()[0],rows()[0]]).catalog.list(query));await refused(fixture([...rows()].reverse()).catalog.list(query));await refused(fixture(Array.from({length:52},()=>rows()[0])).catalog.list({...query,limit:50}));
  const f=fixture(),page=await f.catalog.list({...query,limit:2});f.call.mockResolvedValue({rows:[rows()[1]]});await refused(f.catalog.list({...query,limit:2,cursor:page.nextCursor!}));
});
it('rejects invented extra row fields and redacts arbitrary driver failures',async()=>{
  await refused(fixture([{...rows()[0],record:{private:'body'}}]).catalog.list(query));
  const opaque=new Proxy({},{getPrototypeOf(){throw new Error('private prototype');},getOwnPropertyDescriptor(){throw new Error('private descriptor');}});
  for(const error of [new Error('private postgresql://credential'),'private primitive',opaque]){const f=fixture();f.call.mockRejectedValue(error);await refused(f.catalog.list(query));expect(f.connect).not.toHaveBeenCalled();}
});
