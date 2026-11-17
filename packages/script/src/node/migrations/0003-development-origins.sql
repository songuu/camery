-- References retain the exact immutable parent header and the real accepted foundation audit.
CREATE UNIQUE INDEX development_runs_digest_idx ON camery_script.runs (tenant_id,project_id,run_id,digest);
CREATE UNIQUE INDEX development_reviews_digest_idx ON camery_script.reviews (tenant_id,project_id,run_id,stage,status,digest);
CREATE TABLE camery_script.run_origins (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9]' AND tenant_id !~ '[^A-Za-z0-9_.:-]' AND length(tenant_id)<=128),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9]' AND project_id !~ '[^A-Za-z0-9_.:-]' AND length(project_id)<=128),
  run_id text NOT NULL CHECK (run_id ~ '^[A-Za-z0-9]' AND run_id !~ '[^A-Za-z0-9_.:-]' AND length(run_id)<=128),
  source_run_id text NOT NULL CHECK (source_run_id ~ '^[A-Za-z0-9]' AND source_run_id !~ '[^A-Za-z0-9_.:-]' AND length(source_run_id)<=128),
  source_run_digest text NOT NULL CHECK (source_run_digest ~ '^[a-f0-9]{64}$' AND length(source_run_digest)=64),
  stage text NOT NULL CHECK (stage IN ('foundation','episodes')),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9]' AND actor_id !~ '[^A-Za-z0-9_.:-]' AND length(actor_id)<=128),
  foundation_run_id text CHECK (foundation_run_id ~ '^[A-Za-z0-9]' AND foundation_run_id !~ '[^A-Za-z0-9_.:-]' AND length(foundation_run_id)<=128),
  foundation_stage text CHECK (foundation_stage='foundation'),
  foundation_review_status text CHECK (foundation_review_status='reviewed'),
  foundation_review_digest text CHECK (foundation_review_digest ~ '^[a-f0-9]{64}$' AND length(foundation_review_digest)=64),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_script.runs(tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,source_run_id,source_run_digest) REFERENCES camery_script.runs(tenant_id,project_id,run_id,digest),
  FOREIGN KEY (tenant_id,project_id,foundation_run_id,foundation_stage,foundation_review_status,foundation_review_digest)
    REFERENCES camery_script.reviews(tenant_id,project_id,run_id,stage,status,digest),
  CHECK (run_id<>source_run_id AND (foundation_run_id IS NULL OR foundation_run_id<>run_id)),
  CHECK ((stage='foundation' AND foundation_run_id IS NULL AND foundation_stage IS NULL AND foundation_review_status IS NULL AND foundation_review_digest IS NULL)
    OR (stage='episodes' AND foundation_run_id IS NOT NULL AND foundation_stage IS NOT NULL AND foundation_review_status IS NOT NULL AND foundation_review_digest IS NOT NULL))
);
CREATE INDEX development_origins_source_idx ON camery_script.run_origins (tenant_id,project_id,source_run_id,source_run_digest);
CREATE INDEX development_origins_foundation_idx ON camery_script.run_origins (tenant_id,project_id,foundation_run_id,foundation_stage,foundation_review_status,foundation_review_digest);
