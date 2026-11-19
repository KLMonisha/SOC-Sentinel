-- Investigation planner, 3-query budget, idempotency, failure behaviour. Rolled-back transaction, run AS soc_api
-- (the real backend role) wherever the function protocol is exercised. Concurrency / timeout tests live in run_tests.py.
BEGIN;


DO $$
DECLARE w jsonb := soc_test.mk_world('inv-world'); c text := w->>'case'; ds text := w->>'dataset'; a1 uuid := (w->>'a1')::uuid; a2 uuid;
  b record; q1 uuid; q1b uuid; req text := soc.sha256_hex('{"tool":"get_post_login_activity","params":{"username":"alice"}}'); n integer;
BEGIN
  PERFORM soc_test.verify_deferred();
  INSERT INTO soc.planner_candidates (assessment_id, case_id, ordinal, tool, params, relevance, expected_uncertainty_reduction, retrieval_cost, recommended, reason)
  VALUES (a1, c, 1, 'get_post_login_activity', '{"username":"alice"}', 0.9, 0.8, 1, true, 'Post-login behaviour best separates benign recovery from takeover.'),
         (a1, c, 2, 'get_ip_context', '{"ip":"203.0.113.45"}', 0.5, 0.4, 1, false, 'IP context.');
  PERFORM soc_test.check((SELECT count(*) FROM soc.planner_candidate_state WHERE assessment_id = a1 AND NOT used) = 2, 'planner candidates are proposals; none is "used" before a query runs');

  SET LOCAL ROLE soc_api;   -- from here on: exactly what the FastAPI backend can do
  SELECT * INTO b FROM soc.begin_investigation_query(c, 'key-0001-abcdef', req);
  PERFORM soc_test.check(b.outcome = 'proceed' AND b.budget_total = 3 AND b.budget_remaining = 3 AND b.sequence_no = 1, 'begin: proceed with the full budget of 3 (nothing is charged yet)');
  PERFORM soc_test.check((SELECT remaining FROM soc.investigation_budget(c)) = 3, 'begin alone does not consume budget');

  -- the case changes: new assessment + the retrieved event folded in, then the query is recorded
  RESET ROLE; a2 := soc_test.mk_revision(c, ARRAY[w->>'e4']); SET LOCAL ROLE soc_api;
  q1 := soc.record_investigation_query(c, 'key-0001-abcdef', 'get_post_login_activity', '{"username":"alice"}', req, 'reason', a1, a2, jsonb_build_array(w->>'e4'), 'req-1');
  PERFORM soc_test.check(q1 IS NOT NULL, 'record: the executed query is stored');
  PERFORM soc_test.check((SELECT remaining FROM soc.investigation_budget(c)) = 2 AND (SELECT used FROM soc.investigation_budget(c)) = 1, 'budget is now 2 remaining / 1 used (derived from the ledger)');
  PERFORM soc_test.check((SELECT budget_remaining_after FROM soc.investigation_queries WHERE query_id = q1) = 2 AND (SELECT sequence_no FROM soc.investigation_queries WHERE query_id = q1) = 1, 'ledger row: sequence 1, 2 remaining');
  PERFORM soc_test.check((SELECT was_new_to_case FROM soc.investigation_query_events WHERE query_id = q1), 'the retrieved event is flagged as new to the case');
  PERFORM soc_test.check((SELECT before_assessment_id = a1 AND after_assessment_id = a2 FROM soc.investigation_queries WHERE query_id = q1), 'before/after assessments recorded (previous + updated)');
  PERFORM soc_test.check((SELECT used FROM soc.planner_candidate_state WHERE assessment_id = a1 AND ordinal = 1), 'the executed candidate is now derived as used');

  -- idempotent replay: same key + same request: stored result, NO second charge
  SELECT * INTO b FROM soc.begin_investigation_query(c, 'key-0001-abcdef', req);
  PERFORM soc_test.check(b.outcome = 'replay' AND b.query_id = q1 AND b.budget_remaining = 2, 'begin with the same key: replay of the stored query, budget unchanged');
  q1b := soc.record_investigation_query(c, 'key-0001-abcdef', 'get_post_login_activity', '{"username":"alice"}', req, 'reason', a1, a2, jsonb_build_array(w->>'e4'));
  PERFORM soc_test.check(q1b = q1 AND (SELECT used FROM soc.investigation_budget(c)) = 1, 'record with the same key is a no-op returning the same query (retry-safe, charged once)');
  PERFORM soc_test.check((SELECT count(*) FROM soc.investigation_queries WHERE case_id = c) = 1, 'a retry created no extra ledger row');

  -- same key, different request
  PERFORM soc_test.expect_error(format($f$SELECT * FROM soc.begin_investigation_query(%L, 'key-0001-abcdef', %L)$f$, c, soc.sha256_hex('another request')), 'SC002', 'same key with a different request is refused (begin)');
  PERFORM soc_test.expect_error(format($f$SELECT soc.record_investigation_query(%L, 'key-0001-abcdef', 'get_ip_context', '{}', %L, 'r', %L, %L, '[]')$f$, c, soc.sha256_hex('another request'), a2, a2), 'SC002', 'same key with a different request is refused (record)');
  PERFORM soc_test.check((SELECT used FROM soc.investigation_budget(c)) = 1, 'refused requests are not charged');
END $$;

DO $$
DECLARE w jsonb := soc_test.mk_world('inv-world-2'); c text := w->>'case'; a1 uuid := (w->>'a1')::uuid; b record; i integer; h text; q uuid;
BEGIN
  PERFORM soc_test.verify_deferred();
  SET LOCAL ROLE soc_api;
  -- three queries with no change (empty results): each costs one
  FOR i IN 1 .. 3 LOOP
    h := soc.sha256_hex('req-' || i);
    SELECT * INTO b FROM soc.begin_investigation_query(c, 'empty-key-' || i || '-abcdef', h);
    PERFORM soc_test.check(b.outcome = 'proceed' AND b.sequence_no = i AND b.budget_remaining = 4 - i, format('query %s of 3: proceed, %s remaining before', i, 4 - i));
    q := soc.record_investigation_query(c, 'empty-key-' || i || '-abcdef', 'get_ip_context', jsonb_build_object('ip', 'x' || i), h, 'no results', a1, a1, '[]'::jsonb);
  END LOOP;
  PERFORM soc_test.check((SELECT remaining FROM soc.investigation_budget(c)) = 0, 'budget exhausted after three queries, even though none returned evidence');
  PERFORM soc_test.check((SELECT count(*) FROM soc.investigation_query_events WHERE case_id = c) = 0, 'an empty result is a valid charged outcome (no event rows)');
  PERFORM soc_test.expect_error(format($f$SELECT * FROM soc.begin_investigation_query(%L, 'fourth-key-abcdef', %L)$f$, c, soc.sha256_hex('r4')), 'SC001', 'the 4th query is refused (INVESTIGATION_BUDGET_EXHAUSTED)');
  PERFORM soc_test.expect_error(format($f$SELECT soc.record_investigation_query(%L, 'fourth-key-abcdef', 'get_ip_context', '{}', %L, 'r', %L, %L, '[]')$f$, c, soc.sha256_hex('r4'), a1, a1), 'SC001', 'record also refuses beyond the budget');
  -- replay of an old key still works at zero budget (idempotent, free)
  SELECT * INTO b FROM soc.begin_investigation_query(c, 'empty-key-2-abcdef', soc.sha256_hex('req-2'));
  PERFORM soc_test.check(b.outcome = 'replay' AND b.budget_remaining = 1, 'replaying an old key at zero budget still returns the stored result');
  -- a client that bypasses the functions still cannot exceed the budget or skip the sequence
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.investigation_queries (case_id, idempotency_key, tool, request_hash, sequence_no, reason, before_assessment_id, after_assessment_id, budget_remaining_after)
     VALUES (%L, 'direct-insert-abcdef', 'get_ip_context', %L, 4, 'r', %L, %L, 0)$f$, c, soc.sha256_hex('x'), a1, a1), 'SC001', 'direct INSERT cannot exceed the budget either (DB backstop)');
END $$;

DO $$
DECLARE w jsonb := soc_test.mk_world('inv-world-3'); c text := w->>'case'; a1 uuid := (w->>'a1')::uuid; a2 uuid; h text := soc.sha256_hex('r'); q uuid; b record;
BEGIN
  PERFORM soc_test.verify_deferred();
  SET LOCAL ROLE soc_api;
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.investigation_queries (case_id, idempotency_key, tool, request_hash, sequence_no, reason, before_assessment_id, after_assessment_id, budget_remaining_after)
     VALUES (%L, 'skip-sequence-abcd', 'get_ip_context', %L, 2, 'r', %L, %L, 1)$f$, c, h, a1, a1), 'SC005', 'direct INSERT cannot skip the sequence');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.investigation_queries (case_id, idempotency_key, tool, request_hash, sequence_no, reason, before_assessment_id, after_assessment_id, budget_remaining_after)
     VALUES (%L, 'wrong-remaining-abc', 'get_ip_context', %L, 1, 'r', %L, %L, 0)$f$, c, h, a1, a1), 'SC005', 'budget_remaining_after must match the ledger');
  PERFORM soc_test.expect_error(format($f$SELECT * FROM soc.begin_investigation_query('case_nope0000000000', 'unknown-case-abcd', %L)$f$, h), 'SC404', 'unknown case is reported as such');
  PERFORM soc_test.expect_error(format($f$SELECT soc.record_investigation_query(%L, 'short', 'get_ip_context', '{}', %L, 'r', %L, %L, '[]')$f$, c, h, a1, a1), '23514', 'idempotency keys must be 8-128 safe characters');
  PERFORM soc_test.expect_error(format($f$SELECT soc.record_investigation_query(%L, 'bad-tool-abcdef', 'drop_tables', '{}', %L, 'r', %L, %L, '[]')$f$, c, h, a1, a1), '23514', 'only the three agreed tools are accepted');
  PERFORM soc_test.expect_error(format($f$SELECT soc.record_investigation_query(%L, 'bad-params-abcdef', 'get_ip_context', '{"ip":5}', %L, 'r', %L, %L, '[]')$f$, c, h, a1, a1), '23514', 'params must be an object of strings');
  PERFORM soc_test.expect_error(format($f$SELECT soc.record_investigation_query(%L, 'bad-hash-abcdef', 'get_ip_context', '{}', 'nothex', 'r', %L, %L, '[]')$f$, c, a1, a1), '23514', 'request_hash must be 64 hex');
  PERFORM soc_test.expect_error(format($f$SELECT soc.record_investigation_query(%L, 'bad-array-abcdef', 'get_ip_context', '{}', %L, 'r', %L, %L, '{"a":1}')$f$, c, h, a1, a1), 'SC006', 'retrieved events must be a JSON array');
  PERFORM soc_test.expect_error(format($f$SELECT soc.record_investigation_query(%L, 'unknown-evt-abcdef', 'get_ip_context', '{}', %L, 'r', %L, %L, '["evt_ffffffffffffffff"]')$f$, c, h, a1, a1), 'SC007', 'a retrieved event must already be in the case');
  PERFORM soc_test.expect_error(format($f$SELECT soc.record_investigation_query(%L, 'stale-after-abcdef', 'get_ip_context', '{}', %L, 'r', %L, %L, '[]')$f$, c, h, a1, (soc_test.mk_world('inv-other')->>'a1')::uuid), 'SC003', 'p_after must be the newest assessment of THIS case (stale / foreign assessment refused)');
  PERFORM soc_test.check((SELECT used FROM soc.investigation_budget(c)) = 0, 'none of the failed attempts above cost any budget');
END $$;

-- failure atomicity: a query recorded and then an error before COMMIT leaves no trace (the protocol runs in one transaction)
DO $$
DECLARE w jsonb := soc_test.mk_world('inv-world-4'); c text := w->>'case'; a1 uuid := (w->>'a1')::uuid; a2 uuid; h text := soc.sha256_hex('rr'); q uuid;
BEGIN
  PERFORM soc_test.verify_deferred();
  BEGIN
    SET LOCAL ROLE soc_api;
    PERFORM * FROM soc.begin_investigation_query(c, 'atomic-key-abcdef', h);
    RESET ROLE; a2 := soc_test.mk_revision(c, ARRAY[w->>'e4']); SET LOCAL ROLE soc_api;
    q := soc.record_investigation_query(c, 'atomic-key-abcdef', 'get_ip_context', '{}', h, 'r', a1, a2, jsonb_build_array(w->>'e4'));
    RAISE EXCEPTION 'simulated backend failure after recording' USING ERRCODE = 'XX000';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
  END;
  PERFORM soc_test.check((SELECT used FROM soc.investigation_budget(c)) = 0, 'a failure before COMMIT rolls back the charge: budget still 3');
  PERFORM soc_test.check((SELECT count(*) FROM soc.case_assessments WHERE case_id = c) = 1 AND (SELECT count(*) FROM soc.case_events WHERE case_id = c) = 3, 'the new assessment and folded-in events roll back with it (original untouched)');
  PERFORM soc_test.check((SELECT count(*) FROM soc.investigation_queries WHERE case_id = c) = 0, 'no ledger row survives the failed attempt');
END $$;

ROLLBACK;
