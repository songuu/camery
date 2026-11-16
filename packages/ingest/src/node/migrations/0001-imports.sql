CREATE TABLE camery_ingest.documents (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  document_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  PRIMARY KEY (tenant_id, project_id, document_id)
);
CREATE TABLE camery_ingest.reading_checkpoints (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  document_id text NOT NULL,
  reader_id text NOT NULL,
  checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
  PRIMARY KEY (tenant_id, project_id, document_id, reader_id),
  FOREIGN KEY (tenant_id, project_id, document_id)
    REFERENCES camery_ingest.documents (tenant_id, project_id, document_id)
);
