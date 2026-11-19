-- SOC Sentinel - P1 - reports, claims, citations, analyst decisions
-- Depends on 20261119120100. Non-destructive. No secrets.

-- ---------------------------------------------------------------- reports
CREATE TABLE soc.reports (
  report_id           text PRIMARY KEY DEFAULT ('rep_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
  case_id             text NOT NULL,
  assessment_id       uuid NOT NULL,
  generated_by        text NOT NULL,
  summary             text NOT NULL,
  verdict_rationale   text NOT NULL,
  missing_information text[] NOT NULL DEFAULT '{}',
  citation_total      smallint NOT NULL,
  citation_verified   smallint NOT NULL,
  citation_rejected   smallint NOT NULL,
  llm_model           text,
  fallback_reason     text,
  request_id          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_with_case UNIQUE (report_id, case_id),
  CONSTRAINT reports_assessment FOREIGN KEY (assessment_id, case_id) REFERENCES soc.case_assessments (assessment_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT reports_method CHECK (generated_by IN ('llm', 'template_fallback')),
  CONSTRAINT reports_fallback_reason CHECK (generated_by <> 'template_fallback' OR fallback_reason IS NOT NULL),
  CONSTRAINT reports_citation_counts CHECK (citation_total >= 0 AND citation_verified >= 0 AND citation_rejected >= 0 AND citation_verified + citation_rejected = citation_total),
  CONSTRAINT reports_id_format CHECK (report_id ~ '^[^[:space:]]{1,128}$')
);
COMMENT ON TABLE soc.reports IS 'Stored report for ONE assessment version. Append-only; the newest row for a case is the current report. citation_* are the backend''s REPORTED counts; soc.report_citation_audit recomputes the truth from rows.';
CREATE INDEX reports_latest ON soc.reports (case_id, created_at DESC);
CREATE INDEX reports_by_assessment ON soc.reports (assessment_id);

CREATE TABLE soc.report_claims (
  report_id          text NOT NULL REFERENCES soc.reports (report_id) ON DELETE RESTRICT,
  claim_id           text NOT NULL,
  ordinal            integer NOT NULL,
  text               text NOT NULL,
  verified           boolean NOT NULL,
  verification_note  text,
  PRIMARY KEY (report_id, claim_id),
  CONSTRAINT claims_ordinal CHECK (ordinal >= 1),
  CONSTRAINT claims_text CHECK (char_length(text) BETWEEN 1 AND 20000)
);
CREATE UNIQUE INDEX claims_order ON soc.report_claims (report_id, ordinal);

-- A citation keeps what the report SAID (cited_event_id) separately from whether it RESOLVED to a real case event.
-- resolved_dataset_id is NULL for unresolved citations; the composite FK is then not checked (MATCH SIMPLE).
CREATE TABLE soc.report_claim_citations (
  report_id           text NOT NULL,
  claim_id            text NOT NULL,
  case_id             text NOT NULL,
  ordinal             integer NOT NULL,
  cited_event_id      text NOT NULL,
  resolved_dataset_id text,
  resolved            boolean GENERATED ALWAYS AS (resolved_dataset_id IS NOT NULL) STORED,
  PRIMARY KEY (report_id, claim_id, ordinal),
  CONSTRAINT citations_claim FOREIGN KEY (report_id, claim_id) REFERENCES soc.report_claims (report_id, claim_id) ON DELETE RESTRICT,
  CONSTRAINT citations_report FOREIGN KEY (report_id, case_id) REFERENCES soc.reports (report_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT citations_event FOREIGN KEY (case_id, resolved_dataset_id, cited_event_id) REFERENCES soc.case_events (case_id, dataset_id, event_id) MATCH SIMPLE ON DELETE RESTRICT,
  CONSTRAINT citations_ordinal CHECK (ordinal >= 1),
  CONSTRAINT citations_event_text CHECK (char_length(cited_event_id) BETWEEN 1 AND 4096)
);
COMMENT ON TABLE soc.report_claim_citations IS 'cited_event_id is stored verbatim even when it does not exist. resolved = true only when it matches an event of the report''s case (composite FK). Unresolved citations are kept and shown as unresolved; they can never support a verified claim.';
CREATE INDEX citations_by_event ON soc.report_claim_citations (case_id, resolved_dataset_id, cited_event_id);

-- resolved citations must refer to evidence that already existed at the assessment revision of the report
CREATE FUNCTION soc.citation_checks() RETURNS trigger
LANGUAGE plpgsql SET search_path = soc, pg_catalog
AS $$
DECLARE v_assessment uuid; v_verified boolean;
BEGIN
  SELECT assessment_id INTO v_assessment FROM soc.reports WHERE report_id = NEW.report_id;
  IF NEW.resolved_dataset_id IS NOT NULL THEN
    PERFORM soc.assert_event_visible(NEW.case_id, NEW.resolved_dataset_id, NEW.cited_event_id, v_assessment);
  ELSE
    SELECT verified INTO v_verified FROM soc.report_claims WHERE report_id = NEW.report_id AND claim_id = NEW.claim_id;
    IF v_verified THEN
      RAISE EXCEPTION 'claim % is marked verified but cites unresolved event %', NEW.claim_id, NEW.cited_event_id USING ERRCODE = 'SC230';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_citation_checks BEFORE INSERT ON soc.report_claim_citations FOR EACH ROW EXECUTE FUNCTION soc.citation_checks();

-- A verified claim needs at least one citation, all resolved. Checked at commit.
CREATE FUNCTION soc.check_verified_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path = soc, pg_catalog
AS $$
BEGIN
  IF NEW.verified THEN
    IF NOT EXISTS (SELECT 1 FROM soc.report_claim_citations WHERE report_id = NEW.report_id AND claim_id = NEW.claim_id) THEN
      RAISE EXCEPTION 'claim % is marked verified but cites no event', NEW.claim_id USING ERRCODE = 'SC231';
    END IF;
    IF EXISTS (SELECT 1 FROM soc.report_claim_citations WHERE report_id = NEW.report_id AND claim_id = NEW.claim_id AND NOT resolved) THEN
      RAISE EXCEPTION 'claim % is marked verified but has an unresolved citation', NEW.claim_id USING ERRCODE = 'SC230';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_verified_claim AFTER INSERT ON soc.report_claims DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION soc.check_verified_claim();

CREATE VIEW soc.report_citation_audit WITH (security_invoker = true) AS
SELECT r.report_id, r.case_id, r.generated_by, r.citation_total AS reported_total, r.citation_verified AS reported_verified, r.citation_rejected AS reported_rejected,
       count(cc.*)::integer AS stored_citations,
       count(cc.*) FILTER (WHERE cc.resolved)::integer AS stored_resolved,
       count(cc.*) FILTER (WHERE NOT cc.resolved)::integer AS stored_unresolved,
       (SELECT count(*)::integer FROM soc.report_claims c WHERE c.report_id = r.report_id AND c.verified) AS verified_claims,
       (SELECT count(*)::integer FROM soc.report_claims c WHERE c.report_id = r.report_id AND NOT c.verified) AS unverified_claims
  FROM soc.reports r LEFT JOIN soc.report_claim_citations cc ON cc.report_id = r.report_id
 GROUP BY r.report_id;
COMMENT ON VIEW soc.report_citation_audit IS 'Recomputed truth next to what the backend reported. Differences are expected only when claims were removed before storing.';

-- ---------------------------------------------------------------- analyst_decisions (append-only audit)
CREATE TABLE soc.analyst_decisions (
  decision_id    text PRIMARY KEY DEFAULT ('dec_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  case_id        text NOT NULL,
  assessment_id  uuid NOT NULL,
  decision       text NOT NULL,
  analyst_id     text NOT NULL,
  note           text,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  dry_run        boolean NOT NULL DEFAULT true,
  request_id     text,
  CONSTRAINT decisions_assessment FOREIGN KEY (assessment_id, case_id) REFERENCES soc.case_assessments (assessment_id, case_id) ON DELETE RESTRICT,
  CONSTRAINT decisions_decision CHECK (decision IN ('approve', 'reject')),
  CONSTRAINT decisions_analyst CHECK (btrim(analyst_id) <> '' AND char_length(analyst_id) <= 128),
  CONSTRAINT decisions_note CHECK (note IS NULL OR char_length(note) <= 10000),
  CONSTRAINT decisions_dry_run CHECK (dry_run),
  CONSTRAINT decisions_id_format CHECK (decision_id ~ '^[^[:space:]]{1,128}$'),
  CONSTRAINT decisions_seq UNIQUE (seq)
);
COMMENT ON TABLE soc.analyst_decisions IS 'Append-only audit. dry_run is always true: no code path executes containment. assessment_id records which version the analyst saw. Repeated decisions are allowed; case status follows the latest.';
COMMENT ON COLUMN soc.analyst_decisions.analyst_id IS 'Free text supplied by the client; NOT an authenticated identity.';
CREATE INDEX decisions_by_case ON soc.analyst_decisions (case_id, seq);

CREATE VIEW soc.case_status WITH (security_invoker = true) AS
SELECT c.case_id,
       coalesce((SELECT CASE d.decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END
                   FROM soc.analyst_decisions d WHERE d.case_id = c.case_id ORDER BY d.seq DESC LIMIT 1), 'open') AS status,
       (SELECT count(*)::integer FROM soc.analyst_decisions d WHERE d.case_id = c.case_id) AS decision_count
  FROM soc.cases c;
COMMENT ON VIEW soc.case_status IS 'Status derived from the latest decision (approve->approved, reject->rejected, none->open), so it cannot disagree with the audit trail.';

-- ---------------------------------------------------------------- security
SELECT soc.secure_table('soc.reports');
SELECT soc.secure_table('soc.report_claims');
SELECT soc.secure_table('soc.report_claim_citations');
SELECT soc.secure_table('soc.analyst_decisions');

GRANT SELECT ON soc.report_citation_audit, soc.case_status TO soc_api, soc_readonly;
SELECT soc.lock_down_schema();
GRANT EXECUTE ON FUNCTION soc.citation_checks(), soc.check_verified_claim() TO soc_api;
