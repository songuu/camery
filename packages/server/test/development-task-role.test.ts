import { expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import { grantDevelopmentTaskRuntimeRole,verifyDevelopmentTaskRuntimeRole } from '../src/development-task-role.js';
import { grantBibleTaskRuntimeRole,verifyBibleTaskRuntimeRole } from '../src/bible-task-role.js';
it('shares one exact durable/budget ACL policy and rejects cluster and schema delegation capabilities',async()=>{
  expect(grantDevelopmentTaskRuntimeRole).toBe(grantBibleTaskRuntimeRole);expect(verifyDevelopmentTaskRuntimeRole).toBe(verifyBibleTaskRuntimeRole);
  const query=vi.fn(async(_sql:string)=>({rows:[{allowed:false}]}));
  await expect(verifyDevelopmentTaskRuntimeRole({query} as unknown as Pool)).rejects.toMatchObject({code:'FORBIDDEN'});
  const sql=query.mock.calls[0]![0];expect(sql).toContain('NOT r.rolreplication');expect(sql).toContain("has_schema_privilege(n.oid,'USAGE WITH GRANT OPTION')");
});
