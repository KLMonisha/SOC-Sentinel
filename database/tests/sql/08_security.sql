-- Access control: roles, RLS (forced), private schema, function execution, sequence access, mutation attempts.
-- Run by the harness as a superuser that SETs ROLE to each principal, in a rolled-back transaction.
-- Cluster-level stubs of Supabase's anon / authenticated / service_role exist in the disposable cluster.
BEGIN;

-- ---------- role attributes
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'soc_api';
  PERFORM soc_test.check(r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication, 'soc_api: login only, no superuser / BYPASSRLS / CREATEDB / CREATEROLE / REPLICATION');
  PERFORM soc_test.check(r.rolconnlimit > 0, 'soc_api has a connection limit');
  PERFORM soc_test.check(r.rolconfig @> ARRAY['statement_timeout=30s'] AND r.rolconfig @> ARRAY['lock_timeout=10s'] AND r.rolconfig @> ARRAY['idle_in_transaction_session_timeout=60s'],
    'soc_api carries statement / lock / idle-in-transaction timeouts');
  PERFORM soc_test.check((SELECT rolpassword IS NULL FROM pg_authid WHERE rolname = 'soc_api'), 'soc_api was created WITHOUT a password in the migration (none committed)');
  SELECT * INTO r FROM pg_roles WHERE rolname = 'soc_readonly';
  PERFORM soc_test.check(r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls, 'soc_readonly: login only, no elevated attributes');
  PERFORM soc_test.check(r.rolconfig @> ARRAY['default_transaction_read_only=on'], 'soc_readonly sessions are read-only by default');
END $$;

-- ---------- catalog completeness: every table is locked down the same way
DO $$
DECLARE t record; n integer := 0;
BEGIN
  FOR t IN SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'soc' AND c.relkind = 'r' LOOP
    n := n + 1;
    PERFORM soc_test.check(t.relrowsecurity AND t.relforcerowsecurity, format('RLS enabled AND forced: soc.%s', t.relname));
    PERFORM soc_test.check((SELECT count(*) FROM pg_trigger WHERE tgrelid = t.oid AND tgname IN ('trg_append_only', 'trg_no_truncate')) = 2, format('append-only triggers present: soc.%s', t.relname));
    PERFORM soc_test.check(NOT has_table_privilege('soc_api', t.oid, 'UPDATE') AND NOT has_table_privilege('soc_api', t.oid, 'DELETE') AND NOT has_table_privilege('soc_api', t.oid, 'TRUNCATE')
      AND NOT has_table_privilege('soc_api', t.oid, 'REFERENCES') AND NOT has_table_privilege('soc_api', t.oid, 'TRIGGER'), format('soc_api has no UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER: soc.%s', t.relname));
    PERFORM soc_test.check(has_table_privilege('soc_api', t.oid, 'SELECT') AND has_table_privilege('soc_api', t.oid, 'INSERT'), format('soc_api can SELECT and INSERT: soc.%s', t.relname));
    PERFORM soc_test.check(has_table_privilege('soc_readonly', t.oid, 'SELECT') AND NOT has_table_privilege('soc_readonly', t.oid, 'INSERT'), format('soc_readonly can only SELECT: soc.%s', t.relname));
    PERFORM soc_test.check(NOT has_table_privilege('anon', t.oid, 'SELECT') AND NOT has_table_privilege('authenticated', t.oid, 'SELECT') AND NOT has_table_privilege('service_role', t.oid, 'SELECT'),
      format('anon / authenticated / service_role have no access: soc.%s', t.relname));
    PERFORM soc_test.check((SELECT count(*) FROM pg_policies WHERE schemaname = 'soc' AND tablename = t.relname) = 2
      AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'soc' AND tablename = t.relname AND cmd NOT IN ('SELECT', 'INSERT')), format('only SELECT and INSERT policies exist (UPDATE/DELETE denied by default): soc.%s', t.relname));
  END LOOP;
  PERFORM soc_test.check(n = 22, 'security checks covered all 22 tables');
  PERFORM soc_test.check(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'soc' AND (roles && ARRAY['anon', 'authenticated', 'public']::name[])), 'no policy grants anything to anon / authenticated / public');
END $$;

-- ---------- schema privacy
DO $$
BEGIN
  PERFORM soc_test.check(NOT has_schema_privilege('anon', 'soc', 'USAGE') AND NOT has_schema_privilege('authenticated', 'soc', 'USAGE') AND NOT has_schema_privilege('service_role', 'soc', 'USAGE'),
    'schema soc is private: no USAGE for anon / authenticated / service_role');
  PERFORM soc_test.check(NOT EXISTS (SELECT 1 FROM aclexplode((SELECT nspacl FROM pg_namespace WHERE nspname = 'soc')) a WHERE a.grantee = 0), 'schema soc grants nothing to PUBLIC');
  PERFORM soc_test.check(has_schema_privilege('soc_api', 'soc', 'USAGE') AND NOT has_schema_privilege('soc_api', 'soc', 'CREATE'), 'soc_api can use but not create objects in soc');
  PERFORM soc_test.check(NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'soc'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE')), 'no soc function is executable by anon');
  PERFORM soc_test.check(NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.pronamespace = 'soc'::regnamespace AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), 'no soc function grants EXECUTE to PUBLIC');
END $$;

-- ---------- unauthorized principals are refused
DO $$
DECLARE w jsonb := soc_test.mk_world('sec-world');
BEGIN
  PERFORM soc_test.expect_error('SELECT count(*) FROM soc.source_events', '42501', 'anon cannot read raw security logs', 'anon');
  PERFORM soc_test.expect_error('SELECT count(*) FROM soc.source_events', '42501', 'authenticated cannot read raw security logs', 'authenticated');
  PERFORM soc_test.expect_error('SELECT count(*) FROM soc.source_events', '42501', 'service_role is not special inside soc (no grants)', 'service_role');
  PERFORM soc_test.expect_error('SELECT count(*) FROM soc.case_current', '42501', 'anon cannot read the case view', 'anon');
  PERFORM soc_test.expect_error($f$INSERT INTO soc.adversarial_runs (scenario_id, trials_requested, scenario_title, scenario_field, untrusted_payload) VALUES ('user_agent_injection', 1, 't', 'f', 'p')$f$, '42501', 'anon cannot insert', 'anon');
  PERFORM soc_test.expect_error(format($f$SELECT * FROM soc.begin_investigation_query(%L, 'anon-key-abcdefgh', %L)$f$, w->>'case', soc.sha256_hex('x')), '42501', 'anon cannot execute the investigation function', 'anon');
  PERFORM soc_test.expect_error('SELECT soc.secure_table(''soc.datasets''::regclass)', '42501', 'soc_api cannot run the owner-only security helper', 'soc_api');
  PERFORM soc_test.expect_error('CREATE TABLE soc.sneaky (x int)', '42501', 'soc_api cannot create objects in soc', 'soc_api');
  PERFORM soc_test.expect_error('DROP TABLE soc.source_events', '42501', 'soc_api cannot drop evidence tables', 'soc_api');
  PERFORM soc_test.expect_error('ALTER TABLE soc.source_events DISABLE TRIGGER trg_append_only', '42501', 'soc_api cannot disable the append-only trigger', 'soc_api');
  PERFORM soc_test.expect_error('ALTER TABLE soc.source_events DISABLE ROW LEVEL SECURITY', '42501', 'soc_api cannot switch RLS off', 'soc_api');
  BEGIN
    SET LOCAL ROLE soc_api;
    EXECUTE 'GRANT ALL ON soc.source_events TO PUBLIC';
  EXCEPTION WHEN OTHERS THEN NULL;   -- refusal may be an error or a "no privileges were granted" warning; the outcome below is what matters
  END;
  RESET ROLE;
  PERFORM soc_test.check(NOT has_table_privilege('public', 'soc.source_events', 'SELECT') AND NOT has_table_privilege('public', 'soc.source_events', 'UPDATE'), 'soc_api cannot grant anyone more access (PUBLIC still has no privileges)');
  PERFORM soc_test.expect_error('CREATE POLICY evil ON soc.source_events FOR ALL TO soc_api USING (true)', '42501', 'soc_api cannot add policies', 'soc_api');
END $$;

-- ---------- what soc_api CAN do (the backend's real needs): read, insert, sequence/identity, function execution
DO $$
DECLARE ds text; e text; c text; a uuid; d text; s bigint; n integer;
BEGIN
  SET LOCAL ROLE soc_api;
  ds := soc_test.mk_dataset('sec-as-api');                     -- INSERT datasets + dataset_uploads (+ deferred first-upload check)
  e := soc_test.mk_event(ds, 2);
  c := soc_test.mk_case(ds, 'k', e, ARRAY[e]);
  a := soc_test.latest(c);
  PERFORM soc_test.check((SELECT count(*) FROM soc.source_events WHERE dataset_id = ds) = 1, 'soc_api can INSERT and SELECT evidence (RLS FORCE + policies are compatible with the role)');
  PERFORM soc_test.check((SELECT count(*) FROM soc.case_current WHERE case_id = c) = 1, 'soc_api can read the security_invoker views');
  INSERT INTO soc.analyst_decisions (case_id, assessment_id, decision, analyst_id) VALUES (c, a, 'approve', 'sec-test') RETURNING decision_id, seq INTO d, s;
  PERFORM soc_test.check(s IS NOT NULL, 'soc_api can insert into a table with an identity column (sequence access works without extra grants)');
  INSERT INTO soc.reports (case_id, assessment_id, generated_by, summary, verdict_rationale, citation_total, citation_verified, citation_rejected, llm_model)
    VALUES (c, a, 'llm', 's', 'v', 0, 0, 0, 'm');
  PERFORM soc_test.check(true, 'soc_api can use gen_random_uuid() / default id generation inside inserts');
  PERFORM soc_test.check((SELECT remaining FROM soc.investigation_budget(c)) = 3, 'soc_api can execute soc.investigation_budget()');
  PERFORM * FROM soc.begin_investigation_query(c, 'api-key-abcdefgh', soc.sha256_hex('r'));
  PERFORM soc_test.check(true, 'soc_api can execute soc.begin_investigation_query() (function EXECUTE + advisory lock work)');
  PERFORM soc.record_investigation_query(c, 'api-key-abcdefgh', 'get_ip_context', '{}', soc.sha256_hex('r'), 'r', a, a, '[]');
  PERFORM soc_test.check((SELECT used FROM soc.investigation_budget(c)) = 1, 'soc_api can execute soc.record_investigation_query()');

  RESET ROLE;
END $$;

DO $$
DECLARE w jsonb := soc_test.mk_world('sec-mutate');
BEGIN
  PERFORM soc_test.verify_deferred();
  PERFORM soc_test.expect_error('UPDATE soc.source_events SET username = ''hacked''', '42501', 'soc_api cannot UPDATE evidence', 'soc_api');
  PERFORM soc_test.expect_error('DELETE FROM soc.source_events', '42501', 'soc_api cannot DELETE evidence', 'soc_api');
  PERFORM soc_test.expect_error('TRUNCATE soc.source_events', '42501', 'soc_api cannot TRUNCATE evidence', 'soc_api');
  PERFORM soc_test.expect_error('UPDATE soc.analyst_decisions SET decision = ''reject''', '42501', 'soc_api cannot rewrite the decision audit', 'soc_api');
  PERFORM soc_test.expect_error('DELETE FROM soc.case_assessments', '42501', 'soc_api cannot delete assessments', 'soc_api');
  PERFORM soc_test.expect_error('DELETE FROM soc.investigation_queries', '42501', 'soc_api cannot delete the budget ledger (would refund budget)', 'soc_api');
  PERFORM soc_test.expect_error('DELETE FROM soc.adversarial_trials', '42501', 'soc_api cannot delete red-team results', 'soc_api');
  -- even a role that DOES hold the privilege (here: the test superuser / any future grant) is stopped by the trigger
  PERFORM soc_test.expect_error('UPDATE soc.source_events SET username = ''hacked''', 'SC100', 'append-only trigger blocks UPDATE even for a privileged session');
  PERFORM soc_test.expect_error('DELETE FROM soc.cases', 'SC100', 'append-only trigger blocks DELETE even for a privileged session');
  PERFORM soc_test.expect_error('TRUNCATE soc.cases CASCADE', 'SC100', 'append-only trigger blocks TRUNCATE ... CASCADE');
  -- soc_readonly
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.adversarial_runs (scenario_id, trials_requested, scenario_title, scenario_field, untrusted_payload) VALUES ('user_agent_injection', 1, 't', 'f', 'p')$f$), '42501', 'soc_readonly cannot insert', 'soc_readonly');
  PERFORM soc_test.expect_ok('SELECT count(*) FROM soc.source_events', 'soc_readonly can read', 'soc_readonly');
  PERFORM soc_test.expect_error(format($f$SELECT * FROM soc.begin_investigation_query(%L, 'ro-key-abcdefghi', %L)$f$, w->>'case', soc.sha256_hex('x')), '42501', 'soc_readonly cannot run the investigation function', 'soc_readonly');
END $$;

-- ---------- RLS is really in force (not just present)
DO $$
DECLARE w jsonb := soc_test.mk_world('sec-rls'); n bigint;
BEGIN
  CREATE ROLE probe_grant_no_policy NOLOGIN;
  GRANT USAGE ON SCHEMA soc TO probe_grant_no_policy;
  GRANT SELECT ON soc.source_events, soc.case_current, soc.cases, soc.case_assessments, soc.case_events, soc.datasets, soc.dataset_uploads, soc.analyst_decisions, soc.investigation_queries, soc.case_latest_assessment, soc.case_status TO probe_grant_no_policy;
  SELECT count(*) INTO n FROM soc.source_events;
  PERFORM soc_test.check(n >= 4, 'fixture has events visible to the superuser');
  SET LOCAL ROLE probe_grant_no_policy;
  SELECT count(*) INTO n FROM soc.source_events;
  PERFORM soc_test.check(n = 0, 'a role with table GRANTs but no policy sees ZERO rows: RLS denies by default');
  SELECT count(*) INTO n FROM soc.case_current;
  PERFORM soc_test.check(n = 0, 'security_invoker views honour RLS for the caller (no data leak through views)');
  RESET ROLE;
  -- FORCE: the table owner without BYPASSRLS is also subject to policy
  SET LOCAL ROLE mig;
  SELECT count(*) INTO n FROM soc.source_events;
  PERFORM soc_test.check(n = 0, 'FORCE ROW LEVEL SECURITY applies to the owner role (non-bypass migration role sees 0 rows)');
  RESET ROLE;
  SET LOCAL ROLE soc_api;
  SELECT count(*) INTO n FROM soc.source_events;
  PERFORM soc_test.check(n >= 4, 'while soc_api (covered by a policy) sees the data');
  RESET ROLE;
END $$;

ROLLBACK;
