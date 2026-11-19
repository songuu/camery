CREATE SCHEMA camery_compliance;
CREATE TABLE camery_compliance.runs (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  source_candidate_id text NOT NULL,
  source_variant text NOT NULL CHECK (source_variant IN ('candidate','reviewed')),
  reviewed_candidate_id text,
  native_tenant_id text,
  native_project_id text,
  native_change_id text,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=83886080),
  PRIMARY KEY (tenant_id,project_id,run_id),
  CHECK ((source_variant='candidate' AND reviewed_candidate_id IS NULL AND native_change_id IS NULL) OR (source_variant='reviewed' AND reviewed_candidate_id IS NOT NULL AND reviewed_candidate_id=source_candidate_id)),
  CHECK (num_nonnulls(native_tenant_id,native_project_id,native_change_id) IN (0,3)),
  FOREIGN KEY (tenant_id,project_id,source_candidate_id) REFERENCES camery_screenplay.candidates(tenant_id,project_id,candidate_id),
  FOREIGN KEY (tenant_id,project_id,reviewed_candidate_id) REFERENCES camery_screenplay.reviews(tenant_id,project_id,candidate_id),
  FOREIGN KEY (native_tenant_id,native_project_id,native_change_id) REFERENCES camery_screenplay.native_adoptions(formal_tenant_id,formal_project_id,change_id)
);
CREATE INDEX precheck_runs_candidate_idx ON camery_compliance.runs(tenant_id,project_id,source_candidate_id);
CREATE INDEX precheck_runs_review_idx ON camery_compliance.runs(tenant_id,project_id,reviewed_candidate_id);
CREATE INDEX precheck_runs_native_idx ON camery_compliance.runs(native_tenant_id,native_project_id,native_change_id);
CREATE TABLE camery_compliance.batches (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  batch_index integer NOT NULL CHECK (batch_index BETWEEN 0 AND 8191),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=4194304),
  PRIMARY KEY (tenant_id,project_id,run_id,batch_index),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_compliance.runs(tenant_id,project_id,run_id)
);
CREATE TABLE camery_compliance.reviews (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('literal','model')),
  target_index integer NOT NULL,
  model_index integer,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=67108864),
  PRIMARY KEY (tenant_id,project_id,run_id,target_kind,target_index),
  CHECK ((target_kind='literal' AND target_index=-1 AND model_index IS NULL) OR (target_kind='model' AND target_index BETWEEN 0 AND 8191 AND model_index IS NOT NULL AND model_index=target_index)),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_compliance.runs(tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,run_id,model_index) REFERENCES camery_compliance.batches(tenant_id,project_id,run_id,batch_index)
);
CREATE INDEX precheck_reviews_batch_idx ON camery_compliance.reviews(tenant_id,project_id,run_id,model_index);
CREATE TABLE camery_compliance.completions (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=2097152),
  PRIMARY KEY (tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_compliance.runs(tenant_id,project_id,run_id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA camery_compliance FROM PUBLIC;
