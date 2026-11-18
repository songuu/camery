import { expect,it } from 'vitest';
import { grantOutlineTaskRuntimeRole,verifyOutlineTaskRuntimeRole } from '../src/outline-task-role.js';
import { grantBibleTaskRuntimeRole,verifyBibleTaskRuntimeRole } from '../src/bible-task-role.js';
it('reuses the exact existing durable/budget ACL without granting outline data or authentication access',()=>{
  expect(grantOutlineTaskRuntimeRole).toBe(grantBibleTaskRuntimeRole);expect(verifyOutlineTaskRuntimeRole).toBe(verifyBibleTaskRuntimeRole);
});
