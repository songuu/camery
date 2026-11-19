CREATE TABLE camery_continuity.native_bindings (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  candidate_id text NOT NULL,
  formal_tenant_id text NOT NULL,
  formal_project_id text NOT NULL,
  change_id text NOT NULL,
  snapshot_id text NOT NULL CHECK (length(snapshot_id)=26 AND snapshot_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  snapshot_version bigint NOT NULL CHECK (snapshot_version BETWEEN 1 AND 9007199254740991),
  source_revision bigint NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740991),
  candidate_digest text NOT NULL CHECK (length(candidate_digest)=64 AND candidate_digest ~ '^[a-f0-9]{64}$'),
  review_digest text NOT NULL CHECK (length(review_digest)=64 AND review_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (length(request_digest)=64 AND request_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (length(digest)=64 AND digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=16777216),
  PRIMARY KEY (formal_tenant_id,formal_project_id,change_id),
  UNIQUE (tenant_id,project_id,candidate_id),
  FOREIGN KEY (tenant_id,project_id,candidate_id) REFERENCES camery_continuity.reviews(tenant_id,project_id,candidate_id),
  FOREIGN KEY (formal_tenant_id,formal_project_id,change_id) REFERENCES camery_versioning.changes(tenant_id,project_id,change_id),
  FOREIGN KEY (formal_tenant_id,formal_project_id,source_revision) REFERENCES camery_versioning.snapshots(tenant_id,project_id,revision)
);
CREATE INDEX continuity_native_bindings_source_idx ON camery_continuity.native_bindings(formal_tenant_id,formal_project_id,source_revision);
CREATE TABLE camery_continuity.native_adoptions (
  formal_tenant_id text NOT NULL,
  formal_project_id text NOT NULL,
  change_id text NOT NULL,
  snapshot_id text NOT NULL,
  snapshot_version bigint NOT NULL CHECK (snapshot_version BETWEEN 1 AND 9007199254740991),
  from_revision bigint NOT NULL CHECK (from_revision BETWEEN 1 AND 9007199254740990),
  to_revision bigint NOT NULL CHECK (to_revision=from_revision+1 AND to_revision<=9007199254740991),
  binding_digest text NOT NULL CHECK (length(binding_digest)=64 AND binding_digest ~ '^[a-f0-9]{64}$'),
  review_digest text NOT NULL CHECK (length(review_digest)=64 AND review_digest ~ '^[a-f0-9]{64}$'),
  ledger_digest text NOT NULL CHECK (length(ledger_digest)=64 AND ledger_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (length(digest)=64 AND digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=16777216),
  PRIMARY KEY (formal_tenant_id,formal_project_id,change_id),
  UNIQUE (formal_tenant_id,formal_project_id,snapshot_id,snapshot_version),
  FOREIGN KEY (formal_tenant_id,formal_project_id,change_id) REFERENCES camery_continuity.native_bindings(formal_tenant_id,formal_project_id,change_id),
  FOREIGN KEY (formal_tenant_id,formal_project_id,change_id) REFERENCES camery_versioning.adoptions(tenant_id,project_id,change_id),
  FOREIGN KEY (formal_tenant_id,formal_project_id,snapshot_id,snapshot_version) REFERENCES camery_versioning.object_revisions(tenant_id,project_id,object_id,version),
  FOREIGN KEY (formal_tenant_id,formal_project_id,from_revision) REFERENCES camery_versioning.snapshots(tenant_id,project_id,revision),
  FOREIGN KEY (formal_tenant_id,formal_project_id,to_revision) REFERENCES camery_versioning.snapshots(tenant_id,project_id,revision)
);
CREATE INDEX continuity_native_adoptions_from_idx ON camery_continuity.native_adoptions(formal_tenant_id,formal_project_id,from_revision);
CREATE INDEX continuity_native_adoptions_to_idx ON camery_continuity.native_adoptions(formal_tenant_id,formal_project_id,to_revision);
