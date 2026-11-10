CREATE TABLE camery_durable.tasks (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  workflow text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  input jsonb NOT NULL,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  status text NOT NULL CHECK (status IN ('queued','running','waiting','reconciling','succeeded','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  fence integer NOT NULL DEFAULT 0 CHECK (fence >= 0),
  owner text,
  lease_until timestamptz,
  available_at timestamptz,
  enqueue_at timestamptz NOT NULL,
  output jsonb NOT NULL DEFAULT 'null',
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, task_id),
  CHECK ((status = 'running') = (owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((owner IS NULL) = (lease_until IS NULL))
);
CREATE INDEX task_queue ON camery_durable.tasks (tenant_id, status, available_at, lease_until);
CREATE TABLE camery_durable.steps (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  step_key text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  kind text NOT NULL CHECK (kind IN ('replayable','external','gate','timer')),
  input jsonb NOT NULL,
  fingerprint text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','waiting','completed','failed','unknown')),
  output jsonb NOT NULL DEFAULT 'null',
  error text,
  due_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, task_id, step_key),
  UNIQUE (tenant_id, task_id, position),
  FOREIGN KEY (tenant_id, task_id) REFERENCES camery_durable.tasks (tenant_id, task_id),
  CHECK ((kind = 'timer') = (due_at IS NOT NULL))
);
CREATE TABLE camery_durable.signals (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  signal_id text NOT NULL,
  step_key text NOT NULL,
  actor_id text NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, task_id, signal_id),
  UNIQUE (tenant_id, task_id, step_key),
  FOREIGN KEY (tenant_id, task_id, step_key) REFERENCES camery_durable.steps (tenant_id, task_id, step_key)
);
CREATE TABLE camery_durable.events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES camery_durable.tasks (tenant_id, task_id)
);
CREATE INDEX task_events ON camery_durable.events (tenant_id, task_id, event_id);
