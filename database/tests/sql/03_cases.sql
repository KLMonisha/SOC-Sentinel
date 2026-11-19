-- Case identity, immutable assessments, case-event links. Rolled-back transaction.
BEGIN;

DO $$
DECLARE w jsonb; ds text; c1 text; c2 text; e_early text; e_late text; a2 uuid; r record; before_row soc.case_assessments%ROWTYPE;
BEGIN
  w := soc_test.mk_world('case-world-1');
  ds := w->>'dataset';
  PERFORM soc_test.verify_deferred();
  PERFORM soc_test.check((w->>'case') ~ '^case_[0-9a-f]{16}$', 'case id has the case_<16 hex> shape');
  PERFORM soc_test.check((w->>'case') = soc.derive_case_id(ds, '203.0.113.45', w->>'e1'), 'case id is derived from dataset + correlation key + anchor event');

  -- two incident clusters for the SAME ip: distinct cases (different anchors), same correlation key
  e_early := w->>'e1';
  e_late := soc_test.mk_event(ds, 30, 'alice', '203.0.113.45', 'authentication_failure', 'failure', '2026-11-18T14:00:00Z');
  c1 := w->>'case';
  c2 := soc_test.mk_case(ds, '203.0.113.45', e_late, ARRAY[e_late], 'Second cluster, same IP');
  PERFORM soc_test.verify_deferred();
  PERFORM soc_test.check(c1 <> c2, 'two clusters for the same IP get different case ids');
  PERFORM soc_test.check((SELECT count(*) FROM soc.cases WHERE dataset_id = ds AND correlation_key = '203.0.113.45') = 2, 'same (dataset, correlation_key) may hold several cases');

  -- stable: the id depends only on immutable inputs. Excluding evidence hypothetically changes nothing stored.
  PERFORM soc_test.check(soc.derive_case_id(ds, '203.0.113.45', e_early) = c1, 'recomputing the id from the same inputs gives the same id');
  PERFORM soc_test.check((SELECT count(*) FROM soc.case_events WHERE case_id = c1) = 3 AND (SELECT count(*) FROM soc.cases WHERE case_id = c1) = 1,
    'counterfactual simulation is read-only: stored case and evidence set unchanged');

  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.cases (case_id, dataset_id, correlation_key, anchor_event_id, title) VALUES ('case_wrong', %L, 'k', %L, 't')$f$, ds, e_early),
    '23514', 'a case_id that is not the derived id is rejected');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.cases (case_id, dataset_id, correlation_key, anchor_event_id, title) VALUES (%L, %L, '203.0.113.45', %L, 'dup')$f$, c1, ds, e_early),
    '23505', 'the same case cannot be created twice');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.cases (case_id, dataset_id, correlation_key, anchor_event_id, title) VALUES (%L, %L, 'k', 'evt_ffffffffffffffff', 't')$f$, soc.derive_case_id(ds, 'k', 'evt_ffffffffffffffff'), ds),
    '23503', 'anchor event must exist in the dataset');
END $$;

DO $$
DECLARE ds text := soc_test.mk_dataset('case-world-2'); e1 text := soc_test.mk_event(ds, 2); e2 text := soc_test.mk_event(ds, 3); v_case text; v_a uuid;
BEGIN
  BEGIN   -- case without an initial assessment is rejected at commit
    v_case := soc.derive_case_id(ds, 'k', e1);
    INSERT INTO soc.cases (case_id, dataset_id, correlation_key, anchor_event_id, title) VALUES (v_case, ds, 'k', e1, 't');
    PERFORM soc_test.verify_deferred();
    RAISE EXCEPTION 'TEST FAILED: case without revision 1 accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'SC211' THEN RAISE EXCEPTION 'TEST FAILED: expected SC211, got % (%)', SQLSTATE, SQLERRM; END IF;
    RAISE NOTICE 'PASS: a case without revision 1 is rejected at commit [SC211]';
  END;
  BEGIN   -- case whose evidence set lacks its anchor
    v_case := soc.derive_case_id(ds, 'k', e1);
    INSERT INTO soc.cases (case_id, dataset_id, correlation_key, anchor_event_id, title) VALUES (v_case, ds, 'k', e1, 't');
    INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio)
     VALUES (v_case, 1, 'initial', 'likely_benign', 'r', 'low', 5, 'low', 'low', 'c', 0.1) RETURNING assessment_id INTO v_a;
    INSERT INTO soc.case_events VALUES (v_case, ds, e2, v_a);
    PERFORM soc_test.verify_deferred();
    RAISE EXCEPTION 'TEST FAILED: case without anchor accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'SC212' THEN RAISE EXCEPTION 'TEST FAILED: expected SC212, got % (%)', SQLSTATE, SQLERRM; END IF;
    RAISE NOTICE 'PASS: a case must include its anchor event [SC212]';
  END;
END $$;

-- ---------- assessments: immutable versions
DO $$
DECLARE w jsonb := soc_test.mk_world('assess-world'); c text; a1 uuid; a2 uuid; snap soc.case_assessments%ROWTYPE; now_row soc.case_assessments%ROWTYPE;
BEGIN
  c := w->>'case'; a1 := (w->>'a1')::uuid;
  SELECT * INTO snap FROM soc.case_assessments WHERE assessment_id = a1;
  a2 := soc_test.mk_revision(c, ARRAY[w->>'e4']);
  PERFORM soc_test.verify_deferred();
  PERFORM soc_test.check((SELECT revision FROM soc.case_assessments WHERE assessment_id = a2) = 2, 'a new version gets revision 2');
  SELECT * INTO now_row FROM soc.case_assessments WHERE assessment_id = a1;
  PERFORM soc_test.check(now_row = snap, 'the original (revision 1) assessment is byte-for-byte unchanged after reassessment');
  PERFORM soc_test.check((SELECT count(*) FROM soc.case_events WHERE case_id = c) = 4, 'evidence set grew from 3 to 4 events');
  PERFORM soc_test.check((SELECT added_in_revision FROM soc.case_event_view WHERE case_id = c AND event_id = w->>'e4') = 2, 'the new event records the revision that added it');
  PERFORM soc_test.check((SELECT revision FROM soc.case_latest_assessment WHERE case_id = c) = 2 AND (SELECT event_count FROM soc.case_latest_assessment WHERE case_id = c) = 4,
    'case_latest_assessment shows the newest version with a derived event_count');

  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio)
     VALUES (%L, 4, 'investigation', 'likely_benign', 'r', 'low', 5, 'low', 'low', 'c', 0.1)$f$, c), 'SC210', 'revisions must be gap-free (3 expected, 4 given)');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio)
     VALUES (%L, 3, 'initial', 'likely_benign', 'r', 'low', 5, 'low', 'low', 'c', 0.1)$f$, c), '23514', 'only revision 1 may be cause=initial');
  PERFORM soc_test.expect_error(format($f$UPDATE soc.case_assessments SET verdict = 'likely_benign' WHERE assessment_id = %L$f$, a1), 'SC100', 'assessments cannot be updated');
  PERFORM soc_test.expect_error(format($f$DELETE FROM soc.case_assessments WHERE assessment_id = %L$f$, a1), 'SC100', 'assessments cannot be deleted');
  PERFORM soc_test.expect_error(format($f$UPDATE soc.cases SET title = 'renamed' WHERE case_id = %L$f$, c), 'SC100', 'case identity cannot be updated');

  -- enums and ranges
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio)
     VALUES (%L, 3, 'investigation', 'guilty', 'r', 'low', 5, 'low', 'low', 'c', 0.1)$f$, c), '23514', 'verdict must be one of the four contract values');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio)
     VALUES (%L, 3, 'investigation', 'likely_benign', 'r', 'low', 101, 'low', 'low', 'c', 0.1)$f$, c), '23514', 'risk_value is 0-100');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio)
     VALUES (%L, 3, 'investigation', 'likely_benign', 'r', 'low', 5, 'critical', 'low', 'c', 0.1)$f$, c), '23514', 'risk_band is low/investigate/high');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio)
     VALUES (%L, 3, 'investigation', 'likely_benign', 'r', 'low', 5, 'low', 'low', 'c', 1.5)$f$, c), '23514', 'coverage_ratio is 0-1');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio, containment_action, containment_target, containment_rationale, containment_dry_run)
     VALUES (%L, 3, 'investigation', 'likely_benign', 'r', 'low', 5, 'low', 'low', 'c', 0.1, 'Block IP', 'x', 'y', false)$f$, c), '23514', 'containment must be a dry run (false is rejected)');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio, containment_action)
     VALUES (%L, 3, 'investigation', 'likely_benign', 'r', 'low', 5, 'low', 'low', 'c', 0.1, 'Block IP')$f$, c), '23514', 'containment is all-or-nothing');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio)
     VALUES (%L, 3, 'investigation', 'likely_benign', 'low', 5, 'low', 'low', 'c', 0.1)$f$, c), '23502', 'verdict_rationale is required');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio, graph)
     VALUES (%L, 3, 'investigation', 'likely_benign', 'r', 'low', 5, 'low', 'low', 'c', 0.1, '[1]')$f$, c), '23514', 'graph must be a JSON object');
END $$;

-- ---------- case_events: dataset isolation
DO $$
DECLARE wa jsonb := soc_test.mk_world('iso-A'); wb jsonb := soc_test.mk_world('iso-B');
BEGIN
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_events VALUES (%L, %L, %L, %L)$f$, wa->>'case', wb->>'dataset', wb->>'e4', wa->>'a1'), '23503', 'an event from another dataset cannot be added to a case');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_events VALUES (%L, %L, 'evt_ffffffffffffffff', %L)$f$, wa->>'case', wa->>'dataset', wa->>'a1'), '23503', 'a case cannot reference a nonexistent event');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_events VALUES (%L, %L, %L, %L)$f$, wa->>'case', wa->>'dataset', wa->>'e4', wb->>'a1'), '23503', 'an event cannot be attributed to another case''s assessment');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.case_events VALUES (%L, %L, %L, %L)$f$, wa->>'case', wa->>'dataset', wa->>'e1', wa->>'a1'), '23505', 'an event is in a case at most once');
END $$;

ROLLBACK;
