CREATE TABLE camery_access.users (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  user_id text NOT NULL CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE camery_access.memberships (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  role text NOT NULL CHECK (role IN ('viewer', 'editor', 'reviewer', 'admin')),
  PRIMARY KEY (tenant_id, user_id, project_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES camery_access.users (tenant_id, user_id)
);
CREATE TABLE camery_access.sessions (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, session_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES camery_access.users (tenant_id, user_id),
  CHECK (expires_at > created_at)
);
CREATE INDEX access_user_sessions ON camery_access.sessions (tenant_id, user_id);
