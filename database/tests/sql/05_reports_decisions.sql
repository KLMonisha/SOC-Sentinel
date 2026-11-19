-- Reports, citations (unresolved kept, never faked), analyst decisions. Rolled-back transaction.
BEGIN;

DO $$
DECLARE w jsonb := soc_test.mk_world('rep-world-b'); c text := w->>'case'; ds text := w->>'dataset'; a1 uuid := (w->>'a1')::uuid; a2 uuid; r1 text; r2 text;
BEGIN
  r1 := soc_test.mk_report(c, a1);
  INSERT INTO soc.report_claims VALUES (r1, 'c1', 1, 'Two failed logins preceded a success.', true, NULL);
  INSERT INTO soc.report_claim_citations (report_id, claim_id, case_id, ordinal, cited_event_id, resolved_dataset_id) VALUES (r1, 'c1', c, 1, w->>'e1', ds);
  INSERT INTO soc.report_claim_citations (report_id, claim_id, case_id, ordinal, cited_event_id, resolved_dataset_id) VALUES (r1, 'c1', c, 2, w->>'e3', ds);
  INSERT INTO soc.report_claims VALUES (r1, 'c2', 2, 'Attacker exfiltrated data (not supported).', false, 'Cited event does not exist in this case.');
  INSERT INTO soc.report_claim_citations (report_id, claim_id, case_id, ordinal, cited_event_id, resolved_dataset_id) VALUES (r1, 'c2', c, 1, 'evt_9999999999999999', NULL);
  INSERT INTO soc.report_claims VALUES (r1, 'c3', 3, 'Uncited statement.', false, 'No citation.');
  PERFORM soc_test.verify_deferred();

  PERFORM soc_test.check(NOT (SELECT resolved FROM soc.report_claim_citations WHERE report_id = r1 AND claim_id = 'c2'), 'an unresolvable citation is kept with resolved = false');
  PERFORM soc_test.check((SELECT cited_event_id FROM soc.report_claim_citations WHERE report_id = r1 AND claim_id = 'c2') = 'evt_9999999999999999', 'the unresolved citation keeps exactly what the report said');
  PERFORM soc_test.check((SELECT bool_and(resolved) FROM soc.report_claim_citations WHERE report_id = r1 AND claim_id = 'c1'), 'valid citations resolve to real case events');
  PERFORM soc_test.check((SELECT verified FROM soc.report_claims WHERE report_id = r1 AND claim_id = 'c2') = false, 'the claim with an unresolved citation is NOT verified');
  PERFORM soc_test.check((SELECT stored_unresolved FROM soc.report_citation_audit WHERE report_id = r1) = 1 AND (SELECT unverified_claims FROM soc.report_citation_audit WHERE report_id = r1) = 2,
    'report_citation_audit recomputes 1 unresolved citation and 2 unverified claims from rows');

  -- a verified claim may not rest on an unresolved citation
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.report_claim_citations (report_id, claim_id, case_id, ordinal, cited_event_id, resolved_dataset_id) VALUES (%L, 'c1', %L, 3, 'evt_8888888888888888', NULL)$f$, r1, c),
    'SC230', 'cannot attach an unresolved citation to a verified claim');
  -- a resolved citation must be a real event of the report's case
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.report_claim_citations (report_id, claim_id, case_id, ordinal, cited_event_id, resolved_dataset_id) VALUES (%L, 'c2', %L, 2, %L, %L)$f$, r1, c, w->>'e4', ds),
    '23503', 'a citation cannot claim to resolve to an event outside the case');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.report_claim_citations (report_id, claim_id, case_id, ordinal, cited_event_id, resolved_dataset_id) VALUES (%L, 'c2', %L, 2, 'evt_nope', %L)$f$, r1, c, ds),
    '23503', 'resolved = true with a nonexistent event is rejected (cannot pretend to be verified)');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.report_claim_citations (report_id, claim_id, case_id, ordinal, cited_event_id, resolved_dataset_id) VALUES (%L, 'c2', 'case_other00000000', 5, %L, %L)$f$, r1, w->>'e1', ds),
    '23503', 'a citation''s case must match its report''s case');
  PERFORM soc_test.expect_error(format($f$UPDATE soc.report_claim_citations SET resolved_dataset_id = %L WHERE report_id = %L AND claim_id = 'c2'$f$, ds, r1), 'SC100', 'citations cannot be edited into "resolved"');
  PERFORM soc_test.expect_error(format($f$UPDATE soc.report_claims SET verified = true WHERE report_id = %L AND claim_id = 'c2'$f$, r1), 'SC100', 'claims cannot be edited into "verified"');

  -- temporal: a report on revision 1 cannot resolve a citation to an event added in revision 2
  a2 := soc_test.mk_revision(c, ARRAY[w->>'e4']);
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.report_claim_citations (report_id, claim_id, case_id, ordinal, cited_event_id, resolved_dataset_id) VALUES (%L, 'c2', %L, 3, %L, %L)$f$, r1, c, w->>'e4', ds),
    'SC220', 'a revision-1 report cannot cite evidence that only exists in revision 2');
  -- a report for revision 2 may; and the revision-1 report remains stored (history)
  r2 := soc_test.mk_report(c, a2);
  INSERT INTO soc.report_claims VALUES (r2, 'n1', 1, 'A web access followed.', true, NULL);
  INSERT INTO soc.report_claim_citations (report_id, claim_id, case_id, ordinal, cited_event_id, resolved_dataset_id) VALUES (r2, 'n1', c, 1, w->>'e4', ds);
  PERFORM soc_test.verify_deferred();
  PERFORM soc_test.check((SELECT count(*) FROM soc.reports WHERE case_id = c) = 2, 'both reports are kept; the newest is current');
  PERFORM soc_test.check((SELECT report_id FROM soc.reports WHERE case_id = c ORDER BY created_at DESC, report_id DESC LIMIT 1) IN (r1, r2), 'newest-report lookup works');

  -- report metadata rules
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.reports (case_id, assessment_id, generated_by, summary, verdict_rationale, citation_total, citation_verified, citation_rejected) VALUES (%L, %L, 'template_fallback', 's', 'v', 0, 0, 0)$f$, c, a1),
    '23514', 'a template-fallback report must record why the LLM was not used');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.reports (case_id, assessment_id, generated_by, summary, verdict_rationale, citation_total, citation_verified, citation_rejected) VALUES (%L, %L, 'human', 's', 'v', 0, 0, 0)$f$, c, a1),
    '23514', 'generated_by is llm or template_fallback');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.reports (case_id, assessment_id, generated_by, summary, verdict_rationale, citation_total, citation_verified, citation_rejected, llm_model) VALUES (%L, %L, 'llm', 's', 'v', 5, 1, 1, 'm')$f$, c, a1),
    '23514', 'reported citation counts must add up (verified + rejected = total)');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.reports (case_id, assessment_id, generated_by, summary, verdict_rationale, citation_total, citation_verified, citation_rejected, llm_model) VALUES (%L, %L, 'llm', 's', 'v', 0, 0, 0, 'm')$f$, c, (soc_test.mk_world('rep-other')->>'a1')::uuid),
    '23503', 'a report must reference an assessment OF THE SAME case');
  PERFORM soc_test.expect_error(format($f$UPDATE soc.reports SET summary = 'edited' WHERE report_id = %L$f$, r1), 'SC100', 'reports cannot be edited');
  PERFORM soc_test.check(soc_test.mk_report(c, a1, 'template_fallback') IS NOT NULL, 'a deterministic template-fallback report with a reason is accepted');
END $$;

-- a verified claim with no citation is rejected at commit
DO $$
DECLARE w jsonb := soc_test.mk_world('rep-verified-empty'); r text;
BEGIN
  PERFORM soc_test.verify_deferred();
  BEGIN
    r := soc_test.mk_report(w->>'case', (w->>'a1')::uuid);
    INSERT INTO soc.report_claims VALUES (r, 'c1', 1, 'Verified but cites nothing.', true, NULL);
    PERFORM soc_test.verify_deferred();
    RAISE EXCEPTION 'TEST FAILED: verified claim without citations accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'SC231' THEN RAISE EXCEPTION 'TEST FAILED: expected SC231, got % (%)', SQLSTATE, SQLERRM; END IF;
    RAISE NOTICE 'PASS: a verified claim with no citation is rejected at commit [SC231]';
  END;
END $$;

-- ---------- analyst decisions: append-only dry-run audit
DO $$
DECLARE w jsonb := soc_test.mk_world('dec-world'); c text := w->>'case'; a1 uuid := (w->>'a1')::uuid; a2 uuid; d1 text; d2 text; s1 bigint; s2 bigint;
BEGIN
  PERFORM soc_test.check((SELECT status FROM soc.case_status WHERE case_id = c) = 'open', 'a case with no decision is open');
  INSERT INTO soc.analyst_decisions (case_id, assessment_id, decision, analyst_id, note) VALUES (c, a1, 'approve', 'priyanka', 'Contain pending review.') RETURNING decision_id, seq INTO d1, s1;
  PERFORM soc_test.check(d1 ~ '^dec_[0-9a-f]{12}$' AND s1 IS NOT NULL, 'decision id and sequence are generated');
  PERFORM soc_test.check((SELECT dry_run FROM soc.analyst_decisions WHERE decision_id = d1), 'dry_run defaults to true');
  PERFORM soc_test.check((SELECT status FROM soc.case_status WHERE case_id = c) = 'approved', 'status derived from the latest decision (approved)');
  INSERT INTO soc.analyst_decisions (case_id, assessment_id, decision, analyst_id) VALUES (c, a1, 'reject', 'second-analyst') RETURNING decision_id, seq INTO d2, s2;
  PERFORM soc_test.check(s2 > s1 AND (SELECT status FROM soc.case_status WHERE case_id = c) = 'rejected', 'repeated decisions are appended; status follows the latest (rejected)');
  PERFORM soc_test.check((SELECT count(*) FROM soc.analyst_decisions WHERE case_id = c) = 2 AND (SELECT note FROM soc.analyst_decisions WHERE decision_id = d2) IS NULL, 'both decisions kept; missing note stays NULL');

  a2 := soc_test.mk_revision(c, ARRAY[w->>'e4']);
  INSERT INTO soc.analyst_decisions (case_id, assessment_id, decision, analyst_id) VALUES (c, a2, 'approve', 'priyanka');
  PERFORM soc_test.check((SELECT count(DISTINCT assessment_id) FROM soc.analyst_decisions WHERE case_id = c) = 2, 'decisions reference the assessment version the analyst saw');

  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.analyst_decisions (case_id, assessment_id, decision, analyst_id, dry_run) VALUES (%L, %L, 'approve', 'x', false)$f$, c, a1), '23514', 'dry_run = false is impossible');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.analyst_decisions (case_id, assessment_id, decision, analyst_id) VALUES (%L, %L, 'approve', '   ')$f$, c, a1), '23514', 'blank analyst_id rejected');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.analyst_decisions (case_id, assessment_id, decision, analyst_id) VALUES (%L, %L, 'approve', NULL)$f$, c, a1), '23502', 'analyst_id is required');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.analyst_decisions (case_id, assessment_id, decision, analyst_id) VALUES (%L, %L, 'delete', 'x')$f$, c, a1), '23514', 'decision is approve or reject');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.analyst_decisions (case_id, assessment_id, decision, analyst_id) VALUES (%L, %L, 'approve', 'x')$f$, c, (soc_test.mk_world('dec-other')->>'a1')::uuid), '23503', 'a decision cannot reference another case''s assessment');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.analyst_decisions (case_id, assessment_id, decision, analyst_id) VALUES ('case_nope0000000000', %L, 'approve', 'x')$f$, a1), '23503', 'a decision needs an existing case');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.analyst_decisions (case_id, assessment_id, decision, analyst_id, seq) VALUES (%L, %L, 'approve', 'x', 999)$f$, c, a1), '428C9', 'the audit sequence cannot be forged (GENERATED ALWAYS)');
  PERFORM soc_test.expect_error(format($f$UPDATE soc.analyst_decisions SET decision = 'reject' WHERE decision_id = %L$f$, d1), 'SC100', 'decisions cannot be edited');
  PERFORM soc_test.expect_error(format($f$DELETE FROM soc.analyst_decisions WHERE decision_id = %L$f$, d1), 'SC100', 'decisions cannot be deleted');
  PERFORM soc_test.expect_error('TRUNCATE soc.analyst_decisions', 'SC100', 'the audit trail cannot be truncated');
END $$;

ROLLBACK;
