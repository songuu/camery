CREATE TABLE camery_versioning.projects (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  package_id text NOT NULL,
  initial_revision bigint NOT NULL CHECK (initial_revision > 0),
  head_revision bigint NOT NULL CHECK (head_revision >= initial_revision),
  write_version bigint NOT NULL DEFAULT 1 CHECK (write_version BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (tenant_id, project_id),
  UNIQUE (tenant_id, package_id)
);
CREATE TABLE camery_versioning.snapshots (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  package jsonb NOT NULL CHECK (jsonb_typeof(package) = 'object'),
  PRIMARY KEY (tenant_id, project_id, revision),
  FOREIGN KEY (tenant_id, project_id) REFERENCES camery_versioning.projects,
  CHECK (package->'project'->>'id' = project_id),
  CHECK ((package->'revision'->>'number')::bigint = revision),
  CHECK (package->'revision'->>'status' = 'adopted')
);
ALTER TABLE camery_versioning.projects ADD FOREIGN KEY (tenant_id, project_id, head_revision)
  REFERENCES camery_versioning.snapshots (tenant_id, project_id, revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE camery_versioning.changes (
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  change_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('candidate','adopted','rejected','conflicted')),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (tenant_id, project_id, change_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES camery_versioning.projects,
  CHECK (record->'request'->>'id' = change_id),
  CHECK (record->>'status' = status)
);
CREATE TABLE camery_versioning.object_revisions (
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  object_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  parent_version bigint,
  snapshot_revision bigint NOT NULL,
  change_id text,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (tenant_id, project_id, object_id, version),
  FOREIGN KEY (tenant_id, project_id, object_id, parent_version) REFERENCES camery_versioning.object_revisions (tenant_id, project_id, object_id, version),
  FOREIGN KEY (tenant_id, project_id, snapshot_revision) REFERENCES camery_versioning.snapshots (tenant_id, project_id, revision),
  FOREIGN KEY (tenant_id, project_id, change_id) REFERENCES camery_versioning.changes (tenant_id, project_id, change_id),
  CHECK (parent_version IS NULL OR version = parent_version + 1),
  CHECK (record->>'object_id' = object_id),
  CHECK ((record->>'version')::bigint = version)
);
CREATE TABLE camery_versioning.adoptions (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  change_id text NOT NULL,
  from_revision bigint NOT NULL,
  to_revision bigint NOT NULL CHECK (to_revision = from_revision + 1),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (tenant_id, project_id, change_id),
  UNIQUE (tenant_id, project_id, to_revision),
  FOREIGN KEY (tenant_id, project_id, change_id) REFERENCES camery_versioning.changes (tenant_id, project_id, change_id),
  FOREIGN KEY (tenant_id, project_id, from_revision) REFERENCES camery_versioning.snapshots (tenant_id, project_id, revision),
  FOREIGN KEY (tenant_id, project_id, to_revision) REFERENCES camery_versioning.snapshots (tenant_id, project_id, revision),
  CHECK (record->>'change_set_id' = change_id)
);
CREATE INDEX project_changes ON camery_versioning.changes (tenant_id, project_id, sequence);
CREATE INDEX project_history ON camery_versioning.object_revisions (tenant_id, project_id, sequence);
