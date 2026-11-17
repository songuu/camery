-- Requests and their receipts are immutable. Receipts are inserted on the version transaction's connection.
CREATE UNIQUE INDEX project_bindings_authority_idx ON camery_projects.projects(tenant_id,project_id,ir_tenant_id,ir_project_id);
CREATE UNIQUE INDEX principal_bindings_authority_idx ON camery_projects.principals(tenant_id,principal_kind,principal_key,ir_actor_id);
CREATE TABLE camery_projects.candidate_intents (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  application_id text NOT NULL CHECK (application_id ~ '^[A-Za-z0-9]' AND application_id !~ '[^A-Za-z0-9_.:-]' AND length(application_id)<=128),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user','agent_run','system')),
  actor_key text NOT NULL,
  ir_actor_id text NOT NULL,
  ir_tenant_id text NOT NULL,
  ir_project_id text NOT NULL,
  change_id text NOT NULL UNIQUE CHECK (change_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND length(change_id)=26),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=1048576),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$' AND length(digest)=64),
  business_digest text NOT NULL CHECK (business_digest ~ '^[a-f0-9]{64}$' AND length(business_digest)=64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (tenant_id,project_id,application_id),
  UNIQUE (tenant_id,project_id,application_id,digest),
  UNIQUE (tenant_id,project_id,change_id),
  FOREIGN KEY (tenant_id,project_id,ir_tenant_id,ir_project_id) REFERENCES camery_projects.projects(tenant_id,project_id,ir_tenant_id,ir_project_id),
  FOREIGN KEY (tenant_id,actor_kind,actor_key,ir_actor_id) REFERENCES camery_projects.principals(tenant_id,principal_kind,principal_key,ir_actor_id)
);
CREATE INDEX candidate_intents_project_authority_idx ON camery_projects.candidate_intents(tenant_id,project_id,ir_tenant_id,ir_project_id);
CREATE INDEX candidate_intents_actor_idx ON camery_projects.candidate_intents(tenant_id,actor_kind,actor_key,ir_actor_id);
CREATE TABLE camery_projects.candidate_receipts (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  application_id text NOT NULL,
  intent_digest text NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=1048576),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$' AND length(digest)=64),
  PRIMARY KEY (tenant_id,project_id,application_id),
  FOREIGN KEY (tenant_id,project_id,application_id,intent_digest) REFERENCES camery_projects.candidate_intents(tenant_id,project_id,application_id,digest)
);
CREATE INDEX candidate_receipts_intent_idx ON camery_projects.candidate_receipts(tenant_id,project_id,application_id,intent_digest);
CREATE TABLE camery_projects.decision_intents (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user','agent_run','system')),
  actor_key text NOT NULL,
  ir_actor_id text NOT NULL,
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9]' AND request_id !~ '[^A-Za-z0-9_.:-]' AND length(request_id)<=128),
  change_id text NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=1048576),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$' AND length(digest)=64),
  business_digest text NOT NULL CHECK (business_digest ~ '^[a-f0-9]{64}$' AND length(business_digest)=64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (tenant_id,project_id,actor_kind,actor_key,request_id),
  UNIQUE (tenant_id,project_id,actor_kind,actor_key,request_id,digest),
  FOREIGN KEY (tenant_id,project_id,change_id) REFERENCES camery_projects.candidate_intents(tenant_id,project_id,change_id),
  FOREIGN KEY (tenant_id,actor_kind,actor_key,ir_actor_id) REFERENCES camery_projects.principals(tenant_id,principal_kind,principal_key,ir_actor_id)
);
CREATE INDEX decision_intents_candidate_idx ON camery_projects.decision_intents(tenant_id,project_id,change_id);
CREATE INDEX decision_intents_actor_idx ON camery_projects.decision_intents(tenant_id,actor_kind,actor_key,ir_actor_id);
CREATE TABLE camery_projects.decision_receipts (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  actor_kind text NOT NULL,
  actor_key text NOT NULL,
  request_id text NOT NULL,
  intent_digest text NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=1048576),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$' AND length(digest)=64),
  PRIMARY KEY (tenant_id,project_id,actor_kind,actor_key,request_id),
  FOREIGN KEY (tenant_id,project_id,actor_kind,actor_key,request_id,intent_digest) REFERENCES camery_projects.decision_intents(tenant_id,project_id,actor_kind,actor_key,request_id,digest)
);
CREATE INDEX decision_receipts_intent_idx ON camery_projects.decision_receipts(tenant_id,project_id,actor_kind,actor_key,request_id,intent_digest);
