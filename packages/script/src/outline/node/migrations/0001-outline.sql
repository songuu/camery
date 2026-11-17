CREATE TABLE camery_outline.briefs (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND tenant_id !~ '[^A-Za-z0-9_.:-]'),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND project_id !~ '[^A-Za-z0-9_.:-]'),
  brief_id text NOT NULL CHECK (brief_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND brief_id !~ '[^A-Za-z0-9_.:-]'),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND actor_id !~ '[^A-Za-z0-9_.:-]'),
  digest text NOT NULL CHECK (length(digest)=64 AND digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (length(request_digest)=64 AND request_digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (tenant_id,project_id,brief_id,revision)
);
CREATE TABLE camery_outline.runs (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL CHECK (run_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND run_id !~ '[^A-Za-z0-9_.:-]'),
  brief_id text NOT NULL,
  brief_revision bigint NOT NULL,
  brief_digest text NOT NULL CHECK (length(brief_digest)=64 AND brief_digest ~ '^[a-f0-9]{64}$'),
  source_digest text NOT NULL CHECK (length(source_digest)=64 AND source_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (length(digest)=64 AND digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (length(request_digest)=64 AND request_digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,brief_id,brief_revision) REFERENCES camery_outline.briefs(tenant_id,project_id,brief_id,revision)
);
CREATE INDEX outline_runs_catalog_idx ON camery_outline.runs(tenant_id,project_id,created_at DESC,run_id COLLATE "C" DESC);
CREATE TABLE camery_outline.candidates (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  digest text NOT NULL CHECK (length(digest)=64 AND digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  PRIMARY KEY (tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_outline.runs(tenant_id,project_id,run_id)
);
CREATE TABLE camery_outline.reviews (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('reviewed','rejected')),
  request_digest text NOT NULL CHECK (length(request_digest)=64 AND request_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (length(digest)=64 AND digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  PRIMARY KEY (tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_outline.candidates(tenant_id,project_id,run_id)
);
