-- Append-only source-local identities; ordinary project and principal authority remains outside this registry.
CREATE TABLE camery_script.ir_identities (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9]' AND tenant_id !~ '[^A-Za-z0-9_.:-]' AND length(tenant_id)<=128),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9]' AND project_id !~ '[^A-Za-z0-9_.:-]' AND length(project_id)<=128),
  kind text NOT NULL CHECK (kind IN ('development_plan','world','character','relationship','episode','episode_plan')),
  owner_key text NOT NULL CHECK (owner_key ~ '^[A-Za-z0-9]' AND owner_key !~ '[^A-Za-z0-9_.:-]' AND length(owner_key)<=128),
  owner_run_id text,
  local_key text NOT NULL CHECK (local_key ~ '^[A-Za-z0-9]' AND local_key !~ '[^A-Za-z0-9_.-]' AND length(local_key)<=64),
  ir_tenant_id text NOT NULL CHECK (ir_tenant_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND length(ir_tenant_id)=26),
  ir_project_id text NOT NULL CHECK (ir_project_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND length(ir_project_id)=26),
  stable_id text NOT NULL UNIQUE CHECK (stable_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND length(stable_id)=26 AND stable_id<>ir_project_id),
  PRIMARY KEY (tenant_id,project_id,kind,owner_key,local_key),
  FOREIGN KEY (tenant_id,project_id,owner_run_id) REFERENCES camery_script.runs(tenant_id,project_id,run_id),
  CHECK ((kind IN ('world','character','relationship') AND owner_run_id IS NOT NULL AND owner_key=owner_run_id)
    OR (kind IN ('development_plan','episode','episode_plan') AND owner_key='project' AND owner_run_id IS NULL)),
  CHECK ((kind='world' AND local_key='world') OR (kind='development_plan' AND local_key='plan')
    OR (kind IN ('episode','episode_plan') AND local_key ~ '^([1-9]|[1-9][0-9]|100)$') OR kind IN ('character','relationship'))
);
CREATE INDEX development_ir_identities_owner_idx ON camery_script.ir_identities(tenant_id,project_id,owner_run_id);
