-- Metadata keyset indexes are additive; installed intent and receipt records remain unchanged.
CREATE INDEX candidate_intents_catalog_idx ON camery_projects.candidate_intents(tenant_id,project_id,ir_tenant_id,ir_project_id,change_id COLLATE "C" DESC);
CREATE INDEX candidate_intents_development_catalog_idx ON camery_projects.candidate_intents(tenant_id,project_id,(record#>>'{source,source,runId}'),change_id COLLATE "C" DESC) WHERE record#>>'{source,kind}'='development';
CREATE INDEX candidate_intents_upgrade_catalog_idx ON camery_projects.candidate_intents(tenant_id,project_id,change_id COLLATE "C" DESC) WHERE record#>>'{source,kind}'='manual' AND record#>>'{request,ops,0,op}'='upgrade_schema' AND jsonb_array_length(record#>'{request,ops}')=1;
CREATE INDEX project_native_candidate_catalog_idx ON camery_versioning.changes(tenant_id,project_id,change_id COLLATE "C" DESC);
