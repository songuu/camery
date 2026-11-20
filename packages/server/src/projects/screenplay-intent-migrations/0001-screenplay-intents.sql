-- A source/identity journal only; native snapshots, reviews and adoption proofs remain authoritative.
CREATE UNIQUE INDEX screenplay_candidates_journal_key_idx ON camery_screenplay.candidates
  (tenant_id,project_id,candidate_id,formal_tenant_id,formal_project_id,source_revision,context_digest,digest);
CREATE UNIQUE INDEX screenplay_reviews_journal_key_idx ON camery_screenplay.reviews(tenant_id,project_id,candidate_id,digest);
CREATE UNIQUE INDEX screenplay_bindings_journal_key_idx ON camery_screenplay.native_bindings
  (tenant_id,project_id,formal_tenant_id,formal_project_id,change_id);

CREATE TABLE camery_projects.screenplay_candidate_intents (
  tenant_id text NOT NULL,project_id text NOT NULL,
  application_id text NOT NULL CHECK (application_id ~ '^[A-Za-z0-9]' AND application_id !~ '[^A-Za-z0-9_.:-]' AND length(application_id)<=128),
  actor_kind text NOT NULL CHECK (actor_kind='user'),actor_key text NOT NULL,ir_actor_id text NOT NULL,
  ir_tenant_id text NOT NULL,ir_project_id text NOT NULL,
  change_id text NOT NULL UNIQUE CHECK (change_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND length(change_id)=26),
  source_candidate_id text NOT NULL,preparation_digest text NOT NULL,review_digest text NOT NULL,context_digest text NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740990),
  episode_id text NOT NULL CHECK (episode_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' AND length(episode_id)=26),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=2097152),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$' AND length(digest)=64),
  business_digest text NOT NULL CHECK (business_digest ~ '^[a-f0-9]{64}$' AND length(business_digest)=64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (tenant_id,project_id,application_id),
  UNIQUE (tenant_id,project_id,application_id,digest),
  UNIQUE (tenant_id,project_id,change_id),
  FOREIGN KEY (tenant_id,project_id,ir_tenant_id,ir_project_id) REFERENCES camery_projects.projects(tenant_id,project_id,ir_tenant_id,ir_project_id),
  FOREIGN KEY (tenant_id,actor_kind,actor_key,ir_actor_id) REFERENCES camery_projects.principals(tenant_id,principal_kind,principal_key,ir_actor_id),
  FOREIGN KEY (tenant_id,project_id,source_candidate_id,ir_tenant_id,ir_project_id,source_revision,context_digest,preparation_digest)
    REFERENCES camery_screenplay.candidates(tenant_id,project_id,candidate_id,formal_tenant_id,formal_project_id,source_revision,context_digest,digest),
  FOREIGN KEY (tenant_id,project_id,source_candidate_id,review_digest) REFERENCES camery_screenplay.reviews(tenant_id,project_id,candidate_id,digest),
  CHECK ((record->>'version'='1' AND record#>>'{scope,tenantId}'=tenant_id AND record#>>'{scope,projectId}'=project_id
    AND record->>'applicationId'=application_id AND record->>'changeId'=change_id
    AND record#>>'{actor,kind}'=actor_kind AND record#>>'{actor,key}'=actor_key AND record#>>'{actor,id}'=ir_actor_id
    AND record#>>'{target,tenantId}'=ir_tenant_id AND record#>>'{target,projectId}'=ir_project_id
    AND record#>>'{sourceKey,tenantId}'=tenant_id AND record#>>'{sourceKey,projectId}'=project_id AND record#>>'{sourceKey,candidateId}'=source_candidate_id
    AND record->>'preparationDigest'=preparation_digest AND record->>'reviewDigest'=review_digest AND record->>'contextDigest'=context_digest
    AND record#>>'{expectation,expectedSnapshotRevision}'=source_revision::text AND record->>'episodeId'=episode_id
    AND jsonb_typeof(record->'ids')='array' AND jsonb_array_length(record->'ids') BETWEEN 1 AND 40000) IS TRUE)
);
CREATE INDEX screenplay_candidate_catalog_idx ON camery_projects.screenplay_candidate_intents(tenant_id,project_id,ir_tenant_id,ir_project_id,change_id COLLATE "C" DESC);
CREATE INDEX screenplay_candidate_actor_idx ON camery_projects.screenplay_candidate_intents(tenant_id,actor_kind,actor_key,ir_actor_id);
CREATE INDEX screenplay_candidate_source_idx ON camery_projects.screenplay_candidate_intents(tenant_id,project_id,source_candidate_id);

CREATE TABLE camery_projects.screenplay_candidate_receipts (
  tenant_id text NOT NULL,project_id text NOT NULL,application_id text NOT NULL,intent_digest text NOT NULL,
  -- Runtime receipts are bounded at 64 MiB; JSONB formatting needs storage headroom.
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=134217728),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$' AND length(digest)=64),
  PRIMARY KEY (tenant_id,project_id,application_id),
  FOREIGN KEY (tenant_id,project_id,application_id,intent_digest) REFERENCES camery_projects.screenplay_candidate_intents(tenant_id,project_id,application_id,digest)
);
CREATE INDEX screenplay_candidate_receipt_intent_idx ON camery_projects.screenplay_candidate_receipts(tenant_id,project_id,application_id,intent_digest);

CREATE TABLE camery_projects.screenplay_decision_intents (
  tenant_id text NOT NULL,project_id text NOT NULL,actor_kind text NOT NULL CHECK (actor_kind='user'),actor_key text NOT NULL,ir_actor_id text NOT NULL,
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9]' AND request_id !~ '[^A-Za-z0-9_.:-]' AND length(request_id)<=128),
  ir_tenant_id text NOT NULL,ir_project_id text NOT NULL,change_id text NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=2097152),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$' AND length(digest)=64),business_digest text NOT NULL CHECK (business_digest ~ '^[a-f0-9]{64}$' AND length(business_digest)=64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (tenant_id,project_id,actor_kind,actor_key,request_id),
  UNIQUE (tenant_id,project_id,actor_kind,actor_key,request_id,digest),
  FOREIGN KEY (tenant_id,project_id,ir_tenant_id,ir_project_id,change_id) REFERENCES camery_screenplay.native_bindings(tenant_id,project_id,formal_tenant_id,formal_project_id,change_id),
  FOREIGN KEY (tenant_id,project_id,ir_tenant_id,ir_project_id) REFERENCES camery_projects.projects(tenant_id,project_id,ir_tenant_id,ir_project_id),
  FOREIGN KEY (tenant_id,actor_kind,actor_key,ir_actor_id) REFERENCES camery_projects.principals(tenant_id,principal_kind,principal_key,ir_actor_id),
  CHECK ((record->>'version'='1' AND record#>>'{scope,tenantId}'=tenant_id AND record#>>'{scope,projectId}'=project_id
    AND record#>>'{actor,kind}'=actor_kind AND record#>>'{actor,key}'=actor_key AND record#>>'{actor,id}'=ir_actor_id
    AND record#>>'{target,tenantId}'=ir_tenant_id AND record#>>'{target,projectId}'=ir_project_id
    AND record->>'requestId'=request_id AND record->>'changeId'=change_id AND record#>>'{adoptionScope,kind}'='episode') IS TRUE)
);
CREATE INDEX screenplay_decision_candidate_idx ON camery_projects.screenplay_decision_intents(tenant_id,project_id,change_id);
CREATE INDEX screenplay_decision_actor_idx ON camery_projects.screenplay_decision_intents(tenant_id,actor_kind,actor_key,ir_actor_id);
CREATE TABLE camery_projects.screenplay_decision_receipts (
  tenant_id text NOT NULL,project_id text NOT NULL,actor_kind text NOT NULL,actor_key text NOT NULL,request_id text NOT NULL,intent_digest text NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=134217728),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$' AND length(digest)=64),
  PRIMARY KEY (tenant_id,project_id,actor_kind,actor_key,request_id),
  FOREIGN KEY (tenant_id,project_id,actor_kind,actor_key,request_id,intent_digest) REFERENCES camery_projects.screenplay_decision_intents(tenant_id,project_id,actor_kind,actor_key,request_id,digest)
);
CREATE INDEX screenplay_decision_receipt_intent_idx ON camery_projects.screenplay_decision_receipts(tenant_id,project_id,actor_kind,actor_key,request_id,intent_digest);
