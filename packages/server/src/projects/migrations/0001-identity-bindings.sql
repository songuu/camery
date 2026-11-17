-- Installation only. A registered project must already exist in the version authority.
CREATE TABLE camery_projects.tenants (
  tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[A-Za-z0-9]' AND tenant_id !~ '[^A-Za-z0-9_.:-]' AND length(tenant_id)<=128),
  ir_tenant_id text NOT NULL UNIQUE CHECK (ir_tenant_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND length(ir_tenant_id)=26),
  UNIQUE (tenant_id,ir_tenant_id)
);
CREATE TABLE camery_projects.projects (
  tenant_id text NOT NULL,
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9]' AND project_id !~ '[^A-Za-z0-9_.:-]' AND length(project_id)<=128),
  ir_tenant_id text NOT NULL,
  ir_project_id text NOT NULL CHECK (ir_project_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND length(ir_project_id)=26),
  PRIMARY KEY (tenant_id,project_id),
  UNIQUE (ir_tenant_id,ir_project_id),
  FOREIGN KEY (tenant_id,ir_tenant_id) REFERENCES camery_projects.tenants(tenant_id,ir_tenant_id),
  FOREIGN KEY (ir_tenant_id,ir_project_id) REFERENCES camery_versioning.projects(tenant_id,project_id)
);
CREATE INDEX project_bindings_tenant_idx ON camery_projects.projects(tenant_id,ir_tenant_id);
CREATE TABLE camery_projects.principals (
  tenant_id text NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('user','agent_run','system')),
  principal_key text NOT NULL CHECK (principal_key ~ '^[A-Za-z0-9]' AND principal_key !~ '[^A-Za-z0-9_.:-]' AND length(principal_key)<=128),
  ir_tenant_id text NOT NULL,
  ir_actor_id text NOT NULL UNIQUE CHECK (ir_actor_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND length(ir_actor_id)=26),
  PRIMARY KEY (tenant_id,principal_kind,principal_key),
  FOREIGN KEY (tenant_id,ir_tenant_id) REFERENCES camery_projects.tenants(tenant_id,ir_tenant_id)
);
CREATE INDEX principal_bindings_tenant_idx ON camery_projects.principals(tenant_id,ir_tenant_id);
