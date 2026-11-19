-- OPTIONAL counterfactual audit tables (database/optional). Run only against a database where the optional file was applied.
BEGIN;

DO $$
DECLARE w jsonb := soc_test.mk_world('cf-world'); c text := w->>'case'; a1 uuid := (w->>'a1')::uuid; before_assess soc.case_assessments%ROWTYPE; r uuid;
  n_events integer; n_findings integer; n_assess integer;
BEGIN
  PERFORM soc_test.mk_finding(a1, 'alert_aaaaaaaaaaaaaaaa', 'supporting', ARRAY[w->>'e1', w->>'e2']);
  PERFORM soc_test.verify_deferred();
  SELECT * INTO before_assess FROM soc.case_assessments WHERE assessment_id = a1;
  SELECT count(*) INTO n_events FROM soc.case_events WHERE case_id = c;
  SELECT count(*) INTO n_findings FROM soc.findings WHERE case_id = c;
  SELECT count(*) INTO n_assess FROM soc.case_assessments WHERE case_id = c;

  SET LOCAL ROLE soc_api;
  INSERT INTO soc.counterfactual_runs (case_id, original_assessment_id, reason, recomputed, score_delta, request_id)
  VALUES (c, a1, 'Confirmed test traffic', '{"verdict":"needs_investigation","risk_score":{"value":15}}', -25, 'req-cf') RETURNING run_id INTO r;
  INSERT INTO soc.counterfactual_excluded_events VALUES (r, c, w->>'dataset', w->>'e1');
  RESET ROLE;

  PERFORM soc_test.check((SELECT count(*) FROM soc.counterfactual_excluded_events WHERE run_id = r) = 1, 'a counterfactual run and its excluded event are stored');
  PERFORM soc_test.check((SELECT a = before_assess FROM soc.case_assessments a WHERE assessment_id = a1), 'the ORIGINAL assessment is byte-for-byte unchanged by a counterfactual');
  PERFORM soc_test.check((SELECT count(*) FROM soc.case_events WHERE case_id = c) = n_events AND (SELECT count(*) FROM soc.findings WHERE case_id = c) = n_findings
    AND (SELECT count(*) FROM soc.case_assessments WHERE case_id = c) = n_assess, 'a counterfactual adds no events, findings or assessments to the case (the excluded event is still in the case)');

  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.counterfactual_excluded_events VALUES (%L, %L, %L, %L)$f$, r, c, w->>'dataset', w->>'e4'), '23503', 'only real events of the case can be excluded');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.counterfactual_runs (case_id, original_assessment_id, reason, recomputed, score_delta) VALUES (%L, %L, '   ', '{}', 0)$f$, c, a1), '23514', 'a reason is required');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.counterfactual_runs (case_id, original_assessment_id, reason, recomputed, score_delta) VALUES (%L, %L, 'x', '[]', 0)$f$, c, a1), '23514', 'recomputed must be a JSON object');
  PERFORM soc_test.expect_error(format($f$UPDATE soc.counterfactual_runs SET reason = 'edited' WHERE run_id = %L$f$, r), 'SC100', 'runs are append-only');

  -- must compare against the CURRENT stored assessment
  PERFORM soc_test.mk_revision(c, ARRAY[w->>'e4']);
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.counterfactual_runs (case_id, original_assessment_id, reason, recomputed, score_delta) VALUES (%L, %L, 'stale', '{}', 0)$f$, c, a1), 'SC240', 'a counterfactual against a superseded assessment is refused');
  PERFORM soc_test.expect_error('SELECT 1/0', '22012', 'sanity: expect_error detects division by zero');
  PERFORM soc_test.expect_error('DELETE FROM soc.counterfactual_runs', '42501', 'soc_api cannot delete runs', 'soc_api');
END $$;

ROLLBACK;
