-- Cover the referencing side of the scoped brief FK and brief-filtered run reads.
CREATE INDEX development_runs_brief_idx ON camery_script.runs
  (tenant_id,project_id,brief_id,brief_revision);
