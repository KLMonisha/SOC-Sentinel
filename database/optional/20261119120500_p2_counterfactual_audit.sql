-- SOC Sentinel - OPTIONAL P2 - counterfactual run audit
-- NOT in supabase/migrations/ on purpose. The agreed contract says counterfactual runs are NOT persisted
-- (they are hypothetical and must never modify a case). Apply this ONLY if you decide to keep an audit of
-- what-if analyses. To apply: copy this file into supabase/migrations/ (keep a later timestamp than the others).
--
-- Guarantee preserved: a counterfactual run only INSERTS into its own tables. It never writes case_assessments,
-- findings, case_events or any other case table, so the original case and assessment are untouched.
-- Depends on 20261119120100. Non-destructive. No secrets.

CREATE TABLE soc.counterfactual_runs (
  run_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                text NOT NULL REFERENCES soc.cases (case_id) ON DELETE RESTRICT,
  original_assessment_id uuid NOT NULL,
  simulation_type        text NOT NULL DEFAULT 'event_exclusion',
  reason                 text NOT NULL,
  recomputed             jsonb NOT NULL,
  score_delta            smallint NOT NULL,
  request_id             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cf_with_case UNIQUE (run_id, case_id),
  CONSTRAINT cf_original FOREIGN KEY (original_assessment_id, case_id) REFERENCES soc.case_assessments (assessment_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT cf_type CHECK (simulation_type = 'event_exclusion'),
  CONSTRAINT cf_reason CHECK (btrim(reason) <> '' AND char_length(reason) <= 2000),
  CONSTRAINT cf_recomputed CHECK (jsonb_typeof(recomputed) = 'object'),
  CONSTRAINT cf_delta CHECK (score_delta BETWEEN -100 AND 100)
);
COMMENT ON TABLE soc.counterfactual_runs IS 'Optional audit of what-if analyses. original_assessment_id is the stored assessment that was compared against. The recomputed outcome is hypothetical and is never an assessment of the case.';
CREATE INDEX cf_runs_by_case ON soc.counterfactual_runs (case_id, created_at DESC);

CREATE TABLE soc.counterfactual_excluded_events (
  run_id      uuid NOT NULL,
  case_id     text NOT NULL,
  dataset_id  text NOT NULL,
  event_id    text NOT NULL,
  PRIMARY KEY (run_id, event_id),
  CONSTRAINT cf_ex_run FOREIGN KEY (run_id, case_id) REFERENCES soc.counterfactual_runs (run_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT cf_ex_event FOREIGN KEY (case_id, dataset_id, event_id) REFERENCES soc.case_events (case_id, dataset_id, event_id) ON DELETE RESTRICT
);
COMMENT ON TABLE soc.counterfactual_excluded_events IS 'Events a run hypothetically excluded. They must be real events of the case; nothing is removed from case_events.';

-- the run must compare against the case's CURRENT stored assessment
CREATE FUNCTION soc.counterfactual_original_is_current() RETURNS trigger
LANGUAGE plpgsql SET search_path = soc, pg_catalog
AS $$
DECLARE v_latest uuid;
BEGIN
  SELECT assessment_id INTO v_latest FROM soc.case_assessments WHERE case_id = NEW.case_id ORDER BY revision DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM NEW.original_assessment_id THEN
    RAISE EXCEPTION 'a counterfactual must compare against the current stored assessment of case %', NEW.case_id USING ERRCODE = 'SC240';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_cf_original_current BEFORE INSERT ON soc.counterfactual_runs FOR EACH ROW EXECUTE FUNCTION soc.counterfactual_original_is_current();

SELECT soc.secure_table('soc.counterfactual_runs');
SELECT soc.secure_table('soc.counterfactual_excluded_events');
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA soc FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soc.counterfactual_original_is_current() TO soc_api;
