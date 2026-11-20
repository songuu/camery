CREATE SCHEMA camery_quality;
CREATE TABLE camery_quality.runs (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  initial_cycle integer NOT NULL DEFAULT 1 CHECK (initial_cycle=1),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=2097152),
  PRIMARY KEY (tenant_id,project_id,run_id)
);
CREATE TABLE camery_quality.cycles (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  cycle integer NOT NULL CHECK (cycle IN (1,2)),
  source_kind text NOT NULL CHECK (source_kind IN ('outline','screenplay')),
  source_variant text NOT NULL CHECK (source_variant IN ('candidate','reviewed')),
  outline_run_id text,
  reviewed_outline_run_id text,
  screenplay_candidate_id text,
  reviewed_screenplay_candidate_id text,
  native_tenant_id text,
  native_project_id text,
  native_change_id text,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  preparation_digest text NOT NULL CHECK (preparation_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=1048576),
  source jsonb NOT NULL CHECK (jsonb_typeof(source)='object' AND octet_length(source::text)<=134217728),
  preparation jsonb NOT NULL CHECK (jsonb_typeof(preparation)='object' AND octet_length(preparation::text)<=33554432),
  PRIMARY KEY (tenant_id,project_id,run_id,cycle),
  CHECK ((source_kind='outline' AND outline_run_id IS NOT NULL AND screenplay_candidate_id IS NULL AND reviewed_screenplay_candidate_id IS NULL AND native_change_id IS NULL) OR (source_kind='screenplay' AND screenplay_candidate_id IS NOT NULL AND outline_run_id IS NULL AND reviewed_outline_run_id IS NULL)),
  CHECK ((source_variant='candidate' AND reviewed_outline_run_id IS NULL AND reviewed_screenplay_candidate_id IS NULL AND native_change_id IS NULL) OR (source_variant='reviewed' AND ((source_kind='outline' AND reviewed_outline_run_id IS NOT NULL AND reviewed_outline_run_id=outline_run_id) OR (source_kind='screenplay' AND reviewed_screenplay_candidate_id IS NOT NULL AND reviewed_screenplay_candidate_id=screenplay_candidate_id)))),
  CHECK (num_nonnulls(native_tenant_id,native_project_id,native_change_id) IN (0,3)),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_quality.runs(tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,outline_run_id) REFERENCES camery_outline.candidates(tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,reviewed_outline_run_id) REFERENCES camery_outline.reviews(tenant_id,project_id,run_id),
  FOREIGN KEY (tenant_id,project_id,screenplay_candidate_id) REFERENCES camery_screenplay.candidates(tenant_id,project_id,candidate_id),
  FOREIGN KEY (tenant_id,project_id,reviewed_screenplay_candidate_id) REFERENCES camery_screenplay.reviews(tenant_id,project_id,candidate_id),
  FOREIGN KEY (native_tenant_id,native_project_id,native_change_id) REFERENCES camery_screenplay.native_adoptions(formal_tenant_id,formal_project_id,change_id)
);
ALTER TABLE camery_quality.runs ADD CONSTRAINT quality_initial_cycle_fk FOREIGN KEY (tenant_id,project_id,run_id,initial_cycle) REFERENCES camery_quality.cycles(tenant_id,project_id,run_id,cycle) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX quality_cycles_outline_idx ON camery_quality.cycles(tenant_id,project_id,outline_run_id);
CREATE INDEX quality_cycles_outline_review_idx ON camery_quality.cycles(tenant_id,project_id,reviewed_outline_run_id);
CREATE INDEX quality_cycles_screenplay_idx ON camery_quality.cycles(tenant_id,project_id,screenplay_candidate_id);
CREATE INDEX quality_cycles_screenplay_review_idx ON camery_quality.cycles(tenant_id,project_id,reviewed_screenplay_candidate_id);
CREATE INDEX quality_cycles_native_idx ON camery_quality.cycles(native_tenant_id,native_project_id,native_change_id);
CREATE TABLE camery_quality.batches (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  cycle integer NOT NULL CHECK (cycle IN (1,2)),
  phase text NOT NULL CHECK (phase IN ('story','continuity','production')),
  batch_index integer NOT NULL CHECK (batch_index BETWEEN 0 AND 8191),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=8388608),
  PRIMARY KEY (tenant_id,project_id,run_id,cycle,phase,batch_index),
  FOREIGN KEY (tenant_id,project_id,run_id,cycle) REFERENCES camery_quality.cycles(tenant_id,project_id,run_id,cycle)
);
CREATE TABLE camery_quality.stages (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  cycle integer NOT NULL CHECK (cycle IN (1,2)),
  phase text NOT NULL CHECK (phase IN ('story','continuity','production')),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=2097152),
  PRIMARY KEY (tenant_id,project_id,run_id,cycle,phase),
  FOREIGN KEY (tenant_id,project_id,run_id,cycle) REFERENCES camery_quality.cycles(tenant_id,project_id,run_id,cycle)
);
CREATE TABLE camery_quality.controls (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 9),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=2097152),
  PRIMARY KEY (tenant_id,project_id,run_id,sequence),
  FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES camery_quality.runs(tenant_id,project_id,run_id)
);
CREATE TABLE camery_quality.waivers (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  cycle integer NOT NULL CHECK (cycle IN (1,2)),
  finding_id text NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('free','model')),
  phase text,
  batch_index integer,
  result_digest text NOT NULL CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=32768),
  PRIMARY KEY (tenant_id,project_id,run_id,cycle,finding_id),
  CHECK ((target_kind='free' AND phase IS NULL AND batch_index IS NULL) OR (target_kind='model' AND phase IS NOT NULL AND phase IN ('story','continuity','production') AND batch_index IS NOT NULL AND batch_index BETWEEN 0 AND 8191)),
  FOREIGN KEY (tenant_id,project_id,run_id,cycle) REFERENCES camery_quality.cycles(tenant_id,project_id,run_id,cycle),
  FOREIGN KEY (tenant_id,project_id,run_id,cycle,phase,batch_index) REFERENCES camery_quality.batches(tenant_id,project_id,run_id,cycle,phase,batch_index)
);
CREATE INDEX quality_waivers_batch_idx ON camery_quality.waivers(tenant_id,project_id,run_id,cycle,phase,batch_index);
CREATE TABLE camery_quality.outbox (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  outbox_id text NOT NULL,
  cycle integer NOT NULL CHECK (cycle IN (1,2)),
  kind text NOT NULL CHECK (kind IN ('issue','question')),
  target_kind text NOT NULL CHECK (target_kind IN ('free','model','question')),
  phase text,
  batch_index integer,
  control_sequence integer,
  payload_id text NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=524288),
  delivered boolean NOT NULL DEFAULT false,
  acknowledged_digest text CHECK (acknowledged_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,project_id,run_id,outbox_id),
  CHECK ((target_kind='free' AND kind='issue' AND phase IS NULL AND batch_index IS NULL AND control_sequence IS NULL) OR (target_kind='model' AND kind='issue' AND phase IS NOT NULL AND phase IN ('story','continuity','production') AND batch_index IS NOT NULL AND batch_index BETWEEN 0 AND 8191 AND control_sequence IS NULL) OR (target_kind='question' AND kind='question' AND phase IS NULL AND batch_index IS NULL AND control_sequence IS NOT NULL AND control_sequence BETWEEN 1 AND 9)),
  CHECK ((delivered AND acknowledged_digest IS NOT NULL AND acknowledged_digest=payload_digest) OR (NOT delivered AND acknowledged_digest IS NULL)),
  FOREIGN KEY (tenant_id,project_id,run_id,cycle) REFERENCES camery_quality.cycles(tenant_id,project_id,run_id,cycle),
  FOREIGN KEY (tenant_id,project_id,run_id,cycle,phase,batch_index) REFERENCES camery_quality.batches(tenant_id,project_id,run_id,cycle,phase,batch_index),
  FOREIGN KEY (tenant_id,project_id,run_id,control_sequence) REFERENCES camery_quality.controls(tenant_id,project_id,run_id,sequence)
);
CREATE INDEX quality_outbox_pending_idx ON camery_quality.outbox(tenant_id,project_id,run_id,outbox_id COLLATE "C") WHERE NOT delivered;
CREATE INDEX quality_outbox_batch_idx ON camery_quality.outbox(tenant_id,project_id,run_id,cycle,phase,batch_index);
CREATE INDEX quality_outbox_control_idx ON camery_quality.outbox(tenant_id,project_id,run_id,control_sequence);
REVOKE ALL ON ALL TABLES IN SCHEMA camery_quality FROM PUBLIC;
REVOKE ALL ON SCHEMA camery_quality FROM PUBLIC;
