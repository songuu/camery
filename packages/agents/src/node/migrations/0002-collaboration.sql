CREATE TABLE camery_agents.agent_projects (
  tenant_id text NOT NULL, project_id text NOT NULL, PRIMARY KEY (tenant_id,project_id)
);
CREATE TABLE camery_agents.agent_trees (
  tenant_id text NOT NULL, project_id text NOT NULL, tree_id text NOT NULL,
  definition jsonb NOT NULL, definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,project_id,tree_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES camery_agents.agent_projects(tenant_id,project_id)
);
CREATE TABLE camery_agents.agent_tasks (
  tenant_id text NOT NULL, project_id text NOT NULL, task_id text NOT NULL, tree_id text NOT NULL,
  record jsonb NOT NULL, revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  durable_task_id text, job jsonb,
  PRIMARY KEY (tenant_id,project_id,task_id), UNIQUE (tenant_id,durable_task_id),
  FOREIGN KEY (tenant_id,project_id,tree_id) REFERENCES camery_agents.agent_trees(tenant_id,project_id,tree_id),
  CHECK ((durable_task_id IS NULL) = (job IS NULL))
);
CREATE INDEX agent_tree_tasks ON camery_agents.agent_tasks(tenant_id,project_id,tree_id);
CREATE TABLE camery_agents.agent_outbox (
  tenant_id text NOT NULL, project_id text NOT NULL, outbox_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('enqueue','signal')), record jsonb NOT NULL,
  record_digest text NOT NULL CHECK (record_digest ~ '^[a-f0-9]{64}$'), delivered boolean NOT NULL DEFAULT false,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (tenant_id,project_id,outbox_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES camery_agents.agent_projects(tenant_id,project_id)
);
CREATE INDEX agent_outbox_pending ON camery_agents.agent_outbox(tenant_id,project_id,delivered,sequence);
CREATE TABLE camery_agents.agent_issues (
  tenant_id text NOT NULL, project_id text NOT NULL, task_id text NOT NULL, issue_id text NOT NULL,
  record jsonb NOT NULL, record_digest text NOT NULL CHECK (record_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,project_id,task_id,issue_id),
  FOREIGN KEY (tenant_id,project_id,task_id) REFERENCES camery_agents.agent_tasks(tenant_id,project_id,task_id)
);
CREATE TABLE camery_agents.agent_questions (
  tenant_id text NOT NULL, project_id text NOT NULL, task_id text NOT NULL, question_id text NOT NULL,
  record jsonb NOT NULL, question_digest text NOT NULL CHECK (question_digest ~ '^[a-f0-9]{64}$'),
  gate_key text, durable_task_id text, gate_input_digest text, outbox_id text,
  PRIMARY KEY (tenant_id,project_id,task_id,question_id),
  FOREIGN KEY (tenant_id,project_id,task_id) REFERENCES camery_agents.agent_tasks(tenant_id,project_id,task_id),
  FOREIGN KEY (tenant_id,project_id,outbox_id) REFERENCES camery_agents.agent_outbox(tenant_id,project_id,outbox_id),
  CHECK ((gate_key IS NULL AND durable_task_id IS NULL AND gate_input_digest IS NULL) OR
         (gate_key IS NOT NULL AND durable_task_id IS NOT NULL AND gate_input_digest ~ '^[a-f0-9]{64}$'))
);
CREATE TABLE camery_agents.agent_reviews (
  tenant_id text NOT NULL, project_id text NOT NULL, task_id text NOT NULL, review_id text NOT NULL,
  initial_digest text NOT NULL CHECK (initial_digest ~ '^[a-f0-9]{64}$'), record jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991), gate_key text,
  PRIMARY KEY (tenant_id,project_id,task_id,review_id),
  FOREIGN KEY (tenant_id,project_id,task_id) REFERENCES camery_agents.agent_tasks(tenant_id,project_id,task_id)
);
CREATE TABLE camery_agents.agent_review_ops (
  tenant_id text NOT NULL, project_id text NOT NULL, task_id text NOT NULL, review_id text NOT NULL, operation_id text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'), record jsonb NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (tenant_id,project_id,task_id,review_id,operation_id),
  FOREIGN KEY (tenant_id,project_id,task_id,review_id) REFERENCES camery_agents.agent_reviews(tenant_id,project_id,task_id,review_id)
);
CREATE TABLE camery_agents.agent_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL, project_id text NOT NULL, task_id text,
  action text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,project_id) REFERENCES camery_agents.agent_projects(tenant_id,project_id),
  FOREIGN KEY (tenant_id,project_id,task_id) REFERENCES camery_agents.agent_tasks(tenant_id,project_id,task_id)
);
CREATE INDEX agent_events_scope ON camery_agents.agent_events(tenant_id,project_id,event_id);
