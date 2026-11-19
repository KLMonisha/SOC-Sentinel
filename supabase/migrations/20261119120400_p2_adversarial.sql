-- SOC Sentinel - P2 - adversarial (red team) runs, per-pipeline results, trials
-- Independent of case data (the endpoint is not case-scoped). Depends only on 20261119120000 (helpers/roles).
-- Non-destructive. No secrets. All payloads and outputs are untrusted, inert text.

CREATE TABLE soc.adversarial_runs (
  run_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id       text NOT NULL,
  trials_requested  smallint NOT NULL,
  scenario_title    text NOT NULL,
  scenario_field    text NOT NULL,
  untrusted_payload text NOT NULL,
  settings          jsonb NOT NULL DEFAULT '{}',
  request_id        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adv_scenario CHECK (scenario_id IN ('user_agent_injection', 'url_query_contamination', 'fake_analyst_authorization')),
  CONSTRAINT adv_trials CHECK (trials_requested BETWEEN 1 AND 10),
  CONSTRAINT adv_payload CHECK (char_length(untrusted_payload) <= 10000),
  CONSTRAINT adv_settings CHECK (jsonb_typeof(settings) = 'object')
);
COMMENT ON TABLE soc.adversarial_runs IS 'One POST /api/adversarial/run. untrusted_payload is inert test data returned by the harness; never interpreted.';
CREATE INDEX adv_runs_time ON soc.adversarial_runs (created_at DESC);
CREATE INDEX adv_runs_scenario ON soc.adversarial_runs (scenario_id, created_at DESC);

CREATE TABLE soc.adversarial_pipeline_results (
  run_id                      uuid NOT NULL REFERENCES soc.adversarial_runs (run_id) ON DELETE RESTRICT,
  pipeline                    text NOT NULL,
  trials_reported             smallint NOT NULL,
  injection_successes_reported smallint NOT NULL,
  citation_total              smallint NOT NULL,
  citation_verified           smallint NOT NULL,
  citation_rejected           smallint NOT NULL,
  PRIMARY KEY (run_id, pipeline),
  CONSTRAINT adv_pipeline CHECK (pipeline IN ('baseline', 'hardened')),
  CONSTRAINT adv_counts CHECK (trials_reported BETWEEN 0 AND 10 AND injection_successes_reported BETWEEN 0 AND 10 AND citation_total >= 0 AND citation_verified >= 0 AND citation_rejected >= 0)
);
COMMENT ON TABLE soc.adversarial_pipeline_results IS 'What the backend REPORTED per pipeline. Rates are never stored: soc.adversarial_run_summary recomputes them from trial rows. citation counts are not forced to add up so an inconsistent report is stored as received and flagged by the view.';

CREATE TABLE soc.adversarial_trials (
  run_id             uuid NOT NULL,
  pipeline           text NOT NULL,
  trial_no           smallint NOT NULL,
  output             text NOT NULL,
  injection_succeeded boolean NOT NULL,
  PRIMARY KEY (run_id, pipeline, trial_no),
  CONSTRAINT adv_trial_result FOREIGN KEY (run_id, pipeline) REFERENCES soc.adversarial_pipeline_results (run_id, pipeline) ON DELETE RESTRICT,
  CONSTRAINT adv_trial_no CHECK (trial_no BETWEEN 1 AND 10),
  CONSTRAINT adv_output_len CHECK (char_length(output) <= 100000)
);
COMMENT ON TABLE soc.adversarial_trials IS 'Only trials the backend actually returned. A missing trial has NO row (partial runs are visible, never padded).';

CREATE VIEW soc.adversarial_run_summary WITH (security_invoker = true) AS
SELECT r.run_id, r.scenario_id, r.trials_requested, p.pipeline, p.trials_reported,
       count(t.*)::integer AS trials_returned,
       count(t.*) FILTER (WHERE t.injection_succeeded)::integer AS successes_in_records,
       p.injection_successes_reported,
       (count(t.*) < r.trials_requested) AS is_partial,
       (p.trials_reported <> count(t.*) OR p.injection_successes_reported <> count(t.*) FILTER (WHERE t.injection_succeeded)) AS reported_disagrees_with_records,
       (p.citation_verified + p.citation_rejected <> p.citation_total) AS citation_counts_inconsistent,
       CASE WHEN count(t.*) = 0 THEN NULL
            ELSE round(100.0 * count(t.*) FILTER (WHERE t.injection_succeeded) / count(t.*), 1) END AS success_rate_pct_from_records
  FROM soc.adversarial_runs r
  JOIN soc.adversarial_pipeline_results p ON p.run_id = r.run_id
  LEFT JOIN soc.adversarial_trials t ON t.run_id = p.run_id AND t.pipeline = p.pipeline
 GROUP BY r.run_id, p.pipeline, p.trials_reported, p.injection_successes_reported, p.citation_total, p.citation_verified, p.citation_rejected;
COMMENT ON VIEW soc.adversarial_run_summary IS 'Measured-from-records view of a run. success_rate_pct_from_records is computed only from stored trial rows.';

SELECT soc.secure_table('soc.adversarial_runs');
SELECT soc.secure_table('soc.adversarial_pipeline_results');
SELECT soc.secure_table('soc.adversarial_trials');
GRANT SELECT ON soc.adversarial_run_summary TO soc_api, soc_readonly;
SELECT soc.lock_down_schema();
