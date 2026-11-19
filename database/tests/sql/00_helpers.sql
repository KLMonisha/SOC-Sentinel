-- Test-only helpers. Installed by the test runner into a DISPOSABLE database (schema soc_test). Never part of the migrations.
CREATE SCHEMA soc_test;
GRANT USAGE ON SCHEMA soc_test TO PUBLIC;

CREATE FUNCTION soc_test.check(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'TEST FAILED: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;

-- Runs sql (optionally as another role) and requires it to fail with the given SQLSTATE.
CREATE FUNCTION soc_test.expect_error(p_sql text, p_sqlstate text, p_label text, p_role text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF p_role IS NOT NULL THEN EXECUTE format('SET LOCAL ROLE %I', p_role); END IF;
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = p_sqlstate THEN
      RAISE NOTICE 'PASS: % [%]', p_label, SQLSTATE;
      RETURN;
    END IF;
    RAISE EXCEPTION 'TEST FAILED: % -- expected %, got % (%)', p_label, p_sqlstate, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'TEST FAILED: % -- expected error %, but the statement succeeded', p_label, p_sqlstate;
END $$;

-- Runs sql as a role and requires success.
CREATE FUNCTION soc_test.expect_ok(p_sql text, p_label text, p_role text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF p_role IS NOT NULL THEN EXECUTE format('SET LOCAL ROLE %I', p_role); END IF;
    EXECUTE p_sql;
    IF p_role IS NOT NULL THEN RESET ROLE; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'TEST FAILED: % -- unexpected error % (%)', p_label, SQLSTATE, SQLERRM;
  END;
  RAISE NOTICE 'PASS: %', p_label;
END $$;

-- Fire all deferred constraint triggers now (inside a rolled-back test transaction).
CREATE FUNCTION soc_test.verify_deferred() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
END $$;

-- ------------------------------------------------------------- fixtures (use the real derive functions, so every constraint is exercised)
CREATE FUNCTION soc_test.mk_dataset(p_seed text, p_filename text DEFAULT 'auth_logs.csv') RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_sha text := soc.sha256_hex(p_seed); v_id text := soc.derive_dataset_id(soc.sha256_hex(p_seed));
BEGIN
  INSERT INTO soc.datasets (dataset_id, file_sha256, canonical_filename, file_size_bytes, file_format, total_records, valid_events, quarantined_records)
  VALUES (v_id, v_sha, p_filename, 1000, CASE WHEN p_filename LIKE '%.json' THEN 'json' ELSE 'csv' END, 10, 10, 0);
  INSERT INTO soc.dataset_uploads (dataset_id, original_filename, was_duplicate) VALUES (v_id, p_filename, false);
  RETURN v_id;
END $$;

CREATE FUNCTION soc_test.mk_event(p_dataset text, p_line integer, p_user text DEFAULT 'alice', p_ip text DEFAULT '203.0.113.45',
  p_type text DEFAULT 'authentication_failure', p_outcome text DEFAULT 'failure', p_ts timestamptz DEFAULT '2026-11-18T10:00:00Z') RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_file text; v_raw text; v_sha text; v_id text;
BEGIN
  SELECT canonical_filename INTO v_file FROM soc.datasets WHERE dataset_id = p_dataset;
  v_raw := format('%s,%s,%s,%s,server-01', to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), p_user, p_ip, p_type);
  v_sha := soc.sha256_hex(v_raw);
  v_id := soc.derive_event_id(p_dataset, v_file, p_line, v_sha);
  INSERT INTO soc.source_events (dataset_id, event_id, timestamp, event_type, username, source_ip, host, outcome, source_file, line_number, raw_text, raw_sha256)
  VALUES (p_dataset, v_id, p_ts, p_type, p_user, p_ip, 'server-01', p_outcome, v_file, p_line, v_raw, v_sha);
  RETURN v_id;
END $$;

CREATE FUNCTION soc_test.mk_case(p_dataset text, p_corr text, p_anchor text, p_events text[], p_title text DEFAULT 'Test case') RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_case text := soc.derive_case_id(p_dataset, p_corr, p_anchor); v_a uuid;
BEGIN
  INSERT INTO soc.cases (case_id, dataset_id, correlation_key, anchor_event_id, title) VALUES (v_case, p_dataset, p_corr, p_anchor, p_title);
  INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio)
  VALUES (v_case, 1, 'initial', 'needs_investigation', 'rationale', 'medium', 40, 'investigate', 'low', 'confidence rationale', 0.5) RETURNING assessment_id INTO v_a;
  INSERT INTO soc.case_events (case_id, dataset_id, event_id, added_in_assessment_id) SELECT v_case, p_dataset, e, v_a FROM unnest(p_events) e;
  RETURN v_case;
END $$;

CREATE FUNCTION soc_test.latest(p_case text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT assessment_id FROM soc.case_assessments WHERE case_id = p_case ORDER BY revision DESC LIMIT 1 $$;

CREATE FUNCTION soc_test.mk_revision(p_case text, p_events text[], p_verdict text DEFAULT 'likely_malicious') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_rev integer; v_a uuid; v_ds text;
BEGIN
  SELECT coalesce(max(revision), 0) + 1 INTO v_rev FROM soc.case_assessments WHERE case_id = p_case;
  SELECT dataset_id INTO v_ds FROM soc.cases WHERE case_id = p_case;
  INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio)
  VALUES (p_case, v_rev, 'investigation', p_verdict, 'new rationale', 'high', 70, 'high', 'medium', 'new confidence', 0.8) RETURNING assessment_id INTO v_a;
  INSERT INTO soc.case_events (case_id, dataset_id, event_id, added_in_assessment_id) SELECT p_case, v_ds, e, v_a FROM unnest(p_events) e;
  RETURN v_a;
END $$;

CREATE FUNCTION soc_test.mk_finding(p_assessment uuid, p_id text, p_stance text, p_events text[], p_weight numeric DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_case text; v_ds text; e text; i integer := 0;
BEGIN
  SELECT case_id INTO v_case FROM soc.case_assessments WHERE assessment_id = p_assessment;
  SELECT dataset_id INTO v_ds FROM soc.cases WHERE case_id = v_case;
  INSERT INTO soc.findings (assessment_id, case_id, finding_id, rule_id, title, description, severity, stance, weight)
  VALUES (p_assessment, v_case, p_id, 'DET-001', 'A finding', 'desc', 'high', p_stance, coalesce(p_weight, CASE WHEN p_stance = 'supporting' THEN 25 ELSE -5 END));
  FOREACH e IN ARRAY p_events LOOP
    i := i + 1;
    INSERT INTO soc.finding_events (assessment_id, finding_id, case_id, dataset_id, event_id, ordinal) VALUES (p_assessment, p_id, v_case, v_ds, e, i);
  END LOOP;
END $$;

CREATE FUNCTION soc_test.mk_report(p_case text, p_assessment uuid, p_method text DEFAULT 'llm') RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_id text;
BEGIN
  INSERT INTO soc.reports (case_id, assessment_id, generated_by, summary, verdict_rationale, citation_total, citation_verified, citation_rejected, llm_model, fallback_reason)
  VALUES (p_case, p_assessment, p_method, 'summary', 'rationale', 0, 0, 0, CASE WHEN p_method = 'llm' THEN 'test-model' END, CASE WHEN p_method = 'template_fallback' THEN 'llm unavailable' END)
  RETURNING report_id INTO v_id;
  RETURN v_id;
END $$;

-- A complete small case used by many tests: dataset, 3 events, case anchored on event 1.
CREATE FUNCTION soc_test.mk_world(p_seed text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_ds text; e1 text; e2 text; e3 text; e4 text; v_case text;
BEGIN
  v_ds := soc_test.mk_dataset(p_seed);
  e1 := soc_test.mk_event(v_ds, 2, 'alice', '203.0.113.45', 'authentication_failure', 'failure', '2026-11-18T10:00:00Z');
  e2 := soc_test.mk_event(v_ds, 3, 'alice', '203.0.113.45', 'authentication_failure', 'failure', '2026-11-18T10:01:00Z');
  e3 := soc_test.mk_event(v_ds, 4, 'alice', '203.0.113.45', 'authentication_success', 'success', '2026-11-18T10:02:00Z');
  e4 := soc_test.mk_event(v_ds, 5, 'alice', '203.0.113.45', 'web_access', 'success', '2026-11-18T10:05:00Z');   -- NOT in the case initially (retrievable)
  v_case := soc_test.mk_case(v_ds, '203.0.113.45', e1, ARRAY[e1, e2, e3]);
  RETURN jsonb_build_object('dataset', v_ds, 'e1', e1, 'e2', e2, 'e3', e3, 'e4', e4, 'case', v_case, 'a1', soc_test.latest(v_case));
END $$;
