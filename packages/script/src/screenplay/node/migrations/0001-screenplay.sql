CREATE TABLE camery_screenplay.candidates (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  candidate_id text NOT NULL,
  formal_tenant_id text NOT NULL,
  formal_project_id text NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740991),
  context_digest text NOT NULL CHECK (context_digest ~ '^[a-f0-9]{64}$'),
  command_digest text NOT NULL CHECK (command_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=134217728),
  PRIMARY KEY (tenant_id,project_id,candidate_id),
  FOREIGN KEY (formal_tenant_id,formal_project_id,source_revision) REFERENCES camery_versioning.snapshots(tenant_id,project_id,revision)
);
CREATE INDEX screenplay_candidates_source_idx ON camery_screenplay.candidates(formal_tenant_id,formal_project_id,source_revision);
CREATE TABLE camery_screenplay.reviews (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  candidate_id text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=16777216),
  PRIMARY KEY (tenant_id,project_id,candidate_id),
  FOREIGN KEY (tenant_id,project_id,candidate_id) REFERENCES camery_screenplay.candidates(tenant_id,project_id,candidate_id)
);
CREATE TABLE camery_screenplay.native_bindings (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  candidate_id text NOT NULL,
  formal_tenant_id text NOT NULL,
  formal_project_id text NOT NULL,
  change_id text NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740990),
  mapping_digest text NOT NULL CHECK (mapping_digest ~ '^[a-f0-9]{64}$'),
  review_digest text NOT NULL CHECK (review_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=16777216),
  PRIMARY KEY (formal_tenant_id,formal_project_id,change_id),
  UNIQUE (tenant_id,project_id,candidate_id),
  FOREIGN KEY (tenant_id,project_id,candidate_id) REFERENCES camery_screenplay.reviews(tenant_id,project_id,candidate_id),
  FOREIGN KEY (formal_tenant_id,formal_project_id,change_id) REFERENCES camery_versioning.changes(tenant_id,project_id,change_id),
  FOREIGN KEY (formal_tenant_id,formal_project_id,source_revision) REFERENCES camery_versioning.snapshots(tenant_id,project_id,revision)
);
CREATE INDEX screenplay_bindings_source_idx ON camery_screenplay.native_bindings(formal_tenant_id,formal_project_id,source_revision);
CREATE TABLE camery_screenplay.native_adoptions (
  formal_tenant_id text NOT NULL,
  formal_project_id text NOT NULL,
  change_id text NOT NULL,
  from_revision bigint NOT NULL CHECK (from_revision BETWEEN 1 AND 9007199254740990),
  to_revision bigint NOT NULL CHECK (to_revision=from_revision+1 AND to_revision<=9007199254740991),
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=16777216),
  PRIMARY KEY (formal_tenant_id,formal_project_id,change_id),
  FOREIGN KEY (formal_tenant_id,formal_project_id,change_id) REFERENCES camery_screenplay.native_bindings(formal_tenant_id,formal_project_id,change_id),
  FOREIGN KEY (formal_tenant_id,formal_project_id,change_id) REFERENCES camery_versioning.adoptions(tenant_id,project_id,change_id),
  FOREIGN KEY (formal_tenant_id,formal_project_id,from_revision) REFERENCES camery_versioning.snapshots(tenant_id,project_id,revision),
  FOREIGN KEY (formal_tenant_id,formal_project_id,to_revision) REFERENCES camery_versioning.snapshots(tenant_id,project_id,revision)
);
CREATE INDEX screenplay_adoptions_from_idx ON camery_screenplay.native_adoptions(formal_tenant_id,formal_project_id,from_revision);
CREATE INDEX screenplay_adoptions_to_idx ON camery_screenplay.native_adoptions(formal_tenant_id,formal_project_id,to_revision);
REVOKE ALL ON ALL TABLES IN SCHEMA camery_screenplay FROM PUBLIC;
