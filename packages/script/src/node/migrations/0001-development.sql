CREATE TABLE camery_script.briefs (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9]' AND tenant_id !~ '[^A-Za-z0-9_.:-]' AND length(tenant_id)<=128),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9]' AND project_id !~ '[^A-Za-z0-9_.:-]' AND length(project_id)<=128),
  brief_id text NOT NULL CHECK (brief_id ~ '^[A-Za-z0-9]' AND brief_id !~ '[^A-Za-z0-9_.:-]' AND length(brief_id)<=128),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9]' AND actor_id !~ '[^A-Za-z0-9_.:-]' AND length(actor_id)<=128),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$' AND length(digest)=64),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$' AND length(request_digest)=64),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (tenant_id,project_id,brief_id,revision)
);
CREATE TABLE camery_script.runs (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9]' AND tenant_id !~ '[^A-Za-z0-9_.:-]' AND length(tenant_id)<=128),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9]' AND project_id !~ '[^A-Za-z0-9_.:-]' AND length(project_id)<=128),
  run_id text NOT NULL CHECK (run_id ~ '^[A-Za-z0-9]' AND run_id !~ '[^A-Za-z0-9_.:-]' AND length(run_id)<=128),
  brief_id text NOT NULL CHECK (brief_id ~ '^[A-Za-z0-9]' AND brief_id !~ '[^A-Za-z0-9_.:-]' AND length(brief_id)<=128),
  brief_revision bigint NOT NULL CHECK (brief_revision BETWEEN 1 AND 9007199254740991),
  brief_digest text NOT NULL CHECK (brief_digest ~ '^[a-f0-9]{64}$' AND length(brief_digest)=64),
  methods jsonb NOT NULL CHECK (jsonb_typeof(methods)='object'),
  execution jsonb NOT NULL CHECK (jsonb_typeof(execution)='object'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$' AND length(digest)=64),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$' AND length(request_digest)=64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,brief_id,brief_revision) REFERENCES camery_script.briefs(tenant_id,project_id,brief_id,revision)
);
CREATE INDEX development_runs_catalog_idx ON camery_script.runs
  (tenant_id,project_id,created_at DESC,run_id COLLATE "C" DESC);
CREATE TABLE camery_script.candidates (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9]' AND tenant_id !~ '[^A-Za-z0-9_.:-]' AND length(tenant_id)<=128),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9]' AND project_id !~ '[^A-Za-z0-9_.:-]' AND length(project_id)<=128),
  run_id text NOT NULL CHECK (run_id ~ '^[A-Za-z0-9]' AND run_id !~ '[^A-Za-z0-9_.:-]' AND length(run_id)<=128),
  stage text NOT NULL CHECK (stage IN ('foundation','episodes')),
  upstream_digest text CHECK (upstream_digest ~ '^[a-f0-9]{64}$' AND length(upstream_digest)=64),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$' AND length(digest)=64),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  CHECK ((stage='foundation' AND upstream_digest IS NULL) OR (stage='episodes' AND upstream_digest IS NOT NULL)),
  PRIMARY KEY (tenant_id,project_id,run_id,stage),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_script.runs(tenant_id,project_id,run_id)
);
CREATE TABLE camery_script.reviews (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9]' AND tenant_id !~ '[^A-Za-z0-9_.:-]' AND length(tenant_id)<=128),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9]' AND project_id !~ '[^A-Za-z0-9_.:-]' AND length(project_id)<=128),
  run_id text NOT NULL CHECK (run_id ~ '^[A-Za-z0-9]' AND run_id !~ '[^A-Za-z0-9_.:-]' AND length(run_id)<=128),
  stage text NOT NULL CHECK (stage IN ('foundation','episodes')),
  status text NOT NULL CHECK (status IN ('reviewed','rejected')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$' AND length(request_digest)=64),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$' AND length(digest)=64),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (tenant_id,project_id,run_id,stage),
  FOREIGN KEY (tenant_id,project_id,run_id,stage) REFERENCES camery_script.candidates(tenant_id,project_id,run_id,stage)
);
