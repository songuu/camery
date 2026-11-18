-- Keep the index collation identical to the public keyset range and ordering.
CREATE INDEX outline_candidate_catalog_idx ON camery_projects.outline_candidate_intents
  (tenant_id,project_id,ir_tenant_id,ir_project_id,change_id COLLATE "C" DESC);
CREATE INDEX outline_candidate_run_catalog_idx ON camery_projects.outline_candidate_intents
  (tenant_id,project_id,ir_tenant_id,ir_project_id,run_id,change_id COLLATE "C" DESC);
