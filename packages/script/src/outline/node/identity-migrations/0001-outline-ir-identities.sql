-- One SQL uniqueness domain for Development and Outline metadata; existing identities are never rewritten.
ALTER TABLE camery_script.ir_identities ADD COLUMN outline_owner_run_id text;
ALTER TABLE camery_script.ir_identities
  DROP CONSTRAINT ir_identities_kind_check,
  DROP CONSTRAINT ir_identities_check1,
  DROP CONSTRAINT ir_identities_check2;
ALTER TABLE camery_script.ir_identities
  ADD CONSTRAINT ir_identities_kind_check CHECK (kind IN ('development_plan','world','character','relationship','episode','episode_plan',
    'adaptation_plan','outline_episode_plan','outline_character','outline_beat','outline_asset','outline_plot_unit','outline_decision')),
  ADD CONSTRAINT ir_identities_owner_check CHECK (
    (kind IN ('world','character','relationship') AND owner_run_id IS NOT NULL AND owner_key=owner_run_id AND outline_owner_run_id IS NULL)
    OR (kind IN ('development_plan','episode','episode_plan','adaptation_plan','outline_episode_plan') AND owner_key='project' AND owner_run_id IS NULL AND outline_owner_run_id IS NULL)
    OR (kind IN ('outline_character','outline_beat','outline_asset','outline_plot_unit','outline_decision') AND owner_run_id IS NULL AND outline_owner_run_id IS NOT NULL AND owner_key=outline_owner_run_id)),
  ADD CONSTRAINT ir_identities_slot_check CHECK (
    (kind='world' AND local_key='world') OR (kind IN ('development_plan','adaptation_plan') AND local_key='plan')
    OR (kind IN ('episode','episode_plan','outline_episode_plan') AND local_key ~ '^([1-9]|[1-9][0-9]|100)$')
    OR kind IN ('character','relationship','outline_character','outline_beat','outline_asset','outline_plot_unit','outline_decision')),
  ADD CONSTRAINT ir_identities_outline_owner_fkey FOREIGN KEY (tenant_id,project_id,outline_owner_run_id) REFERENCES camery_outline.runs(tenant_id,project_id,run_id);
CREATE INDEX outline_ir_identities_owner_idx ON camery_script.ir_identities(tenant_id,project_id,outline_owner_run_id) WHERE outline_owner_run_id IS NOT NULL;

-- The atomic preparation witness distinguishes an unprepared run from a lost complete owner group.
CREATE TABLE camery_outline.identity_preparations (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  run_digest text NOT NULL CHECK (run_digest ~ '^[0-9a-f]{64}$' AND length(run_digest)=64),
  review_digest text NOT NULL CHECK (review_digest ~ '^[0-9a-f]{64}$' AND length(review_digest)=64),
  episode_count integer NOT NULL CHECK (episode_count BETWEEN 1 AND 100),
  ir_tenant_id text NOT NULL CHECK (ir_tenant_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND length(ir_tenant_id)=26),
  ir_project_id text NOT NULL CHECK (ir_project_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND length(ir_project_id)=26),
  registry_digest text NOT NULL CHECK (registry_digest ~ '^[0-9a-f]{64}$' AND length(registry_digest)=64),
  PRIMARY KEY (tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_outline.runs(tenant_id,project_id,run_id)
);
