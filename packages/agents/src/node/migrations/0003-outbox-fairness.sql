ALTER TABLE camery_agents.agent_questions
  ADD CONSTRAINT question_gate_binding_complete CHECK (
    (gate_key IS NULL AND durable_task_id IS NULL AND gate_input_digest IS NULL)
    OR (gate_key IS NOT NULL AND durable_task_id IS NOT NULL AND gate_input_digest IS NOT NULL AND gate_input_digest ~ '^[a-f0-9]{64}$')
  );
ALTER TABLE camery_agents.agent_outbox
  ADD COLUMN last_selected_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX agent_outbox_rotation ON camery_agents.agent_outbox(tenant_id,project_id,last_selected_at,sequence) WHERE NOT delivered;
