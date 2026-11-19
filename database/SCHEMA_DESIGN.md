# SOC Sentinel PostgreSQL schema design (revision 2: approved decisions applied)

_Branch `feat/database-schema` (from `cef5c7d`). Target: Supabase PostgreSQL 17, accessed only by FastAPI. Migrations: `supabase/migrations/`. Verified against a disposable local PostgreSQL 18.6 (see §10 for exactly what that does and does not prove)._
_Diagram: `ER_DIAGRAM.md`. Open items: `SCHEMA_OPEN_QUESTIONS.md`. Integration: `INTEGRATION_PLAN.md`. Backend-facing requirements: `MEMBER1_HANDOFF.md`. Setup: `README.md`._

## 0. Decisions applied (from your review)

| Decision | How it is implemented |
|---|---|
| **Q1** immutable, versioned assessments | `case_assessments` (revision 1..n, gap-free, append-only). `cases` is immutable identity. Reports and decisions reference `assessment_id`. Counterfactual never writes case tables. |
| **Q2** dedupe by file SHA-256, keep upload history | `datasets` = one row per distinct file content (`file_sha256` UNIQUE, `dataset_id` derived from it). `dataset_uploads` = every upload with its own filename and a `was_duplicate` flag. Identical bytes under any filename resolve to the same dataset; no upload is lost. |
| **Q18** one migration system | Supabase CLI SQL migrations are the only schema source. SQLAlchemy maps to them and never calls `create_all`. PostgreSQL only (SQLite fallback not supported; Member 1 to confirm test approach). |
| Correction 1 | Stable case identity distinguishing clusters (§3). |
| Correction 2 | `raw_text`, `source_file`, `line_number`, `raw_sha256` enforced by CHECK; legacy hash kept separately (§4). |
| Correction 3 | `event_id` is dataset-scoped and derived; enforced by CHECK (§4). |
| Correction 4 | Security model reviewed for mutual compatibility and tested (§7). |
| Correction 5 | Investigation budget transaction protocol, tested under concurrency and timeouts (§6). |
| Correction 6 | Finding-to-event integrity by composite FK to `case_events` (§5). |
| Correction 7 | Report citations keep unresolved references honestly (§5). |
| Correction 8 | Counterfactual cannot overwrite originals (§8). |

## 1. Migration stages (P0 / P1 / P2)

| File (`supabase/migrations/`) | Stage | Contents |
|---|---|---|
| `20261119120000_p0_foundation_ingestion.sql` | **P0** | schema `soc`, roles, id-derivation functions, security helper, `datasets`, `dataset_uploads`, `quarantined_records`, `source_events` |
| `20261119120100_p0_cases_assessments_evidence.sql` | **P0** | `cases`, `case_assessments`, `case_events`, `findings`, `finding_events`, `attack_mappings`, `attack_mapping_events`, `missing_evidence`, views `case_event_view`, `case_latest_assessment` |
| `20261119120200_p1_reports_decisions.sql` | **P1** | `reports`, `report_claims`, `report_claim_citations`, `analyst_decisions`, views `report_citation_audit`, `case_status` |
| `20261119120300_p1_investigation.sql` | **P1** | `planner_candidates`, `investigation_queries`, `investigation_query_events`, functions `investigation_budget`, `begin_investigation_query`, `record_investigation_query`, views `case_current`, `planner_candidate_state` |
| `20261119120400_p2_adversarial.sql` | **P2** | `adversarial_runs`, `adversarial_pipeline_results`, `adversarial_trials`, view `adversarial_run_summary` |
| `database/optional/20261119120500_p2_counterfactual_audit.sql` | optional | `counterfactual_runs`, `counterfactual_excluded_events` (NOT in `supabase/migrations/`; contract says counterfactuals are not persisted) |

Dependency order follows foreign keys; P2 depends only on the foundation file. Every file is plain SQL with no transaction control, no DROP/TRUNCATE/DELETE/CASCADE, no extensions, no passwords. Each ends by calling `soc.secure_table()` on its own tables, so any prefix of the migrations is fully locked down.

## 2. Tables (22 core)

Conventions: backend-derived ids are `text` and CHECK-verified against the derivation functions; DB-generated ids (`uuid`, `dec_…`, `rep_…`) use defaults. All timestamps `timestamptz` UTC. Every FK is `ON DELETE RESTRICT`. Every table is append-only (§7). "Writes" = backend component, "Reads" = API endpoint (contract names).

### Ingestion
**`datasets`**: PK `dataset_id` (CHECK `= 'ds_' || left(file_sha256,16)`); UNIQUE `file_sha256` (64 lowercase hex); `canonical_filename` (first upload's name; no `/`, `\`, control chars; ≤255); `file_size_bytes` (1..10485760); `file_format` (`csv`/`json`); `total_records`, `valid_events`, `quarantined_records` (CHECK valid+quarantined=total); `created_at`. A deferred constraint trigger requires a first upload with the canonical filename. _Writes:_ ingestion on `POST /api/upload`. _Reads:_ `UploadResponse`, case provenance.
**`dataset_uploads`**: PK `upload_id` (uuid); FK `dataset_id`; `original_filename`; `uploaded_at`; `was_duplicate`; `request_id`. UNIQUE partial index: one `was_duplicate = false` row per dataset. Index `(dataset_id, uploaded_at)`. _Writes:_ every upload (first = false, repeats = true).
**`quarantined_records`**: PK `(dataset_id, row_number)`; `reason` (≤2000); `raw_record jsonb` (free-form; never returned by the API). _Reads:_ `UploadResponse.validation_errors` (`row_number`, `reason`).
**`source_events`** (evidence): PK `(dataset_id, event_id)`; `timestamp` (UTC), `event_type`, nullable `username`/`source_ip`/`destination_ip`/`host`/`resource` (text, never `inet`), `outcome` (success/failure/unknown), `source_file`, `line_number` (≥1), `raw_text` (non-empty), `raw_sha256`, nullable `canonical_json_sha256`, nullable `raw_record jsonb` (object), `ingested_at`. UNIQUE `(dataset_id, source_file, line_number)`. Indexes: replay order `(dataset_id, timestamp, source_file, line_number, event_id)`; partial `(dataset_id, username|source_ip|host, timestamp)` for the three planner tools; `(dataset_id, event_type, outcome)`. _Reads:_ `GET /cases/{id}` → `events[]` (`raw_hash` = `raw_sha256`), investigation retrieval.

### Cases and assessments
**`cases`**: PK `case_id` (CHECK derived, §3); FK `dataset_id`; `correlation_key`; `anchor_event_id` (FK → `source_events`); `title`; `investigation_budget_total` (0..100, default 3); `created_at`. UNIQUE `(dataset_id, correlation_key, anchor_event_id)` and `(case_id, dataset_id)`. A deferred trigger requires revision 1 and the anchor in `case_events`.
**`case_assessments`**: PK `assessment_id`; FK `case_id`; `revision` (UNIQUE with case; gap-free via trigger + advisory lock); `cause` (`initial` iff revision 1, else `investigation`); `verdict` (4 contract values) + `verdict_rationale`; `severity`; `risk_value` 0..100 + `risk_band` (low/investigate/high) + `risk_reasoning[]`; `confidence_level` + `confidence_rationale`; `coverage_ratio` 0..1 + `coverage_present[]`/`coverage_missing[]`; `primary_entities[]`; optional containment (all-or-none, `containment_dry_run` literally true); `graph jsonb` (object); `created_at`. UNIQUE `(assessment_id, case_id)` (composite-FK target). Risk, confidence and coverage are separate columns on purpose. _Writes:_ case builder (rev 1), investigation (rev n+1). _Reads:_ `CaseDetail`, `CaseSummary`.
**`case_events`**: PK `(case_id, dataset_id, event_id)`; FKs `(case_id,dataset_id)`→`cases`, `(dataset_id,event_id)`→`source_events`, `(added_in_assessment_id, case_id)`→`case_assessments`. The evidence set of revision *n* = rows added in revisions ≤ *n*. Isolation: an event of another dataset cannot join a case (tested).
**`findings`**: PK `(assessment_id, finding_id)`; `case_id` (FK `(assessment_id, case_id)`); `rule_id`, `title`, `description`, `severity`, `stance` (supporting/contradicting), `weight numeric(6,2)` signed (CHECK: supporting ≥ 0, contradicting ≤ 0), `evidence jsonb`. The same `finding_id` recurs across revisions (history).
**`finding_events`**: PK `(assessment_id, finding_id, event_id)`; FK `(assessment_id, finding_id, case_id)`→`findings`; FK `(case_id, dataset_id, event_id)`→`case_events`; trigger rejects events added in a later revision than the finding's assessment; a deferred trigger on `findings` requires ≥ 1 citation.
**`attack_mappings`** (PK `(assessment_id, technique_id)`, `T####[.###]`) and **`attack_mapping_events`** (same integrity as `finding_events`). **`missing_evidence`**: PK `(assessment_id, missing_id)`, `telemetry`, `why_it_matters`.

### Reports and decisions (P1)
**`reports`**: PK `report_id` (default `rep_<12 hex>`); `case_id`+`assessment_id` (composite FK: report belongs to one assessment of its own case); `generated_by` (`llm`/`template_fallback`; fallback requires `fallback_reason`); `summary`, `verdict_rationale`, `missing_information[]`; `citation_total/verified/rejected` as reported (CHECK verified+rejected=total); `llm_model`, `request_id`, `created_at`. No uniqueness on `assessment_id` (regeneration allowed; newest row is current). **`report_claims`**: PK `(report_id, claim_id)`, `ordinal`, `text`, `verified`, `verification_note`. **`report_claim_citations`**: §5.
**`analyst_decisions`**: PK `decision_id` (default `dec_<12 hex>`); `seq` `GENERATED ALWAYS AS IDENTITY` (ordering, un-forgeable); `case_id`+`assessment_id` (version seen); `decision` approve/reject; `analyst_id` (non-blank free text, ≤128, NOT an authenticated identity); `note` (nullable ≤10000); `decided_at`; `dry_run` (CHECK true); `request_id`. Repeated decisions allowed; `case_status` view derives status from the latest.

### Investigation (P1)
**`planner_candidates`**: PK `(assessment_id, ordinal)`; `tool` (the three agreed), `params jsonb` (object of strings), optional `relevance`/`expected_uncertainty_reduction` (0..1), `retrieval_cost`, `recommended`, `reason`. `used` is derived (view). **`investigation_queries`**: §6. **`investigation_query_events`**: PK `(query_id, event_id)`; FK to `case_events`; `was_new_to_case`.

### Red team (P2)
**`adversarial_runs`** (PK `run_id`; `scenario_id` ∈ 3 values; `trials_requested` 1..10; title, field, `untrusted_payload` ≤10000 inert; `settings jsonb` object; `request_id`), **`adversarial_pipeline_results`** (PK `(run_id, pipeline)`; reported trials/successes/citation counts, stored as received even if inconsistent), **`adversarial_trials`** (PK `(run_id, pipeline, trial_no 1..10)`; `output`; `injection_succeeded NOT NULL`). Only returned trials have rows; the view recomputes returned vs reported counts and success rates from rows (never stored).

### Views (all `security_invoker`: the caller's own privileges and RLS apply)
`case_event_view`, `case_latest_assessment`, `case_status`, `case_current` (GET /cases: newest assessment + derived status, `event_count`, `first_seen`, `last_seen`, `budget_remaining`), `planner_candidate_state`, `report_citation_audit`, `adversarial_run_summary`.

## 3. Stable case identity (correction 1)

`case_id = 'case_' + hex(sha256(dataset_id ␟ correlation_key ␟ anchor_event_id))[:16]` (␟ = U+001F), enforced by CHECK `cases_id_derived` through `soc.derive_case_id()`.
* **Distinguishes clusters for the same IP:** `correlate_alerts` splits one correlation key (IP) into several time clusters. Each cluster has a different **anchor** = the earliest event (by timestamp, source_file, line_number, event_id) of that cluster at **original ingestion**, so each gets its own id. `(dataset_id, correlation_key, anchor_event_id)` is the natural key (UNIQUE).
* **Does not change when evidence is excluded:** the id is computed once, from the **original full dataset's** clustering, and then **stored** and never recomputed from a reduced event set. A counterfactual recomputation is hypothetical, runs in memory, and produces no case row; investigation adds events but the stored id and anchor are immutable. Re-ingesting identical bytes resolves to the same dataset (Q2) and therefore the same cases.
* The anchor must itself be in `source_events` (FK) and in the case's evidence set (deferred check).
* Backend dependency: the backend must pick the anchor from the original cluster and derive the id exactly this way (`MEMBER1_HANDOFF.md`, vectors in `tests/vectors.json`, verified Python ↔ PostgreSQL).

## 4. Original provenance and the hash transition (corrections 2 and 3)

Stored per event: verbatim `raw_text`, `source_file`, `line_number`, `raw_sha256`, normalized fields. Integrity CHECKs: `raw_sha256 = hex(sha256(utf8(raw_text)))`; `event_id = derive_event_id(dataset_id, source_file, line_number, raw_sha256)`.

* **Event id:** `evt_` + `hex(sha256(dataset_id ␟ source_file ␟ line_number ␟ raw_sha256))[:16]`. Dataset-scoped (two datasets holding an identical row get different ids; tested) and stable across repeated ingestion (same bytes → same dataset, same file name, same line, same text → same id).
* **Two different hashes exist; do not confuse them:**

| | Current backend (`generate_hash`) | This schema |
|---|---|---|
| Name | `raw_hash` | `raw_sha256` (API field `raw_hash`) |
| Input | canonical JSON of the **parsed** record (`sort_keys`, compact) | the **original record text** (`raw_text`) as UTF-8 |
| Meaning | identity of parsed content | provenance of what was actually in the file |
| Used for | part of today's `event_id` | integrity anchor; verified by CHECK; part of the new `event_id` |

  The legacy value may be stored in `canonical_json_sha256` (nullable, format-checked) for transition cross-checks. It is not an integrity anchor.
* **Compatibility implications:** (a) nothing is persisted today, so no stored data migrates; (b) **every event id changes** versus today's backend (new formula: dataset-scoped, hash of original text), so ids captured in `frontend/src/api/realBackendSamples.ts` become obsolete and must be re-captured during integration; (c) tests that assert today's ids will change; (d) the contract statement "same file re-uploaded yields the same ids" now holds by construction; (e) the backend must start supplying `raw_text` and `line_number`, which it does not produce today.
* **Line number convention:** CSV = 1-based physical line where the record **starts** (header is line 1; the backend's `enumerate(start=2)` is wrong for quoted multi-line fields and must use the reader's physical line counter); JSON = 1-based element index. `datasets.file_format` tells which.
* **JSON `raw_text`:** a parsed JSON array cannot return byte-exact element text; the handoff specifies a deterministic definition (compact re-serialization preserving key order) and flags it as open question Q26.

## 5. Evidence integrity of findings, citations and reports (corrections 6 and 7)

* **Finding ↔ event (supporting or contradicting):** `finding_events` has a composite FK `(case_id, dataset_id, event_id)` → `case_events`. A finding therefore cannot cite a nonexistent event, an event of another dataset, or a real event that is not in its case (the retrievable-but-not-yet-folded-in event in the tests). A trigger forbids citing an event that was added in a later revision than the finding's assessment. A deferred trigger rejects a finding with no citation. Stance lives on the finding; the sign of `weight` is CHECKed against it. `attack_mapping_events` has the same guarantees.
* **Report citations keep unresolved references:** `report_claim_citations.cited_event_id` stores exactly what the report said. `resolved_dataset_id` is NULL when it did not resolve (composite FK is `MATCH SIMPLE`, so NULL skips the check), and `resolved` is a generated column. A non-NULL `resolved_dataset_id` must match a real event of the report's own case (FK) that existed at the report's revision (trigger). A claim marked `verified` must have ≥ 1 citation and every citation resolved (triggers `SC230`/`SC231`), so an invented citation can be stored but can never support a verified claim. `report_citation_audit` shows reported vs recomputed counts.

## 6. Investigation budget: transaction behaviour (correction 5)

Data model: budget total on `cases` (default 3); remaining = `total − count(investigation_queries)` (derived, cannot drift). `investigation_queries` holds only **executed (charged)** queries; its constraints are the correctness backstop: `UNIQUE (case_id, idempotency_key)`, `UNIQUE (case_id, sequence_no)`, and a `BEFORE INSERT` guard trigger that enforces gap-free sequence ≤ budget and consistent `budget_remaining_after` **even if a client bypasses the functions**.

Protocol (ONE database transaction, run by the backend; details and SQLSTATEs in `MEMBER1_HANDOFF.md` / `INTEGRATION_PLAN.md`):
1. `begin_investigation_query(case, key, request_hash)`: takes `pg_advisory_xact_lock` on the case (serializes everything for that case; released at COMMIT/ROLLBACK), then returns `replay` (key already executed with the same request: stored result, **no charge**) or `proceed`; raises `SC001` (exhausted), `SC002` (same key, different request), `SC404` (unknown case).
2. Backend retrieves existing events (reads) and computes the reassessment.
3. If the case changed: insert the new assessment (+children) and `case_events` for newly folded-in events.
4. `record_investigation_query(...)`: re-checks, inserts the ledger row and `investigation_query_events`; refuses stale/foreign assessments (`SC003`), non-array/unknown events (`SC006`/`SC007`).
5. COMMIT.

| Situation | Behaviour (all verified by `run_tests.py` unless noted) |
|---|---|
| 8 parallel different keys, budget 3 | exactly 3 succeed, 5 get `SC001`, ledger `(1,2),(2,1),(3,0)` |
| 6 parallel retries, same key + request | all succeed, charged once |
| Same key, different request (concurrent) | one succeeds, other `SC002` |
| Exhausted budget, retry of an old key | replay still returns the stored result, free |
| Failure/exception before COMMIT | everything rolls back: no ledger row, no new assessment, no events, no charge |
| Cannot get the case lock | `lock_timeout` (role default 10 s) → `55P03`, nothing charged; retry with the same key |
| Slow transaction | `statement_timeout` (role default 30 s) → `57014`, nothing charged |
| Client stalls inside the transaction | `idle_in_transaction_session_timeout` (role default 60 s) kills the session, releasing the lock; waiting request proceeds |
| Two writers race for the same revision | one wins, other `SC210` |
| Client crash mid-request | connection loss aborts the transaction (standard PostgreSQL behaviour; not separately tested) |
| Backend timeout/retry | retry with the **same** idempotency key: safe by construction (the earlier attempt either committed fully or not at all) |

Why an advisory lock and not `SELECT … FOR UPDATE`: row locks need `UPDATE` privilege, which `soc_api` deliberately lacks. The constraints above guarantee correctness even without the lock; the lock just removes retries.

## 7. Security model (correction 4)

Compatibility of the three pieces, and the choices that make them work together:
* **Private schema (`soc`)**: `USAGE` revoked from PUBLIC; granted only to `soc_api` and `soc_readonly`. Do not add `soc` to Supabase's exposed schemas (Settings → API). Neither `anon`, `authenticated` nor `service_role` receives any privilege (explicitly revoked, and verified for every table).
* **FORCE ROW LEVEL SECURITY** is on for every table, so even the table owner is subject to policy. Policies exist only for `SELECT` (soc_api, soc_readonly) and `INSERT` (soc_api); with no `UPDATE`/`DELETE` policy those commands are denied by default, in addition to missing grants and triggers. Consequence to know: a migration/owner role without `BYPASSRLS` would see zero rows in `soc` tables (tested). Supabase's `postgres` role normally holds `BYPASSRLS`; verify it (`README.md`).
* **`soc_api`**: `LOGIN`, no superuser/`BYPASSRLS`/`CREATEDB`/`CREATEROLE`/replication, connection limit 20, `search_path = soc, pg_catalog`, `statement_timeout 30s`, `lock_timeout 10s`, `idle_in_transaction_session_timeout 60s`. Table privileges: `SELECT, INSERT` only. `EXECUTE` on the investigation functions and on trigger/derivation functions; **no** `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, no `CREATE` in the schema, cannot call the owner-only `soc.secure_table`. Created **without a password** (set it manually; `README.md`).
* **`soc_readonly`**: `SELECT` only, `default_transaction_read_only = on`.
* **Functions** are `SECURITY INVOKER` (so RLS applies to them), have a pinned `search_path`, and `EXECUTE` is revoked from PUBLIC. Views are `security_invoker`, so they cannot leak rows past RLS (tested with a role that has grants but no policy).
* **Sequences:** the only generated number is an identity column (`analyst_decisions.seq`); `soc_api` inserts into it with no extra sequence grant (tested); `GENERATED ALWAYS` blocks forged values.
* **Append-only:** `BEFORE UPDATE/DELETE` row triggers and `BEFORE TRUNCATE` statement triggers on every table (a second line of defence that also stops a privileged session); all FKs `RESTRICT`. `TRUNCATE … CASCADE` is blocked too.
* **Secrets:** no password, key, JWT or connection string in the repo (static-scanned); `DATABASE_URL` belongs only in the backend's environment. No `service_role` key is needed because FastAPI connects directly to Postgres, not through the Data API.
* Single-tenant: no per-user policies, because the contract has no authentication (`analyst_id` is free text).

## 8. Counterfactual preservation (correction 8)
Counterfactuals write nothing to case tables. The stored original is protected by: immutable `case_assessments`/`findings`/`case_events` (grants + triggers), stable `case_id`, and (if the optional audit file is applied) a separate `counterfactual_runs` table whose `original_assessment_id` must be the case's **current** stored assessment and whose excluded events must be real case events; excluded events are **not** removed from `case_events`. Tested: after a run the original assessment row is byte-for-byte unchanged and the case's events/findings/assessments counts are identical.

## 9. Not stored, by design
Case `status`, `budget_remaining`, `event_count`, `first_seen`/`last_seen`, planner `used`, report citation tallies, red-team success rates: derived in views so they cannot disagree with the evidence. Hash of a counterfactual outcome: not stored (the contract does not persist it).

## 10. Verification status (honest)
Run `python database/tests/run_tests.py`. **Executed against a disposable local PostgreSQL 18.6** (Supabase runs 17.x): 42 checks, including ~560 SQL assertions, all passing: all migrations applied to empty databases as a non-superuser owner; table/PK/FK/unique/NOT NULL structure; ingestion, case, evidence, report, decision, investigation, red-team behaviour; security (roles, RLS forced, function/sequence access, mutation attempts); Python↔PostgreSQL id derivation; concurrency, retries, failures and timeouts with parallel sessions. A mutation check confirmed the tests fail when FORCE RLS, the budget guard or the UPDATE restriction is weakened.
**Not verified:** (1) PostgreSQL **17** itself (no 17 available; only features present in 14+ are used, but run the suite on 17 before relying on this); (2) a real Supabase project (pooler behaviour, the `postgres` role's actual attributes, Data API exposure, Supabase-managed default privileges) because the live project must not be touched yet; (3) client-crash mid-transaction (relies on standard PostgreSQL abort semantics); (4) load/performance; (5) the optional file on Supabase.
