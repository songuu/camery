CREATE TABLE camery_ingest.scripts (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  document_id text NOT NULL,
  format text NOT NULL CHECK (format IN ('fountain','csv','tsv','docx')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  original bytea NOT NULL CHECK (octet_length(original) BETWEEN 1 AND 8000000),
  original_digest text NOT NULL CHECK (original_digest ~ '^[a-f0-9]{64}$'),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  PRIMARY KEY (tenant_id,project_id,document_id)
);
