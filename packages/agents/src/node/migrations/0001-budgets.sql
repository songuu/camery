CREATE TABLE camery_agents.budget_projects (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  limit_steps bigint NOT NULL CHECK (limit_steps BETWEEN 0 AND 9007199254740991),
  limit_tokens bigint NOT NULL CHECK (limit_tokens BETWEEN 0 AND 9007199254740991),
  limit_cost bigint NOT NULL CHECK (limit_cost BETWEEN 0 AND 9007199254740991),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, project_id)
);
CREATE TABLE camery_agents.budget_allocations (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  allocation_id text NOT NULL,
  task_id text NOT NULL,
  agent jsonb NOT NULL,
  task_fingerprint text NOT NULL CHECK (task_fingerprint ~ '^[a-f0-9]{64}$'),
  reserved_steps bigint NOT NULL CHECK (reserved_steps BETWEEN 1 AND 1000),
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens BETWEEN 0 AND 9007199254740991),
  reserved_cost bigint NOT NULL CHECK (reserved_cost BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('held','settled')),
  actual_steps bigint CHECK (actual_steps BETWEEN 0 AND 9007199254740991),
  actual_tokens bigint CHECK (actual_tokens BETWEEN 0 AND 9007199254740991),
  actual_cost bigint CHECK (actual_cost BETWEEN 0 AND 9007199254740991),
  actor_id text,
  receipt_id text,
  reference text,
  settlement_digest text,
  PRIMARY KEY (tenant_id, project_id, allocation_id),
  UNIQUE (tenant_id, task_id),
  UNIQUE (tenant_id, project_id, receipt_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES camery_agents.budget_projects (tenant_id, project_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES camery_durable.tasks (tenant_id, task_id),
  CHECK ((state = 'held' AND actual_steps IS NULL AND actual_tokens IS NULL AND actual_cost IS NULL AND actor_id IS NULL AND receipt_id IS NULL AND reference IS NULL AND settlement_digest IS NULL)
      OR (state = 'settled' AND actual_steps IS NOT NULL AND actual_tokens IS NOT NULL AND actual_cost IS NOT NULL AND actor_id IS NOT NULL AND receipt_id IS NOT NULL AND reference IS NOT NULL AND settlement_digest IS NOT NULL))
);
CREATE TABLE camery_agents.budget_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  allocation_id text,
  action text NOT NULL CHECK (action IN ('project_created','allocated','settled')),
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES camery_agents.budget_projects (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id, allocation_id) REFERENCES camery_agents.budget_allocations (tenant_id, project_id, allocation_id)
);
CREATE INDEX budget_project_events ON camery_agents.budget_events (tenant_id, project_id, event_id);
