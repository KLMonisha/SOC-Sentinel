-- SOC Sentinel - P0 - foundation + ingestion
-- Schema `soc` (private), roles, security helpers, deterministic id functions,
-- datasets, dataset_uploads, quarantined_records, source_events.
--
-- Non-destructive: contains no DROP / TRUNCATE / DELETE. Safe on an empty Supabase PostgreSQL 17 database.
-- No extensions are required (uses core sha256(), gen_random_uuid()).
-- No secrets: the soc_api / soc_readonly roles are created WITHOUT a password. Set one manually (see database/README.md).

CREATE SCHEMA soc;
COMMENT ON SCHEMA soc IS 'SOC Sentinel forensic store. Private: never add to the Supabase Data API exposed schemas.';
REVOKE ALL ON SCHEMA soc FROM PUBLIC;

-- ---------------------------------------------------------------- roles
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'soc_api') THEN
    CREATE ROLE soc_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'soc_readonly') THEN
    CREATE ROLE soc_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
  END IF;
END $$;

-- Timeouts bound every failure mode of the investigation budget (see database/SCHEMA_DESIGN.md section 6).
ALTER ROLE soc_api SET search_path = soc, pg_catalog;
ALTER ROLE soc_api SET statement_timeout = '30s';
ALTER ROLE soc_api SET lock_timeout = '10s';
ALTER ROLE soc_api SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE soc_readonly SET search_path = soc, pg_catalog;
ALTER ROLE soc_readonly SET statement_timeout = '30s';
ALTER ROLE soc_readonly SET default_transaction_read_only = on;

GRANT USAGE ON SCHEMA soc TO soc_api, soc_readonly;

-- ---------------------------------------------------------------- deterministic id functions
-- These are the single definition of every derived identifier. The backend must reproduce them exactly
-- (reference vectors: database/tests/vectors.json). Separator is the ASCII unit separator, chr(31).

CREATE FUNCTION soc.sha256_hex(p_text text) RETURNS text
LANGUAGE sql STABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex') $$;

CREATE FUNCTION soc.derive_dataset_id(p_file_sha256 text) RETURNS text
LANGUAGE sql STABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT 'ds_' || left(p_file_sha256, 16) $$;

CREATE FUNCTION soc.derive_event_id(p_dataset_id text, p_source_file text, p_line_number integer, p_raw_sha256 text) RETURNS text
LANGUAGE sql STABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT 'evt_' || left(soc.sha256_hex(concat_ws(chr(31), p_dataset_id, p_source_file, p_line_number::text, p_raw_sha256)), 16) $$;

CREATE FUNCTION soc.derive_case_id(p_dataset_id text, p_correlation_key text, p_anchor_event_id text) RETURNS text
LANGUAGE sql STABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT 'case_' || left(soc.sha256_hex(concat_ws(chr(31), p_dataset_id, p_correlation_key, p_anchor_event_id)), 16) $$;

-- ---------------------------------------------------------------- generic helpers
CREATE FUNCTION soc.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'soc.% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'SC100';
END $$;

CREATE FUNCTION soc.jsonb_all_strings(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT p IS NULL OR (jsonb_typeof(p) = 'object' AND NOT EXISTS (SELECT 1 FROM jsonb_each(p) e WHERE jsonb_typeof(e.value) <> 'string')) $$;

-- Applies the standard security posture to a table. Owner/migration use only.
--   * RLS enabled AND forced (so even the owner is subject to policy, unless it holds BYPASSRLS as Supabase's postgres does)
--   * no access for PUBLIC / anon / authenticated / service_role
--   * soc_api: SELECT + INSERT only; soc_readonly: SELECT only; NO UPDATE / DELETE / TRUNCATE for anyone
--   * policies exist only for SELECT and INSERT (everything else is denied by default)
--   * append-only triggers (row UPDATE/DELETE and statement TRUNCATE) as a second line of defence
CREATE FUNCTION soc.secure_table(p_table regclass) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE r text;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', p_table);
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON %s FROM %I', p_table, r);
    END IF;
  END LOOP;
  EXECUTE format('GRANT SELECT, INSERT ON %s TO soc_api', p_table);
  EXECUTE format('GRANT SELECT ON %s TO soc_readonly', p_table);
  EXECUTE format('CREATE POLICY soc_select ON %s FOR SELECT TO soc_api, soc_readonly USING (true)', p_table);
  EXECUTE format('CREATE POLICY soc_insert ON %s FOR INSERT TO soc_api WITH CHECK (true)', p_table);
  EXECUTE format('CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION soc.forbid_mutation()', p_table);
  EXECUTE format('CREATE TRIGGER trg_no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION soc.forbid_mutation()', p_table);
END $$;
REVOKE ALL ON FUNCTION soc.secure_table(regclass) FROM PUBLIC;
REVOKE ALL ON FUNCTION soc.forbid_mutation() FROM PUBLIC;

-- ---------------------------------------------------------------- datasets (content identity)
CREATE TABLE soc.datasets (
  dataset_id          text PRIMARY KEY,
  file_sha256         text NOT NULL UNIQUE,
  canonical_filename  text NOT NULL,
  file_size_bytes     integer NOT NULL,
  file_format         text NOT NULL,
  total_records       integer NOT NULL,
  valid_events        integer NOT NULL,
  quarantined_records integer NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT datasets_sha_format CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT datasets_id_derived CHECK (dataset_id = soc.derive_dataset_id(file_sha256)),
  CONSTRAINT datasets_filename CHECK (char_length(canonical_filename) BETWEEN 1 AND 255 AND canonical_filename !~ '[/\\]' AND canonical_filename !~ '[[:cntrl:]]'),
  CONSTRAINT datasets_size CHECK (file_size_bytes > 0 AND file_size_bytes <= 10485760),
  CONSTRAINT datasets_format CHECK (file_format IN ('csv', 'json')),
  CONSTRAINT datasets_counts CHECK (total_records >= 0 AND valid_events >= 0 AND quarantined_records >= 0 AND valid_events + quarantined_records = total_records)
);
COMMENT ON TABLE soc.datasets IS 'One row per distinct file CONTENT (SHA-256 of the uploaded bytes). Re-uploading identical bytes resolves to this row; every upload is kept in dataset_uploads.';
COMMENT ON COLUMN soc.datasets.canonical_filename IS 'Filename of the first upload. Used as source_file on every event of this dataset so event ids stay stable.';

-- ---------------------------------------------------------------- dataset_uploads (provenance history)
CREATE TABLE soc.dataset_uploads (
  upload_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id        text NOT NULL REFERENCES soc.datasets (dataset_id) ON DELETE RESTRICT,
  original_filename text NOT NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  was_duplicate     boolean NOT NULL,
  request_id        text,
  CONSTRAINT uploads_filename CHECK (char_length(original_filename) BETWEEN 1 AND 255 AND original_filename !~ '[/\\]' AND original_filename !~ '[[:cntrl:]]')
);
COMMENT ON TABLE soc.dataset_uploads IS 'Append-only upload history. Identical bytes under any filename add a row here (was_duplicate = true) and resolve to the same dataset.';
CREATE UNIQUE INDEX uploads_one_first_per_dataset ON soc.dataset_uploads (dataset_id) WHERE NOT was_duplicate;
CREATE INDEX uploads_dataset_time ON soc.dataset_uploads (dataset_id, uploaded_at);

-- Every dataset must have exactly one non-duplicate (first) upload whose filename is the canonical one. Checked at commit.
CREATE FUNCTION soc.check_dataset_has_first_upload() RETURNS trigger
LANGUAGE plpgsql SET search_path = soc, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM soc.dataset_uploads u WHERE u.dataset_id = NEW.dataset_id AND NOT u.was_duplicate AND u.original_filename = NEW.canonical_filename) THEN
    RAISE EXCEPTION 'dataset % needs a first (non-duplicate) upload named %', NEW.dataset_id, NEW.canonical_filename USING ERRCODE = 'SC001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_dataset_first_upload AFTER INSERT ON soc.datasets DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION soc.check_dataset_has_first_upload();

-- ---------------------------------------------------------------- quarantined_records
CREATE TABLE soc.quarantined_records (
  dataset_id  text NOT NULL REFERENCES soc.datasets (dataset_id) ON DELETE RESTRICT,
  row_number  integer NOT NULL,
  reason      text NOT NULL,
  raw_record  jsonb,
  PRIMARY KEY (dataset_id, row_number),
  CONSTRAINT quarantine_row CHECK (row_number >= 1),
  CONSTRAINT quarantine_reason CHECK (char_length(reason) BETWEEN 1 AND 2000)
);
COMMENT ON TABLE soc.quarantined_records IS 'Rows rejected at normalization (validation_errors[]). raw_record is never returned by the API.';

-- ---------------------------------------------------------------- source_events (the evidence)
CREATE TABLE soc.source_events (
  dataset_id            text NOT NULL REFERENCES soc.datasets (dataset_id) ON DELETE RESTRICT,
  event_id              text NOT NULL,
  timestamp             timestamptz NOT NULL,
  event_type            text NOT NULL,
  username              text,
  source_ip             text,
  destination_ip        text,
  host                  text,
  resource              text,
  outcome               text NOT NULL,
  source_file           text NOT NULL,
  line_number           integer NOT NULL,
  raw_text              text NOT NULL,
  raw_sha256            text NOT NULL,
  canonical_json_sha256 text,
  raw_record            jsonb,
  ingested_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, event_id),
  CONSTRAINT events_id_derived CHECK (event_id = soc.derive_event_id(dataset_id, source_file, line_number, raw_sha256)),
  CONSTRAINT events_raw_hash_matches CHECK (raw_sha256 = soc.sha256_hex(raw_text)),
  CONSTRAINT events_canon_hash_format CHECK (canonical_json_sha256 IS NULL OR canonical_json_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT events_outcome CHECK (outcome IN ('success', 'failure', 'unknown')),
  CONSTRAINT events_line CHECK (line_number >= 1),
  CONSTRAINT events_source_file CHECK (char_length(source_file) BETWEEN 1 AND 255 AND source_file !~ '[/\\]'),
  CONSTRAINT events_type CHECK (char_length(event_type) BETWEEN 1 AND 100),
  CONSTRAINT events_raw_nonempty CHECK (raw_text <> ''),
  CONSTRAINT events_raw_record_object CHECK (raw_record IS NULL OR jsonb_typeof(raw_record) = 'object'),
  CONSTRAINT events_field_lengths CHECK (
    coalesce(char_length(username), 0) <= 512 AND coalesce(char_length(source_ip), 0) <= 128 AND coalesce(char_length(destination_ip), 0) <= 128
    AND coalesce(char_length(host), 0) <= 512 AND coalesce(char_length(resource), 0) <= 4096)
);
COMMENT ON TABLE soc.source_events IS 'Every valid normalized event with its verbatim original record. Append-only.';
COMMENT ON COLUMN soc.source_events.raw_text IS 'Verbatim original record (CSV line / serialized JSON element). Never normalized. Untrusted.';
COMMENT ON COLUMN soc.source_events.raw_sha256 IS 'SHA-256 (hex) of raw_text as UTF-8. This is the API field raw_hash. Verified by CHECK.';
COMMENT ON COLUMN soc.source_events.canonical_json_sha256 IS 'LEGACY backend hash: SHA-256 of canonical JSON of the PARSED record. Kept for transition cross-checks only; not an integrity anchor.';
COMMENT ON COLUMN soc.source_events.line_number IS 'CSV: 1-based physical line where the record starts (header = line 1). JSON: 1-based element index.';
COMMENT ON COLUMN soc.source_events.source_ip IS 'text, not inet: log values are unvalidated and must never be rejected.';

CREATE UNIQUE INDEX events_file_line ON soc.source_events (dataset_id, source_file, line_number);
CREATE INDEX events_replay_order ON soc.source_events (dataset_id, timestamp, source_file, line_number, event_id);
CREATE INDEX events_by_user ON soc.source_events (dataset_id, username, timestamp) WHERE username IS NOT NULL;
CREATE INDEX events_by_ip ON soc.source_events (dataset_id, source_ip, timestamp) WHERE source_ip IS NOT NULL;
CREATE INDEX events_by_host ON soc.source_events (dataset_id, host, timestamp) WHERE host IS NOT NULL;
CREATE INDEX events_by_type ON soc.source_events (dataset_id, event_type, outcome);

-- ---------------------------------------------------------------- security
SELECT soc.secure_table('soc.datasets');
SELECT soc.secure_table('soc.dataset_uploads');
SELECT soc.secure_table('soc.quarantined_records');
SELECT soc.secure_table('soc.source_events');

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA soc FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soc.sha256_hex(text), soc.derive_dataset_id(text), soc.derive_event_id(text, text, integer, text),
  soc.derive_case_id(text, text, text), soc.jsonb_all_strings(jsonb) TO soc_api, soc_readonly;
-- trigger functions run as the invoking role and need EXECUTE for it
GRANT EXECUTE ON FUNCTION soc.forbid_mutation(), soc.check_dataset_has_first_upload() TO soc_api;
