# Integration plan (database owner + Claude Code, after Member 1 finishes the backend)

Scope: **plan only**. Nothing here is implemented; no backend or frontend file was changed in DB1. You own PostgreSQL and the whole integration; Member 1 delivers backend functionality and endpoint behaviour. Source of truth for the schema is `supabase/migrations/`.

## 1. Backend output → PostgreSQL columns

"Today" = `origin/backend-dev @ d74a66c`. "Needed" = what must change (see `MEMBER1_HANDOFF.md`).

### 1.1 Ingestion (`ingest_file`, `normalize_record`, `SecurityEvent`)
| Backend value | → Table.column | Today / needed |
|---|---|---|
| sha256 of uploaded bytes | `datasets.file_sha256`; `datasets.dataset_id = ds_` + first 16 hex | **Needed** (not computed today) |
| uploaded filename (first time) | `datasets.canonical_filename` | `file.filename` available |
| every upload's filename | `dataset_uploads.original_filename`, `was_duplicate` | **Needed** |
| `total_records`, `valid_count`, `quarantined_count` | `datasets.total_records / valid_events / quarantined_records` | available |
| `file_format` (`.csv`/`.json`), size | `datasets.file_format`, `file_size_bytes` | available |
| quarantine `{row_number, reason, raw_record}` | `quarantined_records` | available (the API currently drops `raw_record`) |
| `SecurityEvent.timestamp` (UTC) | `source_events.timestamp` | available |
| `event_type`, `username`, `source_ip`, `destination_ip`, `host`, `resource`, `outcome` | same-named columns | available |
| `SecurityEvent.source` | `source_events.source_file` (= canonical filename) | available (naming) |
| *(none)* | `source_events.raw_text` | **Needed** |
| *(none)* | `source_events.line_number` | **Needed** (CSV physical line / JSON index) |
| `SecurityEvent.raw_hash` (canonical-JSON hash) | `source_events.canonical_json_sha256` (optional) | available; **not** the integrity hash |
| *(none)* | `source_events.raw_sha256 = sha256(raw_text)` | **Needed** |
| `SecurityEvent.event_id` | `source_events.event_id` | **Needed: new dataset-scoped formula** |
| `SecurityEvent.raw_record` (dict) | `source_events.raw_record` (jsonb) | available |

### 1.2 Detection / correlation (`run_detection`, `correlate_alerts`)
| Backend value | → Table.column | Today / needed |
|---|---|---|
| alert `alert_id` | `findings.finding_id` | available |
| alert `rule_id`, `title`, `severity`, `description` | `findings.*` | available |
| alert `event_ids[]` | `finding_events` rows | available |
| alert `evidence{}` | `findings.evidence` (jsonb) | available |
| *(none)* `stance`, signed `weight` | `findings.stance`, `findings.weight` | **Needed** |
| incident `correlation_key` | `cases.correlation_key` | available |
| *(none)* cluster anchor event | `cases.anchor_event_id`; `cases.case_id` | **Needed** |
| incident `incident_id` | **not stored** (unstable) | n/a |
| incident `event_ids[]` | `case_events` (+ `added_in_assessment_id` = revision 1) | available |
| incident `risk_score` | `case_assessments.risk_value` | available |
| incident `severity` | `case_assessments.severity` | available |
| incident `risk_reasoning[]` | `case_assessments.risk_reasoning` | available |
| incident `status` | derived (`case_status` view) | n/a |
| *(none)* verdict, band, confidence, coverage, ATT&CK, containment, planner, missing evidence | `case_assessments.*`, `attack_mappings*`, `planner_candidates`, `missing_evidence` | **Needed** |
| counterfactual result | not persisted (optional `counterfactual_runs`) | shape differs from contract: **Needed** |

### 1.3 Later features
Report generator → `reports`, `report_claims`, `report_claim_citations`. Decision handler → `analyst_decisions`. Investigation → `investigation_queries`, `investigation_query_events`, new `case_assessments` revision. Adversarial harness → `adversarial_runs`, `adversarial_pipeline_results`, `adversarial_trials`.

## 2. PostgreSQL → frontend API responses

All reads run as `soc_api`. `schema_version` / `request_id` come from the FastAPI envelope (BIR §2.1), not the database.

| Endpoint / type | Source |
|---|---|
| `GET /api/cases` → `CaseSummary[]` | `SELECT * FROM soc.case_current ORDER BY risk_value DESC` → `case_id, dataset_id, title, status, verdict, risk_score{value=risk_value, band=risk_band, reasoning=risk_reasoning}, severity, primary_entities, event_count, first_seen, last_seen` |
| `GET /api/cases/{id}` → `CaseDetail.summary`, `verdict_rationale`, `confidence`, `coverage`, `containment`, `graph` | `soc.case_current` row for the case (`confidence{level, rationale}`, `coverage{ratio, present, missing}`, containment columns → object or `null`, `graph` jsonb) |
| `…events[]` → `SourceEvent[]` | `SELECT * FROM soc.case_event_view WHERE case_id=:id ORDER BY timestamp, source_file, line_number, event_id` (`raw_hash` already aliased from `raw_sha256`) |
| `…findings[]` | `findings` for the latest `assessment_id` + `array_agg(event_id ORDER BY ordinal)` from `finding_events` → `event_ids` |
| `…missing_evidence[]`, `attack_mappings[]` | `missing_evidence`; `attack_mappings` + `attack_mapping_events` for the latest assessment |
| `…timeline[]` | derived from `events` (`event_id, timestamp, event_type`); contract open item 2 |
| `…planner` | `{budget_total: investigation_budget_total, budget_remaining, candidates: planner_candidate_state for latest assessment}` |
| `…decisions[]` | `analyst_decisions WHERE case_id=:id ORDER BY seq` (oldest first) |
| `GET …/report` → `ReportResponse` | newest `reports` row for the case (`ORDER BY created_at DESC, report_id DESC LIMIT 1`) + `report_claims ORDER BY ordinal` + citations → `citations[]` (`cited_event_id`); `citation_check{total, verified, rejected}` from `reports.citation_*`; `missing_information` array |
| `POST …/decision` → `DecisionResponse` | the inserted row + `case_status` from `soc.case_status` |
| `POST …/investigate` → `InvestigateResponse` | see §4; `retrieved_events` from `investigation_query_events` join `case_event_view`; `updated_case` = `CaseDetail` of `after_assessment_id`; `previous{verdict, risk_score, confidence}` from `before_assessment_id`; `budget_remaining` = `budget_remaining_after` |
| `POST …/counterfactual` | no database write (unless the optional audit is applied); `original` = the stored latest assessment's outcome, unchanged |
| `POST /api/upload` → `UploadResponse` | `dataset_id, filename, file_sha256, counts, validation_errors (quarantined_records), cases[]` |
| `POST /api/adversarial/run` → `AdversarialResponse` | the harness result as returned (persisted for audit); `adversarial_run_summary` for recomputed counts |

Reading a case at a **specific historical revision** (for reports/decisions audit): filter `case_assessments` by `revision`, `case_event_view` by `added_in_revision <= :rev`.

## 3. Proposed SQLAlchemy / repository structure (to be created during integration)

```
backend/app/db/
  settings.py        # reads DATABASE_URL from env; pool sizes; never logs credentials
  engine.py          # create_engine(...), SessionFactory (sync is fine; async optional)
  models.py          # SQLAlchemy 2.x Mapped[] classes mapping the EXISTING tables (autoload not required; no create_all, no Base.metadata.create_all anywhere)
  errors.py          # maps SQLSTATE -> API error codes (MEMBER1_HANDOFF.md §C)
  unit_of_work.py    # one session + one transaction per request; commit/rollback; sets role-level timeouts are already on the role
  mappers.py         # row/model -> contract dicts (CaseSummary, CaseDetail, ReportResponse, ...) and backend result -> insert rows
  repositories/
    datasets.py      # find_by_sha256, create_dataset_with_first_upload, record_duplicate_upload
    events.py        # bulk_insert_events (raw_text/raw_sha256 verified client-side first), get_events_for_case
    cases.py         # create_case(+rev1 +case_events), list_current(), get_current(), get_at_revision()
    assessments.py   # insert_revision(...), children (findings, finding_events, attack, missing, planner)
    reports.py       # insert_report(+claims+citations), latest_for_case()
    decisions.py     # insert_decision(), list_for_case()
    investigation.py # begin(), record(), budget()  (calls the SQL functions; owns the protocol of §4)
    adversarial.py   # insert_run(+results+trials)
```
Rules: repositories take a `Session` and never commit; the unit of work commits once per request. Models mirror column names exactly; id derivation uses a single shared module (`ids.py`) tested against `database/tests/vectors.json`. Pydantic response models stay in the API layer. Tests: repository tests run against a disposable PostgreSQL started the same way as `database/tests/run_tests.py` (no SQLite).

## 4. Transaction and connection strategy

**Connections.** FastAPI connects as `soc_api` (never `postgres`/`service_role`). Use the **session-mode pooler** or the direct connection for a long-running service; the transaction pooler (6543) needs prepared statements disabled. Pool size well below the role's connection limit (20): e.g. `pool_size=5, max_overflow=5, pool_pre_ping=True, pool_recycle=1800`. TLS required (`sslmode=require`). Role-level timeouts already apply: `statement_timeout 30s`, `lock_timeout 10s`, `idle_in_transaction_session_timeout 60s`. The application should also set its own per-request deadline slightly below 30 s.

**Per-request transaction.** One transaction per request, default `READ COMMITTED`. Uploads: single transaction inserting dataset + first upload + events + quarantine + cases + revision 1 + case_events + findings + citations (deferred constraints verify completeness at commit; large batches use `executemany`/COPY-style bulk insert). Re-upload of identical bytes: look up by `file_sha256`, insert a `dataset_uploads` row (`was_duplicate = true`) and return the stored cases; do **not** re-ingest.

**Investigation (one transaction):**
```
BEGIN
  SELECT * FROM soc.begin_investigation_query(:case, :key, :request_hash);   -- 'replay' | 'proceed' (or SC001/SC002/SC404)
  -- replay  -> read stored result (query, retrieved events, before/after assessments), COMMIT, return it
  -- proceed -> retrieve existing events (SELECT), compute reassessment in Python
  --            if changed: INSERT case_assessments(revision = n+1) + children + case_events(added_in_assessment_id = new)
  SELECT soc.record_investigation_query(:case, :key, :tool, :params::jsonb, :request_hash, :reason, :before, :after, :retrieved_event_ids::jsonb, :request_id);
COMMIT
```
* **Concurrency:** the advisory lock serializes per case; constraints are the backstop.
* **Idempotency:** always send the client's `idempotency_key` unchanged on retries; the same key + same `request_hash` returns the stored result without charge; a different `request_hash` is `SC002`.
* **Failures:** any exception → `ROLLBACK`; nothing is stored and nothing is charged.
* **Timeouts / retries:** `55P03` (lock), `57014` (statement), `40001`/`40P01` → return 503 and let the caller retry with the **same** key; at most 2 server-side retries with jittered backoff.
* **Stale read:** `SC003` means the case changed between read and record: re-read and retry once.

**Reports / decisions:** single-statement-group transactions; reports insert `reports` + claims + citations together (a verified claim with unresolved citations fails the commit: treat as a backend bug).

## 5. Backend dependencies and unresolved contract mismatches

| # | Item | Status |
|---|---|---|
| 1 | Backend must supply `raw_text`, `line_number`, `raw_sha256`, dataset-scoped `event_id` | **not implemented**; all event ids change (B3) |
| 2 | Backend must compute `file_sha256`, `dataset_id` and reuse datasets on identical bytes | not implemented (B2/Q2) |
| 3 | Cluster anchor + `case_id` | not implemented (B2) |
| 4 | Finding `stance`, signed `weight` | not implemented (B4) |
| 5 | Verdict, risk band, confidence, coverage, ATT&CK, containment, planner, missing evidence | not implemented (B5) |
| 6 | Report generator + citation verification | not implemented (B6) |
| 7 | Decision semantics (repeats, note) | unconfirmed (B7) |
| 8 | Investigation `params` keys, charging rule, candidate regeneration | unconfirmed (B8) |
| 9 | Adversarial semantics | unconfirmed (B9) |
| 10 | Error envelope with `schema_version`/`request_id` | not implemented (BIR §2.1) |
| 11 | Counterfactual response shape differs from the contract (`original/hypothetical/comparison` vs `original/recomputed/added/removed/changed`) and is file-based, not case-based | mismatch |
| 12 | `POST /api/upload`, `GET /api/cases`, `GET /api/cases/{id}`, report, decision, investigate, adversarial endpoints | missing (INTEGRATION_STATUS §1) |
| 13 | JSON `raw_text` exactness; CSV multi-line records | open (B10/B11) |
| 14 | Frontend contract tests/samples (`realBackendSamples.ts`, `realBackendContract.test.ts`) assert today's backend and old ids | will need re-capture |
| 15 | Postgres-only tests; SQLite fallback removed | to confirm with Member 1 (B1) |

## 6. Step-by-step integration order (once Member 1 finishes)

0. **Prerequisites:** Member 1's functions return the shapes in `MEMBER1_HANDOFF.md`; her unit tests reproduce `vectors.json`; run `python database/tests/run_tests.py` on **PostgreSQL 17**.
1. **Apply migrations to Supabase** (README §2-3): CLI `db push`, set `soc_api` / `soc_readonly` passwords, verify the checks, confirm `soc` is not an exposed schema, check `postgres` has `BYPASSRLS`.
2. **Connect FastAPI** to `soc_api` (environment variable only); add `backend/app/db/` skeleton (settings, engine, unit of work, errors); health check that runs `SELECT 1` and `SELECT count(*) FROM soc.datasets`.
3. **Ingestion path (P0):** implement `datasets`, `dataset_uploads`, `events`, `cases` repositories; `POST /api/upload` end to end including dedupe by SHA-256 and the quarantine table. Verify: re-upload returns the same dataset and cases; upload history shows both uploads.
4. **Read path (P0):** `GET /api/cases`, `GET /api/cases/{id}` from `case_current`, `case_event_view`, findings. Run the frontend with `VITE_USE_MOCKS` unset; replace `realBackendSamples.ts` captures; flip `realBackendContract.test.ts` expectations; verify Command Center and Evidence Room against real data.
5. **Decisions (P1):** `POST …/decision`; verify status in `GET /cases` and the Report/Evidence Room decision panels.
6. **Reports (P1):** store and serve reports; verify citation navigation and the PDF/CSV exports with `data_source: live` (no watermark).
7. **Counterfactual (P1):** case-based endpoint reading stored events; confirm the stored case is byte-identical before/after (GET twice). Decide on the optional audit table.
8. **Investigation (P1):** implement the §4 transaction; verify idempotent retries, the 4th-query `INVESTIGATION_BUDGET_EXHAUSTED`, and concurrent clicks from two browser tabs.
9. **Red team (P2):** persist runs; verify partial results and the 1-10 trial limit end to end.
10. **End-to-end journeys A-E** on the frontend against the real stack; fix contract mismatches on the integration branch only.
11. **Hardening:** remove any mock fallback in live mode, review logs for credential leakage, run a restore test of the database, load test the upload path, record the final `INTEGRATION_STATUS.md`.

Each step ends with: tests green, an `INTEGRATION_STATUS.md` update stating what was actually exercised against the real backend.
