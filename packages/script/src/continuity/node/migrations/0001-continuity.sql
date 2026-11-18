CREATE TABLE camery_continuity.candidates (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND tenant_id !~ '[^A-Za-z0-9_.:-]'),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND project_id !~ '[^A-Za-z0-9_.:-]'),
  candidate_id text NOT NULL CHECK (candidate_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND candidate_id !~ '[^A-Za-z0-9_.:-]'),
  formal_tenant_id text NOT NULL CHECK (length(formal_tenant_id)=26 AND formal_tenant_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  formal_project_id text NOT NULL CHECK (length(formal_project_id)=26 AND formal_project_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  source_revision bigint NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740991),
  episode_id text NOT NULL CHECK (length(episode_id)=26 AND episode_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  author_id text NOT NULL CHECK (author_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND author_id !~ '[^A-Za-z0-9_.:-]'),
  package_digest text NOT NULL CHECK (length(package_digest)=64 AND package_digest ~ '^[a-f0-9]{64}$'),
  context_digest text NOT NULL CHECK (length(context_digest)=64 AND context_digest ~ '^[a-f0-9]{64}$'),
  command_digest text NOT NULL CHECK (length(command_digest)=64 AND command_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (length(digest)=64 AND digest ~ '^[a-f0-9]{64}$'),
  -- The application checks compact logical JSON at 16MiB; JSONB's text form inserts whitespace, so its defensive storage ceiling is 32MiB.
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=33554432),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (tenant_id,project_id,candidate_id),
  FOREIGN KEY (formal_tenant_id,formal_project_id,source_revision) REFERENCES camery_versioning.snapshots(tenant_id,project_id,revision)
);
-- The ordinary-scope primary key cannot support native snapshot foreign-key lookups.
CREATE INDEX continuity_candidates_source_idx ON camery_continuity.candidates(formal_tenant_id,formal_project_id,source_revision);
CREATE TABLE camery_continuity.reviews (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  candidate_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('reviewed','rejected')),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND actor_id !~ '[^A-Za-z0-9_.:-]'),
  request_digest text NOT NULL CHECK (length(request_digest)=64 AND request_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (length(digest)=64 AND digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=33554432),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (tenant_id,project_id,candidate_id),
  FOREIGN KEY (tenant_id,project_id,candidate_id) REFERENCES camery_continuity.candidates(tenant_id,project_id,candidate_id)
);
