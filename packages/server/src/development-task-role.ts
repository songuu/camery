// The two text workers have identical durable/budget capabilities; share one verifier instead of letting ACL policies drift.
export { grantBibleTaskRuntimeRole as grantDevelopmentTaskRuntimeRole,verifyBibleTaskRuntimeRole as verifyDevelopmentTaskRuntimeRole } from './bible-task-role.js';
