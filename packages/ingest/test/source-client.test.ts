import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { readSourceDocument } from '../src/node/source.js';
import { appendNovelBatch } from '../src/session.js';
import { importFountain, importScriptTable } from '../src/screenplay.js';
import { importDocx } from '../src/node/docx.js';
import { docx } from './fixtures/docx.js';
import { textDigest } from '../src/data.js';

const scope={tenantId:'tenant',projectId:'project',documentId:'source'};
const novel=appendNovelBatch(undefined,{...scope,batchId:'first',expectedRevision:0,text:'第一章 开始\r\n小林😀'});
function client(rows:unknown[]=[]) {
  const query=vi.fn(async (_sql:string,_values:unknown[])=>({rows}));
  return {client:{query} as unknown as PoolClient,query};
}
it('reads the novel on the caller client with SELECT only and no transaction management',async()=>{
  const db=client([{snapshot:novel.snapshot,revision:'1'}]);
  expect(await readSourceDocument(db.client,{...scope,kind:'novel'})).toEqual({document:novel.document,revision:1});
  expect(db.query).toHaveBeenCalledOnce(); const [sql,values]=db.query.mock.calls[0]!;
  expect(sql).toMatch(/^SELECT snapshot/);expect(sql).not.toMatch(/FOR UPDATE|FOR SHARE|BEGIN|COMMIT|ROLLBACK|pg_advisory/);
  expect(values).toEqual(['tenant','project','source']);
});
it.each(['fountain','csv','tsv','docx'] as const)('uses the existing immutable %s decoder, preserving text and original digests',async format=>{
  const bytes=format==='docx'?Buffer.from(docx('<w:p><w:r><w:t>小林😀</w:t></w:r></w:p>')):
    Buffer.from(format==='fountain'?'.内景 车站\n\n@小林\n你好。\n':format==='csv'?'角色,对白\n小林,你好。\n':'角色\t对白\n小林\t你好。\n');
  const document=format==='docx'?await importDocx(bytes):format==='fountain'?importFountain(bytes.toString()):importScriptTable(bytes.toString(),format==='csv'?',':'\t');
  const db=client([{format,title:'来源',original:bytes,original_digest:textDigest(bytes),document}]);
  expect(await readSourceDocument(db.client,{...scope,kind:'script'})).toEqual({document,revision:1});
  expect(db.query).toHaveBeenCalledOnce(); expect(db.query.mock.calls[0]![1]).toEqual(Object.values(scope));
});
it.each([null,{}, {...scope,kind:'unknown'}, {...scope,kind:'novel',readerId:'invented'}, {...scope,kind:'novel',tenantId:'tenant\n'}])('rejects malformed identities before querying %#',async input=>{
  const db=client();await expect(readSourceDocument(db.client,input)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(db.query).not.toHaveBeenCalled();
});
it('rejects accessor identities without executing them',async()=>{
  let reads=0;const raw=Object.defineProperty({...scope,kind:'novel'},'tenantId',{enumerable:true,get(){reads++;throw new Error('private');}});
  const db=client();await expect(readSourceDocument(db.client,raw)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(reads).toBe(0);expect(db.query).not.toHaveBeenCalled();
});
it('captures the source kind and complete scope before the first await',async()=>{
  let release:()=>void=()=>{};const ready=new Promise<void>(resolve=>{release=resolve;});
  const query=vi.fn(async()=>{await ready;return {rows:[{snapshot:novel.snapshot,revision:'1'}]};});
  const raw={...scope,kind:'novel'};const pending=readSourceDocument({query} as unknown as PoolClient,raw);
  raw.tenantId='other';raw.documentId='other';raw.kind='script';release();
  expect((await pending).document).toEqual(novel.document);expect(query).toHaveBeenCalledOnce();
});
it.each(['novel','script'] as const)('reports missing %s separately and redacts driver failures',async kind=>{
  await expect(readSourceDocument(client().client,{...scope,kind})).rejects.toMatchObject({code:'NOT_FOUND'});
  const query=vi.fn(async()=>{throw new Error('sensitive database URL');});
  await expect(readSourceDocument({query} as unknown as PoolClient,{...scope,kind})).rejects.toThrow('Import source document failed (STORAGE_FAILED)');
});
it.each([
  {snapshot:{}},{snapshot:{...novel.snapshot,text:'tampered'}},{snapshot:{...novel.snapshot,tenantId:'other'}},
  {snapshot:{...novel.snapshot,projectId:'other'}},{snapshot:{...novel.snapshot,documentId:'other'}},{snapshot:novel.snapshot,revision:'2'},
])('rejects malformed or scope-mismatched persisted novel rows %#',async row=>{
  await expect(readSourceDocument(client([{revision:'1',...row}]).client,{...scope,kind:'novel'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('rejects script original-byte corruption rather than trusting the candidate JSON',async()=>{
  const bytes=Buffer.from('.内景 车站\n小林\n');const document=importFountain(bytes.toString());
  const base={format:'fountain',title:'来源',original:bytes,original_digest:textDigest(bytes),document};
  for(const row of [{...base,original:Buffer.from('changed')},{...base,original_digest:'f'.repeat(64)},{...base,format:'csv'},{...base,document:{...document,text:'伪造'}}])
    await expect(readSourceDocument(client([row]).client,{...scope,kind:'script'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
