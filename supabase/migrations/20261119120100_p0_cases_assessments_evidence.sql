-- SOC Sentinel - P0 - cases, immutable assessments, evidence references
-- cases (stable identity), case_assessments (immutable versions), case_events, findings, finding_events,
-- attack_mappings (+events), missing_evidence, views.
-- Depends on 20261119120000. Non-destructive. No secrets.

-- ---------------------------------------------------------------- cases: immutable identity
CREATE TABLE soc.cases (
  case_id                    text PRIMARY KEY,
  dataset_id                 text NOT NULL REFERENCES soc.datasets (dataset_id) ON DELETE RESTRICT,
  correlation_key            text NOT NULL,
  anchor_event_id            text NOT NULL,
  title                      text NOT NULL,
  investigation_budget_total smallint NOT NULL DEFAULT 3,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cases_id_derived CHECK (case_id = soc.derive_case_id(dataset_id, correlation_key, anchor_event_id)),
  CONSTRAINT cases_anchor_fk FOREIGN KEY (dataset_id, anchor_event_id) REFERENCES soc.source_events (dataset_id, event_id) ON DELETE RESTRICT,
  CONSTRAINT cases_natural_key UNIQUE (dataset_id, correlation_key, anchor_event_id),
  CONSTRAINT cases_id_dataset UNIQUE (case_id, dataset_id),
  CONSTRAINT cases_title CHECK (char_length(title) BETWEEN 1 AND 300),
  CONSTRAINT cases_key CHECK (char_length(correlation_key) BETWEEN 1 AND 512),
  CONSTRAINT cases_budget CHECK (investigation_budget_total BETWEEN 0 AND 100)
);
COMMENT ON TABLE soc.cases IS 'Immutable case identity. case_id = derive_case_id(dataset_id, correlation_key, anchor_event_id); the anchor is the earliest event of the ORIGINAL cluster, so excluding evidence (counterfactual) can never change it. Verdict, status and budget live elsewhere.';
CREATE INDEX cases_dataset ON soc.cases (dataset_id);
CREATE INDEX cases_correlation ON soc.cases (dataset_id, correlation_key);

-- ---------------------------------------------------------------- case_assessments: immutable versions
CREATE TABLE soc.case_assessments (
  assessment_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                text NOT NULL REFERENCES soc.cases (case_id) ON DELETE RESTRICT,
  revision               integer NOT NULL,
  cause                  text NOT NULL,
  verdict                text NOT NULL,
  verdict_rationale      text NOT NULL,
  severity               text NOT NULL,
  risk_value             smallint NOT NULL,
  risk_band              text NOT NULL,
  risk_reasoning         text[] NOT NULL DEFAULT '{}',
  confidence_level       text NOT NULL,
  confidence_rationale   text NOT NULL,
  coverage_ratio         numeric(4,3) NOT NULL,
  coverage_present       text[] NOT NULL DEFAULT '{}',
  coverage_missing       text[] NOT NULL DEFAULT '{}',
  primary_entities       text[] NOT NULL DEFAULT '{}',
  containment_action     text,
  containment_target     text,
  containment_rationale  text,
  containment_dry_run    boolean,
  graph                  jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assessments_case_revision UNIQUE (case_id, revision),
  CONSTRAINT assessments_id_case UNIQUE (assessment_id, case_id),
  CONSTRAINT assessments_revision CHECK (revision >= 1),
  CONSTRAINT assessments_cause CHECK (cause IN ('initial', 'investigation') AND ((revision = 1) = (cause = 'initial'))),
  CONSTRAINT assessments_verdict CHECK (verdict IN ('likely_malicious', 'needs_investigation', 'likely_benign', 'insufficient_evidence')),
  CONSTRAINT assessments_severity CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT assessments_risk CHECK (risk_value BETWEEN 0 AND 100 AND risk_band IN ('low', 'investigate', 'high')),
  CONSTRAINT assessments_confidence CHECK (confidence_level IN ('low', 'medium', 'high')),
  CONSTRAINT assessments_coverage CHECK (coverage_ratio BETWEEN 0 AND 1),
  CONSTRAINT assessments_containment CHECK (
    ((containment_action IS NULL) = (containment_target IS NULL)) AND ((containment_target IS NULL) = (containment_rationale IS NULL))
    AND ((containment_action IS NULL) = (containment_dry_run IS NULL)) AND (containment_dry_run IS NULL OR containment_dry_run)),
  CONSTRAINT assessments_graph CHECK (jsonb_typeof(graph) = 'object')
);
COMMENT ON TABLE soc.case_assessments IS 'Immutable assessment versions. Revision 1 = initial analysis; each investigation that changes the case appends revision n+1. Counterfactual runs NEVER write here. Risk, confidence and coverage are separate columns on purpose.';
COMMENT ON COLUMN soc.case_assessments.risk_value IS 'Heuristic 0-100. NOT a probability.';
COMMENT ON COLUMN soc.case_assessments.containment_dry_run IS 'Literally true when a containment recommendation exists. Nothing is ever executed.';
CREATE INDEX assessments_latest ON soc.case_assessments (case_id, revision DESC);
CREATE INDEX assessments_verdict ON soc.case_assessments (verdict);

-- gap-free revisions, serialized per case (same advisory key the investigation functions use)
CREATE FUNCTION soc.assign_revision_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = soc, pg_catalog
AS $$
DECLARE v_max integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('soc.case:' || NEW.case_id, 0));
  SELECT coalesce(max(revision), 0) INTO v_max FROM soc.case_assessments WHERE case_id = NEW.case_id;
  IF NEW.revision <> v_max + 1 THEN
    RAISE EXCEPTION 'case % expects revision % but got %', NEW.case_id, v_max + 1, NEW.revision USING ERRCODE = 'SC210';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_revision_gapfree BEFORE INSERT ON soc.case_assessments FOR EACH ROW EXECUTE FUNCTION soc.assign_revision_check();

-- ---------------------------------------------------------------- case_events
CREATE TABLE soc.case_events (
  case_id                 text NOT NULL,
  dataset_id              text NOT NULL,
  event_id                text NOT NULL,
  added_in_assessment_id  uuid NOT NULL,
  PRIMARY KEY (case_id, dataset_id, event_id),
  CONSTRAINT case_events_case_dataset FOREIGN KEY (case_id, dataset_id) REFERENCES soc.cases (case_id, dataset_id) ON DELETE RESTRICT,
  CONSTRAINT case_events_event FOREIGN KEY (dataset_id, event_id) REFERENCES soc.source_events (dataset_id, event_id) ON DELETE RESTRICT,
  CONSTRAINT case_events_assessment FOREIGN KEY (added_in_assessment_id, case_id) REFERENCES soc.case_assessments (assessment_id, case_id) ON DELETE RESTRICT
);
COMMENT ON TABLE soc.case_events IS 'Evidence set of a case. Events at revision n are rows whose added_in assessment has revision <= n. The set only grows.';
CREATE INDEX case_events_by_event ON soc.case_events (dataset_id, event_id);
CREATE INDEX case_events_by_assessment ON soc.case_events (added_in_assessment_id);

-- A case is complete only with revision 1 and its anchor event in the evidence set. Checked at commit.
CREATE FUNCTION soc.check_case_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path = soc, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM soc.case_assessments WHERE case_id = NEW.case_id AND revision = 1) THEN
    RAISE EXCEPTION 'case % has no initial assessment (revision 1)', NEW.case_id USING ERRCODE = 'SC211';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM soc.case_events WHERE case_id = NEW.case_id AND dataset_id = NEW.dataset_id AND event_id = NEW.anchor_event_id) THEN
    RAISE EXCEPTION 'case % does not include its anchor event %', NEW.case_id, NEW.anchor_event_id USING ERRCODE = 'SC212';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_case_complete AFTER INSERT ON soc.cases DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION soc.check_case_complete();

-- An event can only support something in an assessment whose revision is >= the revision that added the event.
CREATE FUNCTION soc.assert_event_visible(p_case text, p_dataset text, p_event text, p_assessment uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = soc, pg_catalog
AS $$
DECLARE v_added integer; v_rev integer;
BEGIN
  SELECT a.revision INTO v_added FROM soc.case_events ce JOIN soc.case_assessments a ON a.assessment_id = ce.added_in_assessment_id
   WHERE ce.case_id = p_case AND ce.dataset_id = p_dataset AND ce.event_id = p_event;
  SELECT revision INTO v_rev FROM soc.case_assessments WHERE assessment_id = p_assessment;
  -- an event missing from case_events is reported by the foreign key, not here
  IF v_added IS NOT NULL AND v_rev IS NOT NULL AND v_added > v_rev THEN
    RAISE EXCEPTION 'event % was added in revision % but is cited by revision %', p_event, v_added, v_rev USING ERRCODE = 'SC220';
  END IF;
END $$;

-- ---------------------------------------------------------------- findings (+ evidence references)
CREATE TABLE soc.findings (
  assessment_id  uuid NOT NULL,
  case_id        text NOT NULL,
  finding_id     text NOT NULL,
  rule_id        text NOT NULL,
  title          text NOT NULL,
  description    text NOT NULL,
  severity       text NOT NULL,
  stance         text NOT NULL,
  weight         numeric(6,2) NOT NULL,
  evidence       jsonb,
  PRIMARY KEY (assessment_id, finding_id),
  CONSTRAINT findings_with_case UNIQUE (assessment_id, finding_id, case_id),
  CONSTRAINT findings_assessment FOREIGN KEY (assessment_id, case_id) REFERENCES soc.case_assessments (assessment_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT findings_id CHECK (finding_id ~ '^[^[:space:]]{1,128}$'),
  CONSTRAINT findings_severity CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT findings_stance CHECK (stance IN ('supporting', 'contradicting')),
  CONSTRAINT findings_weight_sign CHECK ((stance = 'supporting' AND weight >= 0) OR (stance = 'contradicting' AND weight <= 0)),
  CONSTRAINT findings_evidence CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'object'),
  CONSTRAINT findings_text CHECK (char_length(title) BETWEEN 1 AND 300 AND char_length(rule_id) BETWEEN 1 AND 64)
);
COMMENT ON TABLE soc.findings IS 'Detection results per assessment. The same finding_id recurs across revisions (history). weight is the SIGNED contribution to the risk score.';
CREATE INDEX findings_by_id ON soc.findings (finding_id);
CREATE INDEX findings_by_rule ON soc.findings (rule_id);
CREATE INDEX findings_by_stance ON soc.findings (assessment_id, stance);

CREATE TABLE soc.finding_events (
  assessment_id  uuid NOT NULL,
  finding_id     text NOT NULL,
  case_id        text NOT NULL,
  dataset_id     text NOT NULL,
  event_id       text NOT NULL,
  ordinal        smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (assessment_id, finding_id, event_id),
  CONSTRAINT finding_events_finding FOREIGN KEY (assessment_id, finding_id, case_id) REFERENCES soc.findings (assessment_id, finding_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT finding_events_case_event FOREIGN KEY (case_id, dataset_id, event_id) REFERENCES soc.case_events (case_id, dataset_id, event_id) ON DELETE RESTRICT,
  CONSTRAINT finding_events_ordinal CHECK (ordinal >= 1)
);
COMMENT ON TABLE soc.finding_events IS 'Source events a finding cites. A citation must be a real event that belongs to the same case (composite FK to case_events) and must already exist at the finding''s revision (trigger). Supporting vs contradicting is findings.stance.';
CREATE INDEX finding_events_by_event ON soc.finding_events (dataset_id, event_id);

CREATE FUNCTION soc.finding_event_visible() RETURNS trigger
LANGUAGE plpgsql SET search_path = soc, pg_catalog
AS $$
BEGIN
  PERFORM soc.assert_event_visible(NEW.case_id, NEW.dataset_id, NEW.event_id, NEW.assessment_id);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_finding_event_visible BEFORE INSERT ON soc.finding_events FOR EACH ROW EXECUTE FUNCTION soc.finding_event_visible();

-- "findings[].event_ids is never empty" (contract). Checked at commit.
CREATE FUNCTION soc.check_finding_cites_events() RETURNS trigger
LANGUAGE plpgsql SET search_path = soc, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM soc.finding_events WHERE assessment_id = NEW.assessment_id AND finding_id = NEW.finding_id) THEN
    RAISE EXCEPTION 'finding % must cite at least one source event', NEW.finding_id USING ERRCODE = 'SC221';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_finding_cites AFTER INSERT ON soc.findings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION soc.check_finding_cites_events();

-- ---------------------------------------------------------------- ATT&CK mappings
CREATE TABLE soc.attack_mappings (
  assessment_id  uuid NOT NULL,
  case_id        text NOT NULL,
  technique_id   text NOT NULL,
  name           text NOT NULL,
  tactic         text NOT NULL,
  PRIMARY KEY (assessment_id, technique_id),
  CONSTRAINT attack_with_case UNIQUE (assessment_id, technique_id, case_id),
  CONSTRAINT attack_assessment FOREIGN KEY (assessment_id, case_id) REFERENCES soc.case_assessments (assessment_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT attack_technique CHECK (technique_id ~ '^T[0-9]{4}(\.[0-9]{3})?$')
);
CREATE TABLE soc.attack_mapping_events (
  assessment_id  uuid NOT NULL,
  technique_id   text NOT NULL,
  case_id        text NOT NULL,
  dataset_id     text NOT NULL,
  event_id       text NOT NULL,
  PRIMARY KEY (assessment_id, technique_id, event_id),
  CONSTRAINT attack_events_mapping FOREIGN KEY (assessment_id, technique_id, case_id) REFERENCES soc.attack_mappings (assessment_id, technique_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT attack_events_case_event FOREIGN KEY (case_id, dataset_id, event_id) REFERENCES soc.case_events (case_id, dataset_id, event_id) ON DELETE RESTRICT
);
COMMENT ON TABLE soc.attack_mapping_events IS 'Observed events that justify a technique mapping (never inferred ones).';
CREATE FUNCTION soc.attack_event_visible() RETURNS trigger
LANGUAGE plpgsql SET search_path = soc, pg_catalog
AS $$
BEGIN
  PERFORM soc.assert_event_visible(NEW.case_id, NEW.dataset_id, NEW.event_id, NEW.assessment_id);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_attack_event_visible BEFORE INSERT ON soc.attack_mapping_events FOR EACH ROW EXECUTE FUNCTION soc.attack_event_visible();

-- ---------------------------------------------------------------- missing evidence (uncertainty)
CREATE TABLE soc.missing_evidence (
  assessment_id   uuid NOT NULL,
  case_id         text NOT NULL,
  missing_id      text NOT NULL,
  telemetry       text NOT NULL,
  why_it_matters  text NOT NULL,
  PRIMARY KEY (assessment_id, missing_id),
  CONSTRAINT missing_assessment FOREIGN KEY (assessment_id, case_id) REFERENCES soc.case_assessments (assessment_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT missing_id CHECK (missing_id ~ '^[^[:space:]]{1,128}$')
);
COMMENT ON TABLE soc.missing_evidence IS 'Expected telemetry that is absent. Absence is not evidence that activity was benign.';

-- ---------------------------------------------------------------- views (security_invoker: caller''s own privileges and RLS apply)
CREATE VIEW soc.case_event_view WITH (security_invoker = true) AS
SELECT ce.case_id, ce.dataset_id, e.event_id, e.timestamp, e.event_type, e.username, e.source_ip, e.destination_ip, e.host, e.resource,
       e.outcome, e.source_file, e.line_number, e.raw_text, e.raw_sha256 AS raw_hash, a.revision AS added_in_revision
  FROM soc.case_events ce
  JOIN soc.source_events e ON e.dataset_id = ce.dataset_id AND e.event_id = ce.event_id
  JOIN soc.case_assessments a ON a.assessment_id = ce.added_in_assessment_id;
COMMENT ON VIEW soc.case_event_view IS 'Events of a case in contract replay order: ORDER BY timestamp, source_file, line_number, event_id. raw_hash is raw_sha256.';

CREATE VIEW soc.case_latest_assessment WITH (security_invoker = true) AS
SELECT c.case_id, c.dataset_id, c.correlation_key, c.anchor_event_id, c.title, c.investigation_budget_total, c.created_at,
       a.assessment_id, a.revision, a.verdict, a.verdict_rationale, a.severity, a.risk_value, a.risk_band, a.risk_reasoning,
       a.confidence_level, a.confidence_rationale, a.coverage_ratio, a.coverage_present, a.coverage_missing, a.primary_entities,
       a.containment_action, a.containment_target, a.containment_rationale, a.containment_dry_run, a.graph, a.created_at AS assessed_at,
       s.event_count, s.first_seen, s.last_seen
  FROM soc.cases c
  JOIN LATERAL (SELECT * FROM soc.case_assessments x WHERE x.case_id = c.case_id ORDER BY x.revision DESC LIMIT 1) a ON true
  JOIN LATERAL (SELECT count(*)::integer AS event_count, min(e.timestamp) AS first_seen, max(e.timestamp) AS last_seen
                  FROM soc.case_events ce JOIN soc.source_events e ON e.dataset_id = ce.dataset_id AND e.event_id = ce.event_id
                 WHERE ce.case_id = c.case_id) s ON true;
COMMENT ON VIEW soc.case_latest_assessment IS 'Case identity + newest assessment + derived event_count/first_seen/last_seen. Status and budget are added by soc.case_current (P1).';

-- ---------------------------------------------------------------- security
SELECT soc.secure_table('soc.cases');
SELECT soc.secure_table('soc.case_assessments');
SELECT soc.secure_table('soc.case_events');
SELECT soc.secure_table('soc.findings');
SELECT soc.secure_table('soc.finding_events');
SELECT soc.secure_table('soc.attack_mappings');
SELECT soc.secure_table('soc.attack_mapping_events');
SELECT soc.secure_table('soc.missing_evidence');

GRANT SELECT ON soc.case_event_view, soc.case_latest_assessment TO soc_api, soc_readonly;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA soc FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soc.assert_event_visible(text, text, text, uuid), soc.assign_revision_check(), soc.check_case_complete(),
  soc.finding_event_visible(), soc.check_finding_cites_events(), soc.attack_event_visible() TO soc_api;
