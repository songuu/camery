CREATE TABLE camery_screenplay.generation_runs (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  candidate_id text NOT NULL,
  formal_tenant_id text NOT NULL,
  formal_project_id text NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740991),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=134217728),
  PRIMARY KEY (tenant_id,project_id,run_id),
  UNIQUE (tenant_id,project_id,candidate_id),
  FOREIGN KEY (formal_tenant_id,formal_project_id,source_revision) REFERENCES camery_versioning.snapshots(tenant_id,project_id,revision)
);
CREATE INDEX screenplay_generation_source_idx ON camery_screenplay.generation_runs(formal_tenant_id,formal_project_id,source_revision);
CREATE TABLE camery_screenplay.generation_candidates (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=33554432),
  PRIMARY KEY (tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_screenplay.generation_runs(tenant_id,project_id,run_id)
);
CREATE TABLE camery_screenplay.generation_deliveries (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  candidate_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=16384),
  PRIMARY KEY (tenant_id,project_id,run_id),
  UNIQUE (tenant_id,project_id,candidate_id),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_screenplay.generation_candidates(tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,candidate_id) REFERENCES camery_screenplay.candidates(tenant_id,project_id,candidate_id)
);
REVOKE ALL ON camery_screenplay.generation_runs,camery_screenplay.generation_candidates,camery_screenplay.generation_deliveries FROM PUBLIC;
