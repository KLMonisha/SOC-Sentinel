-- Table creation, primary/foreign/unique keys, required columns. Read-only catalog checks.
BEGIN;

DO $$
DECLARE
  expected text[] := ARRAY['datasets','dataset_uploads','quarantined_records','source_events','cases','case_assessments','case_events','findings','finding_events',
    'attack_mappings','attack_mapping_events','missing_evidence','reports','report_claims','report_claim_citations','analyst_decisions',
    'planner_candidates','investigation_queries','investigation_query_events','adversarial_runs','adversarial_pipeline_results','adversarial_trials'];
  t text; n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'soc' AND c.relkind = 'r';
  PERFORM soc_test.check(n = array_length(expected, 1), format('exactly %s base tables exist in schema soc (found %s)', array_length(expected, 1), n));
  FOREACH t IN ARRAY expected LOOP
    PERFORM soc_test.check(to_regclass('soc.' || t) IS NOT NULL, 'table exists: soc.' || t);
    PERFORM soc_test.check(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ('soc.' || t)::regclass AND contype = 'p'), 'primary key: soc.' || t);
  END LOOP;
  PERFORM soc_test.check(NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relname = ANY (expected)),
    'no SOC table leaked into the public (API-exposed) schema');
END $$;

-- expected foreign keys (referencing table -> referenced table); every one must exist and be ON DELETE RESTRICT / NO ACTION
DO $$
DECLARE r record; fks text[][] := ARRAY[
  ['dataset_uploads','datasets'],['quarantined_records','datasets'],['source_events','datasets'],
  ['cases','datasets'],['cases','source_events'],['case_assessments','cases'],
  ['case_events','cases'],['case_events','source_events'],['case_events','case_assessments'],
  ['findings','case_assessments'],['finding_events','findings'],['finding_events','case_events'],
  ['attack_mappings','case_assessments'],['attack_mapping_events','attack_mappings'],['attack_mapping_events','case_events'],['missing_evidence','case_assessments'],
  ['reports','case_assessments'],['report_claims','reports'],['report_claim_citations','report_claims'],['report_claim_citations','reports'],['report_claim_citations','case_events'],
  ['analyst_decisions','case_assessments'],['planner_candidates','case_assessments'],
  ['investigation_queries','cases'],['investigation_queries','case_assessments'],['investigation_query_events','investigation_queries'],['investigation_query_events','case_events'],
  ['adversarial_pipeline_results','adversarial_runs'],['adversarial_trials','adversarial_pipeline_results']];
  i integer;
BEGIN
  FOR i IN 1 .. array_length(fks, 1) LOOP
    PERFORM soc_test.check(EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = ('soc.' || fks[i][1])::regclass AND confrelid = ('soc.' || fks[i][2])::regclass),
      format('foreign key %s -> %s', fks[i][1], fks[i][2]));
  END LOOP;
  FOR r IN SELECT conrelid::regclass AS t, conname, confdeltype FROM pg_constraint WHERE contype = 'f' AND connamespace = 'soc'::regnamespace LOOP
    PERFORM soc_test.check(r.confdeltype IN ('a', 'r'), format('no cascading delete on %s (%s)', r.t, r.conname));
  END LOOP;
  PERFORM soc_test.check(NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND connamespace = 'soc'::regnamespace AND confupdtype = 'c'), 'no cascading update on any soc foreign key');
END $$;

-- unique constraints / indexes that carry contracts
DO $$
DECLARE u text[][] := ARRAY[
  ['datasets','datasets_file_sha256_key'],['source_events','events_file_line'],['cases','cases_natural_key'],['case_assessments','assessments_case_revision'],
  ['investigation_queries','queries_idem'],['investigation_queries','queries_seq'],['dataset_uploads','uploads_one_first_per_dataset'],['report_claims','claims_order']]; i integer;
BEGIN
  FOR i IN 1 .. array_length(u, 1) LOOP
    PERFORM soc_test.check(EXISTS (SELECT 1 FROM pg_class c JOIN pg_index x ON x.indexrelid = c.oid WHERE c.relname = u[i][2] AND x.indisunique),
      format('unique key %s on %s', u[i][2], u[i][1]));
  END LOOP;
END $$;

-- required (NOT NULL) columns
DO $$
DECLARE need text[][] := ARRAY[
  ['datasets','file_sha256'],['datasets','canonical_filename'],['dataset_uploads','original_filename'],['source_events','raw_text'],['source_events','raw_sha256'],
  ['source_events','source_file'],['source_events','line_number'],['source_events','timestamp'],['source_events','outcome'],['cases','anchor_event_id'],
  ['case_assessments','verdict'],['case_assessments','risk_value'],['case_assessments','risk_band'],['case_assessments','confidence_level'],['case_assessments','coverage_ratio'],
  ['findings','stance'],['findings','weight'],['reports','generated_by'],['report_claim_citations','cited_event_id'],['analyst_decisions','analyst_id'],
  ['analyst_decisions','dry_run'],['analyst_decisions','assessment_id'],['investigation_queries','idempotency_key'],['investigation_queries','request_hash'],
  ['adversarial_trials','injection_succeeded']]; i integer;
BEGIN
  FOR i IN 1 .. array_length(need, 1) LOOP
    PERFORM soc_test.check(EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ('soc.' || need[i][1])::regclass AND attname = need[i][2] AND attnotnull),
      format('NOT NULL: %s.%s', need[i][1], need[i][2]));
  END LOOP;
END $$;

-- nullable-on-purpose columns really are nullable (missing is representable, not forced)
DO $$
BEGIN
  PERFORM soc_test.check(NOT (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'soc.source_events'::regclass AND attname = 'username'), 'source_events.username may be NULL');
  PERFORM soc_test.check(NOT (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'soc.analyst_decisions'::regclass AND attname = 'note'), 'analyst_decisions.note may be NULL');
  PERFORM soc_test.check(NOT (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'soc.source_events'::regclass AND attname = 'canonical_json_sha256'), 'legacy canonical_json_sha256 may be NULL');
END $$;

-- views exist and use the caller's privileges
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['case_event_view','case_latest_assessment','report_citation_audit','case_status','case_current','planner_candidate_state','adversarial_run_summary'] LOOP
    PERFORM soc_test.check(EXISTS (SELECT 1 FROM pg_class WHERE oid = ('soc.' || v)::regclass AND relkind = 'v' AND reloptions @> ARRAY['security_invoker=true']), 'security_invoker view: soc.' || v);
  END LOOP;
END $$;

-- jsonb columns are shape-checked (the quarantine row is intentionally free-form)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'soc' AND c.relkind = 'r' AND a.atttypid = 'jsonb'::regtype AND NOT a.attisdropped AND NOT (c.relname = 'quarantined_records') LOOP
    PERFORM soc_test.check(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = ('soc.' || r.relname)::regclass AND k.contype = 'c'
                                    AND (pg_get_constraintdef(k.oid) ILIKE '%jsonb_typeof(' || r.attname || ')%' OR pg_get_constraintdef(k.oid) ILIKE '%jsonb_all_strings(' || r.attname || ')%')),
      format('jsonb shape check on %s.%s', r.relname, r.attname));
  END LOOP;
END $$;

ROLLBACK;
