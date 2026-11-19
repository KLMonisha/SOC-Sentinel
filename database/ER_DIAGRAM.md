# SOC Sentinel database: entity-relationship diagram

Matches `supabase/migrations/20261119120000` … `20261119120400` exactly (22 tables, schema `soc`). The optional counterfactual tables (`database/optional/`) are drawn dashed-labelled "OPTIONAL". Every relationship is `ON DELETE RESTRICT`.
Composite foreign keys are shown as one line; the key columns are listed in `SCHEMA_DESIGN.md`.

```mermaid
erDiagram
  datasets ||--o{ dataset_uploads : "upload history (every upload kept)"
  datasets ||--o{ quarantined_records : "rejected rows"
  datasets ||--o{ source_events : "evidence"
  datasets ||--o{ cases : "yields"
  source_events ||--o{ cases : "anchor event"

  cases ||--|{ case_assessments : "immutable versions 1..n"
  cases ||--o{ case_events : "evidence set (grows)"
  source_events ||--o{ case_events : "included in"
  case_assessments ||--o{ case_events : "added in revision"

  case_assessments ||--o{ findings : "has"
  findings ||--|{ finding_events : "cites (>=1)"
  case_events ||--o{ finding_events : "must be in the case"
  case_assessments ||--o{ attack_mappings : "has"
  attack_mappings ||--|{ attack_mapping_events : "justified by"
  case_events ||--o{ attack_mapping_events : "must be in the case"
  case_assessments ||--o{ missing_evidence : "uncertainty"
  case_assessments ||--o{ planner_candidates : "proposes"

  case_assessments ||--o{ reports : "written for one version"
  reports ||--o{ report_claims : "makes"
  report_claims ||--o{ report_claim_citations : "cites"
  case_events |o--o{ report_claim_citations : "resolves to (NULL = unresolved)"

  case_assessments ||--o{ analyst_decisions : "decided on (append-only)"
  cases ||--o{ investigation_queries : "budget ledger, idempotent"
  case_assessments ||--o{ investigation_queries : "before / after"
  investigation_queries ||--o{ investigation_query_events : "returned"
  case_events ||--o{ investigation_query_events : "now in the case"

  adversarial_runs ||--o{ adversarial_pipeline_results : "baseline + hardened"
  adversarial_pipeline_results ||--o{ adversarial_trials : "trials actually returned"

  cases ||--o{ counterfactual_runs : "OPTIONAL: what-if audit"
  case_assessments ||--o{ counterfactual_runs : "OPTIONAL: original compared against"
  counterfactual_runs ||--o{ counterfactual_excluded_events : "OPTIONAL"
  case_events ||--o{ counterfactual_excluded_events : "OPTIONAL: must be in the case"

  datasets {
    text dataset_id PK "ds_ + first 16 hex of file_sha256 (CHECK)"
    text file_sha256 UK "SHA-256 of uploaded bytes"
    text canonical_filename "first upload name; source_file of events"
  }
  dataset_uploads {
    uuid upload_id PK
    text dataset_id FK
    text original_filename "any filename"
    boolean was_duplicate "exactly one false per dataset"
  }
  source_events {
    text dataset_id PK_FK
    text event_id PK "evt_ + sha256(dataset|file|line|raw_sha256)[:16] (CHECK)"
    text source_file
    int line_number "UK with dataset+file"
    text raw_text "verbatim original record"
    text raw_sha256 "= SHA-256(raw_text) (CHECK)"
    text canonical_json_sha256 "legacy backend hash, nullable"
  }
  cases {
    text case_id PK "case_ + sha256(dataset|key|anchor)[:16] (CHECK)"
    text dataset_id FK
    text correlation_key
    text anchor_event_id FK "earliest event of the ORIGINAL cluster"
    smallint investigation_budget_total "default 3"
  }
  case_assessments {
    uuid assessment_id PK
    text case_id FK
    int revision "UK with case, gap-free"
    text verdict
    smallint risk_value "heuristic, not a probability"
    text risk_band
    text confidence_level
    numeric coverage_ratio
  }
  case_events {
    text case_id PK_FK
    text dataset_id PK_FK
    text event_id PK_FK
    uuid added_in_assessment_id FK
  }
  findings {
    uuid assessment_id PK_FK
    text finding_id PK
    text stance "supporting or contradicting"
    numeric weight "signed"
  }
  finding_events {
    uuid assessment_id PK_FK
    text finding_id PK_FK
    text event_id PK "FK to case_events (same case)"
  }
  reports {
    text report_id PK
    uuid assessment_id FK
    text generated_by "llm or template_fallback"
  }
  report_claims {
    text report_id PK_FK
    text claim_id PK
    boolean verified
  }
  report_claim_citations {
    text report_id PK_FK
    text claim_id PK_FK
    text cited_event_id "verbatim, even if invented"
    text resolved_dataset_id "NULL = unresolved"
    boolean resolved "generated"
  }
  analyst_decisions {
    text decision_id PK
    bigint seq "GENERATED ALWAYS"
    uuid assessment_id FK "version the analyst saw"
    boolean dry_run "CHECK = true"
  }
  investigation_queries {
    uuid query_id PK
    text idempotency_key UK "per case"
    smallint sequence_no UK "per case, 1..budget"
    text request_hash
  }
  adversarial_runs {
    uuid run_id PK
    text scenario_id
    smallint trials_requested "1..10"
  }
  adversarial_trials {
    uuid run_id PK_FK
    text pipeline PK_FK
    smallint trial_no PK
    boolean injection_succeeded
  }
```

Derived (never stored) values: case `status` (latest decision), `budget_remaining` (total − ledger rows), `event_count`/`first_seen`/`last_seen`, planner `used`, report citation tallies, red-team success rates. See the views `case_current`, `case_status`, `planner_candidate_state`, `report_citation_audit`, `adversarial_run_summary`.
