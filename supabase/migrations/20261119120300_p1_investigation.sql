-- SOC Sentinel - P1 - investigation planner, budget ledger, idempotency, query history
-- Depends on 20261119120200. Non-destructive. No secrets.
--
-- Transaction protocol (the backend runs ALL of this in ONE database transaction):
--   1. SELECT * FROM soc.begin_investigation_query(case_id, idempotency_key, request_hash);
--        -> takes a per-case advisory lock (held to end of transaction), then
--           replay     : this key was already executed with the SAME request; return the stored result, charge nothing
--           proceed    : budget available; continue
--           raises SC001 (budget exhausted) / SC002 (key reused with a different request) / SC404 (unknown case)
--   2. read-only retrieval of existing events; compute the new assessment (backend code)
--   3. if the case changed: INSERT the new case_assessments row (revision n+1), its children, and case_events
--      for newly folded-in events (added_in_assessment_id = new assessment)
--   4. SELECT soc.record_investigation_query(...)  -> inserts the charged query + retrieved-event rows
--   5. COMMIT.  Any error / timeout / disconnect before COMMIT rolls back everything: no row, no charge.

CREATE TABLE soc.planner_candidates (
  assessment_id                 uuid NOT NULL,
  case_id                       text NOT NULL,
  ordinal                       smallint NOT NULL,
  tool                          text NOT NULL,
  params                        jsonb NOT NULL DEFAULT '{}',
  relevance                     numeric(4,3),
  expected_uncertainty_reduction numeric(4,3),
  retrieval_cost                smallint NOT NULL DEFAULT 1,
  recommended                   boolean NOT NULL DEFAULT false,
  reason                        text NOT NULL,
  PRIMARY KEY (assessment_id, ordinal),
  CONSTRAINT candidates_assessment FOREIGN KEY (assessment_id, case_id) REFERENCES soc.case_assessments (assessment_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT candidates_tool CHECK (tool IN ('get_related_auth_events', 'get_post_login_activity', 'get_ip_context')),
  CONSTRAINT candidates_params CHECK (soc.jsonb_all_strings(params)),
  CONSTRAINT candidates_ranges CHECK ((relevance IS NULL OR relevance BETWEEN 0 AND 1) AND (expected_uncertainty_reduction IS NULL OR expected_uncertainty_reduction BETWEEN 0 AND 1) AND retrieval_cost >= 0),
  CONSTRAINT candidates_ordinal CHECK (ordinal >= 1)
);
COMMENT ON TABLE soc.planner_candidates IS 'Proposals shown BEFORE anything runs. A proposal is not evidence. `used` is derived from investigation_queries. relevance / expected_uncertainty_reduction are stored only if the backend really computes them.';

CREATE TABLE soc.investigation_queries (
  query_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                text NOT NULL REFERENCES soc.cases (case_id) ON DELETE RESTRICT,
  idempotency_key        text NOT NULL,
  tool                   text NOT NULL,
  params                 jsonb NOT NULL DEFAULT '{}',
  request_hash           text NOT NULL,
  sequence_no            smallint NOT NULL,
  reason                 text NOT NULL,
  before_assessment_id   uuid NOT NULL,
  after_assessment_id    uuid NOT NULL,
  budget_remaining_after smallint NOT NULL,
  request_id             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queries_idem UNIQUE (case_id, idempotency_key),
  CONSTRAINT queries_seq UNIQUE (case_id, sequence_no),
  CONSTRAINT queries_with_case UNIQUE (query_id, case_id),
  CONSTRAINT queries_before FOREIGN KEY (before_assessment_id, case_id) REFERENCES soc.case_assessments (assessment_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT queries_after FOREIGN KEY (after_assessment_id, case_id) REFERENCES soc.case_assessments (assessment_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT queries_key CHECK (char_length(idempotency_key) BETWEEN 8 AND 128 AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT queries_tool CHECK (tool IN ('get_related_auth_events', 'get_post_login_activity', 'get_ip_context')),
  CONSTRAINT queries_params CHECK (soc.jsonb_all_strings(params)),
  CONSTRAINT queries_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT queries_seq_range CHECK (sequence_no >= 1 AND budget_remaining_after >= 0)
);
COMMENT ON TABLE soc.investigation_queries IS 'One row per EXECUTED (charged) investigation query: history, idempotency record and budget ledger in one. Failed attempts write nothing. Budget remaining = cases.investigation_budget_total - count(rows).';
CREATE INDEX queries_history ON soc.investigation_queries (case_id, sequence_no);

-- DB-level backstop even if a client bypasses the functions: gap-free sequence within budget, consistent remaining, sane assessment order.
CREATE FUNCTION soc.investigation_query_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = soc, pg_catalog
AS $$
DECLARE v_total smallint; v_used integer; v_before integer; v_after integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('soc.case:' || NEW.case_id, 0));
  SELECT investigation_budget_total INTO v_total FROM soc.cases WHERE case_id = NEW.case_id;
  SELECT count(*) INTO v_used FROM soc.investigation_queries WHERE case_id = NEW.case_id;
  IF v_used >= v_total THEN
    RAISE EXCEPTION 'investigation budget exhausted for case %', NEW.case_id USING ERRCODE = 'SC001';
  END IF;
  IF NEW.sequence_no <> v_used + 1 THEN
    RAISE EXCEPTION 'sequence_no must be % for case %', v_used + 1, NEW.case_id USING ERRCODE = 'SC005';
  END IF;
  IF NEW.budget_remaining_after <> v_total - NEW.sequence_no THEN
    RAISE EXCEPTION 'budget_remaining_after must be %', v_total - NEW.sequence_no USING ERRCODE = 'SC005';
  END IF;
  SELECT revision INTO v_before FROM soc.case_assessments WHERE assessment_id = NEW.before_assessment_id;
  SELECT revision INTO v_after FROM soc.case_assessments WHERE assessment_id = NEW.after_assessment_id;
  IF v_after < v_before THEN
    RAISE EXCEPTION 'after assessment must not be older than before assessment' USING ERRCODE = 'SC005';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_query_guard BEFORE INSERT ON soc.investigation_queries FOR EACH ROW EXECUTE FUNCTION soc.investigation_query_guard();

CREATE TABLE soc.investigation_query_events (
  query_id         uuid NOT NULL,
  case_id          text NOT NULL,
  dataset_id       text NOT NULL,
  event_id         text NOT NULL,
  was_new_to_case  boolean NOT NULL,
  PRIMARY KEY (query_id, event_id),
  CONSTRAINT query_events_query FOREIGN KEY (query_id, case_id) REFERENCES soc.investigation_queries (query_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT query_events_case_event FOREIGN KEY (case_id, dataset_id, event_id) REFERENCES soc.case_events (case_id, dataset_id, event_id) ON DELETE RESTRICT
);
COMMENT ON TABLE soc.investigation_query_events IS 'Events a query returned (all are now in the case). Zero rows is a valid, charged outcome ("no matching evidence").';

-- ---------------------------------------------------------------- functions
CREATE FUNCTION soc.investigation_budget(p_case_id text)
RETURNS TABLE (budget_total integer, used integer, remaining integer)
LANGUAGE sql STABLE SET search_path = soc, pg_catalog
AS $$
  SELECT c.investigation_budget_total::integer, count(q.*)::integer, (c.investigation_budget_total - count(q.*))::integer
    FROM soc.cases c LEFT JOIN soc.investigation_queries q ON q.case_id = c.case_id
   WHERE c.case_id = p_case_id GROUP BY c.case_id
$$;

CREATE FUNCTION soc.begin_investigation_query(p_case_id text, p_idempotency_key text, p_request_hash text)
RETURNS TABLE (outcome text, query_id uuid, sequence_no smallint, budget_total integer, budget_remaining integer)
LANGUAGE plpgsql SET search_path = soc, pg_catalog
AS $$
DECLARE v_total integer; v_used integer; q soc.investigation_queries%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('soc.case:' || p_case_id, 0));
  SELECT investigation_budget_total INTO v_total FROM soc.cases WHERE case_id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id USING ERRCODE = 'SC404';
  END IF;
  SELECT * INTO q FROM soc.investigation_queries WHERE case_id = p_case_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF q.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'idempotency key already used for a different request' USING ERRCODE = 'SC002';
    END IF;
    RETURN QUERY SELECT 'replay'::text, q.query_id, q.sequence_no, v_total, q.budget_remaining_after::integer;
    RETURN;
  END IF;
  SELECT count(*) INTO v_used FROM soc.investigation_queries WHERE case_id = p_case_id;
  IF v_used >= v_total THEN
    RAISE EXCEPTION 'investigation budget exhausted for case %', p_case_id USING ERRCODE = 'SC001';
  END IF;
  RETURN QUERY SELECT 'proceed'::text, NULL::uuid, (v_used + 1)::smallint, v_total, v_total - v_used;
END $$;

-- p_retrieved: JSON array of event id strings, e.g. ["evt_...", "evt_..."] (may be empty).
-- p_before must be the CURRENT assessment of the case (stale callers get SC003); p_after is p_before when nothing changed.
CREATE FUNCTION soc.record_investigation_query(
  p_case_id text, p_idempotency_key text, p_tool text, p_params jsonb, p_request_hash text, p_reason text,
  p_before uuid, p_after uuid, p_retrieved jsonb, p_request_id text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SET search_path = soc, pg_catalog
AS $$
DECLARE
  v_total integer; v_used integer; v_dataset text; v_latest uuid; v_query uuid; q soc.investigation_queries%ROWTYPE; v_event text; v_new boolean; v_added uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('soc.case:' || p_case_id, 0));
  SELECT investigation_budget_total, dataset_id INTO v_total, v_dataset FROM soc.cases WHERE case_id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id USING ERRCODE = 'SC404';
  END IF;
  SELECT * INTO q FROM soc.investigation_queries WHERE case_id = p_case_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF q.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'idempotency key already used for a different request' USING ERRCODE = 'SC002';
    END IF;
    RETURN q.query_id;                                    -- idempotent: same request, no second charge
  END IF;
  SELECT count(*) INTO v_used FROM soc.investigation_queries WHERE case_id = p_case_id;
  IF v_used >= v_total THEN
    RAISE EXCEPTION 'investigation budget exhausted for case %', p_case_id USING ERRCODE = 'SC001';
  END IF;
  IF jsonb_typeof(p_retrieved) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_retrieved must be a JSON array of event ids' USING ERRCODE = 'SC006';
  END IF;
  SELECT assessment_id INTO v_latest FROM soc.case_assessments WHERE case_id = p_case_id ORDER BY revision DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM p_after THEN
    RAISE EXCEPTION 'p_after must be the newest assessment of the case' USING ERRCODE = 'SC003';
  END IF;
  IF p_before IS DISTINCT FROM p_after AND (SELECT revision FROM soc.case_assessments WHERE assessment_id = p_before) <> (SELECT revision FROM soc.case_assessments WHERE assessment_id = p_after) - 1 THEN
    RAISE EXCEPTION 'p_before must be the assessment immediately preceding p_after' USING ERRCODE = 'SC003';
  END IF;

  INSERT INTO soc.investigation_queries (case_id, idempotency_key, tool, params, request_hash, sequence_no, reason, before_assessment_id, after_assessment_id, budget_remaining_after, request_id)
  VALUES (p_case_id, p_idempotency_key, p_tool, coalesce(p_params, '{}'), p_request_hash, (v_used + 1)::smallint, p_reason, p_before, p_after, (v_total - v_used - 1)::smallint, p_request_id)
  RETURNING investigation_queries.query_id INTO v_query;

  FOR v_event IN SELECT jsonb_array_elements_text(p_retrieved) LOOP
    SELECT added_in_assessment_id INTO v_added FROM soc.case_events WHERE case_id = p_case_id AND dataset_id = v_dataset AND event_id = v_event;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'retrieved event % is not in the case; insert it into case_events first', v_event USING ERRCODE = 'SC007';
    END IF;
    v_new := (v_added = p_after AND p_after IS DISTINCT FROM p_before);
    INSERT INTO soc.investigation_query_events (query_id, case_id, dataset_id, event_id, was_new_to_case) VALUES (v_query, p_case_id, v_dataset, v_event, v_new);
  END LOOP;
  RETURN v_query;
END $$;

-- ---------------------------------------------------------------- current-state view for GET /cases
CREATE VIEW soc.case_current WITH (security_invoker = true) AS
SELECT l.*, s.status, s.decision_count,
       (l.investigation_budget_total - (SELECT count(*) FROM soc.investigation_queries q WHERE q.case_id = l.case_id))::integer AS budget_remaining
  FROM soc.case_latest_assessment l JOIN soc.case_status s ON s.case_id = l.case_id;
COMMENT ON VIEW soc.case_current IS 'One row per case for GET /api/cases: newest assessment + derived status, event stats and budget_remaining.';

CREATE VIEW soc.planner_candidate_state WITH (security_invoker = true) AS
SELECT p.*, EXISTS (SELECT 1 FROM soc.investigation_queries q WHERE q.case_id = p.case_id AND q.tool = p.tool AND q.params = p.params) AS used
  FROM soc.planner_candidates p;
COMMENT ON VIEW soc.planner_candidate_state IS 'planner.candidates[] with the derived `used` flag.';

-- ---------------------------------------------------------------- security
SELECT soc.secure_table('soc.planner_candidates');
SELECT soc.secure_table('soc.investigation_queries');
SELECT soc.secure_table('soc.investigation_query_events');

GRANT SELECT ON soc.case_current, soc.planner_candidate_state TO soc_api, soc_readonly;
SELECT soc.lock_down_schema();
GRANT EXECUTE ON FUNCTION soc.investigation_query_guard(), soc.begin_investigation_query(text, text, text),
  soc.record_investigation_query(text, text, text, jsonb, text, text, uuid, uuid, jsonb, text) TO soc_api;
GRANT EXECUTE ON FUNCTION soc.investigation_budget(text) TO soc_api, soc_readonly;
