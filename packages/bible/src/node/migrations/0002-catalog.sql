CREATE INDEX bible_runs_catalog_idx ON camery_bible.runs
  (tenant_id,project_id,created_at DESC,run_id COLLATE "C" DESC);
