import {expect,it} from 'vitest';
import {z} from 'zod';
import {encodeReadCursor,decodeReadCursor} from '../src/projects/read-cursor.js';
const schema=z.strictObject({snapshotRevision:z.number().int().positive(),beforeVersion:z.number().int().positive()});
const binding={kind:'history',tenantId:'tenant',projectId:'project',actor:'viewer',objectId:'object',collection:'shots'};
it('round-trips a bounded position without treating a cursor as authorization',()=>{const token=encodeReadCursor(binding,{snapshotRevision:4,beforeVersion:8});expect(decodeReadCursor(binding,token,schema)).toEqual({snapshotRevision:4,beforeVersion:8});});
it.each(['tenantId','projectId','actor','objectId','collection','kind'] as const)('rejects cursor reuse after %s changes',field=>{const token=encodeReadCursor(binding,{snapshotRevision:4,beforeVersion:8});expect(()=>decodeReadCursor({...binding,[field]:'different'},token,schema)).toThrowError(expect.objectContaining({code:'INVALID_INPUT'}));});
it('rejects malformed, noncanonical, oversized and unexpected positions safely',()=>{for(const token of ['@','a'.repeat(4097),Buffer.from('{}').toString('base64url'),encodeReadCursor(binding,{snapshotRevision:0,beforeVersion:8}),encodeReadCursor(binding,{snapshotRevision:4,beforeVersion:8,extra:true})])expect(()=>decodeReadCursor(binding,token,schema)).toThrowError(expect.objectContaining({code:'INVALID_INPUT'}));const token=encodeReadCursor(binding,{snapshotRevision:4,beforeVersion:8});expect(()=>decodeReadCursor(binding,token+'=',schema)).toThrowError(expect.objectContaining({code:'INVALID_INPUT'}));});
