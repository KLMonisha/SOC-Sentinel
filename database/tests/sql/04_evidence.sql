-- Findings, evidence references (FK integrity), ATT&CK mappings, missing evidence. Rolled-back transaction.
BEGIN;

DO $$
DECLARE w jsonb := soc_test.mk_world('ev-world'); c text := w->>'case'; ds text := w->>'dataset'; a1 uuid := (w->>'a1')::uuid; a2 uuid; n integer;
BEGIN
  -- supporting + contradicting findings, each citing real case events
  PERFORM soc_test.mk_finding(a1, 'alert_aaaaaaaaaaaaaaaa', 'supporting', ARRAY[w->>'e1', w->>'e2']);
  PERFORM soc_test.mk_finding(a1, 'alert_bbbbbbbbbbbbbbbb', 'contradicting', ARRAY[w->>'e3']);
  PERFORM soc_test.verify_deferred();
  PERFORM soc_test.check((SELECT count(*) FROM soc.findings WHERE assessment_id = a1) = 2, 'supporting and contradicting findings stored');
  PERFORM soc_test.check((SELECT weight FROM soc.findings WHERE finding_id = 'alert_bbbbbbbbbbbbbbbb') < 0, 'contradicting finding carries a negative signed weight');
  PERFORM soc_test.check((SELECT count(*) FROM soc.finding_events WHERE assessment_id = a1 AND finding_id = 'alert_aaaaaaaaaaaaaaaa') = 2, 'finding-to-event references stored');

  -- FK integrity: a finding can only cite events that are in its case
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.finding_events VALUES (%L, 'alert_aaaaaaaaaaaaaaaa', %L, %L, 'evt_ffffffffffffffff', 3)$f$, a1, c, ds),
    '23503', 'a finding cannot cite a nonexistent event');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.finding_events VALUES (%L, 'alert_aaaaaaaaaaaaaaaa', %L, %L, %L, 3)$f$, a1, c, ds, w->>'e4'),
    '23503', 'a finding cannot cite a real event that is not in the case (e4 is retrievable but not yet folded in)');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.finding_events VALUES (%L, 'alert_aaaaaaaaaaaaaaaa', %L, %L, %L, 1)$f$, a1, c, ds, w->>'e1'),
    '23505', 'the same citation is stored once');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.finding_events VALUES (%L, 'alert_nonexistent0000', %L, %L, %L, 1)$f$, a1, c, ds, w->>'e1'),
    '23503', 'citations must belong to an existing finding');

  -- another case's events are not citable
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.finding_events VALUES (%L, 'alert_aaaaaaaaaaaaaaaa', %L, %L, %L, 9)$f$, a1, c, (soc_test.mk_world('ev-other')->>'dataset'), w->>'e3'),
    '23503', 'a finding cannot cite an event through a different dataset');

  -- temporal integrity: revision 1 cannot cite an event that only revision 2 added
  a2 := soc_test.mk_revision(c, ARRAY[w->>'e4']);
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.finding_events VALUES (%L, 'alert_aaaaaaaaaaaaaaaa', %L, %L, %L, 5)$f$, a1, c, ds, w->>'e4'),
    'SC220', 'revision 1 cannot cite evidence added later in revision 2');
  -- ... but revision 2 may cite both old and new events, with the same finding_id (history)
  PERFORM soc_test.mk_finding(a2, 'alert_aaaaaaaaaaaaaaaa', 'supporting', ARRAY[w->>'e1', w->>'e2', w->>'e4']);
  PERFORM soc_test.verify_deferred();
  PERFORM soc_test.check((SELECT count(*) FROM soc.findings WHERE finding_id = 'alert_aaaaaaaaaaaaaaaa') = 2, 'the same finding_id exists in revision 1 and revision 2 (history kept)');
  PERFORM soc_test.check((SELECT count(*) FROM soc.finding_events WHERE assessment_id = a1 AND finding_id = 'alert_aaaaaaaaaaaaaaaa') = 2, 'revision 1 citations unchanged by revision 2');

  -- value rules
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.findings (assessment_id, case_id, finding_id, rule_id, title, description, severity, stance, weight) VALUES (%L, %L, 'alert_cccccccccccccccc', 'R', 't', 'd', 'high', 'supporting', -5)$f$, a2, c),
    '23514', 'supporting findings cannot have negative weight');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.findings (assessment_id, case_id, finding_id, rule_id, title, description, severity, stance, weight) VALUES (%L, %L, 'alert_cccccccccccccccc', 'R', 't', 'd', 'high', 'contradicting', 5)$f$, a2, c),
    '23514', 'contradicting findings cannot have positive weight');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.findings (assessment_id, case_id, finding_id, rule_id, title, description, severity, stance, weight) VALUES (%L, %L, 'alert_cccccccccccccccc', 'R', 't', 'd', 'high', 'neutral', 0)$f$, a2, c),
    '23514', 'stance must be supporting or contradicting');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.findings (assessment_id, case_id, finding_id, rule_id, title, description, severity, stance) VALUES (%L, %L, 'alert_cccccccccccccccc', 'R', 't', 'd', 'high', 'supporting')$f$, a2, c),
    '23502', 'finding weight is required');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.findings (assessment_id, case_id, finding_id, rule_id, title, description, severity, stance, weight) VALUES (%L, 'case_someoneelse00000', 'alert_cccccccccccccccc', 'R', 't', 'd', 'high', 'supporting', 1)$f$, a2),
    '23503', 'a finding''s case must match its assessment''s case');
  PERFORM soc_test.expect_error(format($f$UPDATE soc.findings SET weight = 0 WHERE assessment_id = %L$f$, a1), 'SC100', 'findings cannot be updated');
  PERFORM soc_test.expect_error(format($f$DELETE FROM soc.finding_events WHERE assessment_id = %L$f$, a1), 'SC100', 'finding citations cannot be deleted');
END $$;

-- a finding with no citation is rejected at commit (contract: event_ids never empty)
DO $$
DECLARE w jsonb := soc_test.mk_world('ev-nocite');
BEGIN
  PERFORM soc_test.verify_deferred();
  BEGIN
    INSERT INTO soc.findings (assessment_id, case_id, finding_id, rule_id, title, description, severity, stance, weight)
    VALUES ((w->>'a1')::uuid, w->>'case', 'alert_dddddddddddddddd', 'R', 't', 'd', 'high', 'supporting', 10);
    PERFORM soc_test.verify_deferred();
    RAISE EXCEPTION 'TEST FAILED: finding without citations accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'SC221' THEN RAISE EXCEPTION 'TEST FAILED: expected SC221, got % (%)', SQLSTATE, SQLERRM; END IF;
    RAISE NOTICE 'PASS: a finding with no cited event is rejected at commit [SC221]';
  END;
END $$;

-- ATT&CK mappings and missing evidence
DO $$
DECLARE w jsonb := soc_test.mk_world('ev-attack'); c text := w->>'case'; ds text := w->>'dataset'; a1 uuid := (w->>'a1')::uuid; a2 uuid;
BEGIN
  INSERT INTO soc.attack_mappings VALUES (a1, c, 'T1110', 'Brute Force', 'Credential Access');
  INSERT INTO soc.attack_mapping_events VALUES (a1, 'T1110', c, ds, w->>'e1');
  INSERT INTO soc.attack_mapping_events VALUES (a1, 'T1110', c, ds, w->>'e2');
  INSERT INTO soc.missing_evidence VALUES (a1, c, 'm_vpn', 'VPN gateway logs', 'Would show whether the IP is a corporate VPN egress.');
  PERFORM soc_test.check(true, 'ATT&CK mapping with observed events, and missing evidence, stored');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.attack_mappings VALUES (%L, %L, 'X123', 'bad', 't')$f$, a1, c), '23514', 'technique id format T####[.###]');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.attack_mapping_events VALUES (%L, 'T1110', %L, %L, %L)$f$, a1, c, ds, w->>'e4'), '23503', 'mapping evidence must be events of the case');
  a2 := soc_test.mk_revision(c, ARRAY[w->>'e4']);
  INSERT INTO soc.attack_mappings VALUES (a2, c, 'T1078', 'Valid Accounts', 'Initial Access');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.attack_mapping_events VALUES (%L, 'T1078', %L, %L, %L)$f$, a1, c, ds, w->>'e1'), '23503', 'mapping rows of revision 1 cannot attach to revision 2 mappings');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.missing_evidence VALUES (%L, %L, 'm_vpn', 'dup', 'x')$f$, a1, c), '23505', 'missing_id unique per assessment');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.missing_evidence VALUES (%L, %L, 'has space', 'x', 'y')$f$, a1, c), '23514', 'missing_id has no whitespace');
END $$;

ROLLBACK;
