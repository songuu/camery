CREATE TABLE camery_bible.runs (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  document_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('novel','script')),
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  method jsonb NOT NULL CHECK (jsonb_typeof(method) = 'object'),
  execution jsonb NOT NULL CHECK (jsonb_typeof(execution) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,project_id,run_id)
);
CREATE TABLE camery_bible.chunks (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  chunk_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (tenant_id,project_id,run_id,chunk_id),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_bible.runs
);
CREATE TABLE camery_bible.candidates (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  candidate jsonb NOT NULL CHECK (jsonb_typeof(candidate) = 'object'),
  PRIMARY KEY (tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_bible.runs
);
CREATE TABLE camery_bible.reviews (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('confirmed','rejected')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_bible.candidates
);
