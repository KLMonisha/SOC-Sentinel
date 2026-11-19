# Handoff to Member 1: what the backend functionality must produce

**Who does what.**
* **Member 1 (you):** the backend *functionality*: ingestion, detection, correlation, scoring, planner logic, report generation, adversarial harness, and the API behaviour/shape in `API_CONTRACT.md`.
* **Database owner (Priyanka, with Claude Code):** PostgreSQL/Supabase, SQLAlchemy models, repositories, transactions, connection handling, and wiring FastAPI and the frontend together.

So you do **not** need a database connection, SQLAlchemy models, migrations, or Supabase access. You need to make your functions **return data in the shapes below**. The database enforces many of these rules with constraints, so a mismatch fails loudly on first insert instead of silently storing bad evidence. Everything here is separated into **(A) what the database requires** (fixed by the schema) and **(B) what you implement** (your code).

Source of truth for the schema: `supabase/migrations/`. Rationale: `database/SCHEMA_DESIGN.md`. Open items: `database/SCHEMA_OPEN_QUESTIONS.md`.

---

## A. Database requirements (fixed)

### A1. Deterministic identifiers: you must reproduce these exactly
All hashing is SHA-256 over UTF-8; hex is lowercase; parts are joined with the ASCII unit separator `"\x1f"` (U+001F). The database recomputes each id and **rejects a mismatch** (CHECK constraints).

```python
import hashlib
SEP = "\x1f"
def sha256_hex(text: str) -> str:            return hashlib.sha256(text.encode("utf-8")).hexdigest()
def derive_dataset_id(file_sha256: str):      return "ds_" + file_sha256[:16]
def derive_event_id(dataset_id, source_file, line_number: int, raw_sha256):
    return "evt_" + sha256_hex(SEP.join([dataset_id, source_file, str(line_number), raw_sha256]))[:16]
def derive_case_id(dataset_id, correlation_key, anchor_event_id):
    return "case_" + sha256_hex(SEP.join([dataset_id, correlation_key, anchor_event_id]))[:16]
```
* `file_sha256` = SHA-256 of the **uploaded file bytes** (not of text).
* `source_file` = the dataset's **canonical filename** (the filename of the first upload of those bytes). Re-uploading identical bytes under another name must reuse the stored dataset, events and cases (it is recorded in `dataset_uploads`, not re-ingested).
* **Reference vectors** (including Unicode) are in `database/tests/vectors.json`. Add a unit test in the backend that asserts your functions reproduce them. They are already verified against PostgreSQL.

### A2. Event provenance (every event)
| Field | Rule |
|---|---|
| `raw_text` | The **verbatim original record**. CSV: the exact text of the record (all physical lines of a quoted multi-line record, no trailing newline). JSON: compact re-serialization of the parsed element with key order preserved: `json.dumps(el, ensure_ascii=False, separators=(",", ":"))` (documented as "verbatim as parsed"; Q26). Never normalized or trimmed. Non-empty. |
| `raw_sha256` | `sha256_hex(raw_text)`. **The database verifies this.** (API field name stays `raw_hash`.) |
| `line_number` | CSV: 1-based **physical line where the record starts** (header = line 1). JSON: 1-based **element index**. Use the CSV reader's physical line counter (`reader.line_num` at the start of the record), not `enumerate(start=2)`, which is wrong for multi-line quoted fields. Unique per `(dataset, source_file)`. |
| `source_file` | Canonical filename (basename; no `/`, `\`, control chars; ≤255). **Sanitize the uploaded name** (`Path(name).name` does not remove backslashes on Linux): replace `\`, `/` and control characters before use, or the dataset insert is rejected. |
| `timestamp` | UTC (you already reject naive timestamps; keep that). |
| `username`, `source_ip`, `destination_ip`, `host`, `resource` | Nullable. Do not invent values. `source_ip` is stored as text: do not reject odd strings here. **Length limits:** the first four ≤ 4096 characters, `resource` ≤ 8192, `event_type` ≤ 256. A value beyond a limit makes the database reject the *whole upload*, so the backend must **quarantine that row** (reason up to 20000 characters) rather than insert it. Titles/descriptions built from log values (case title, finding title) must stay ≤ 20000 characters. |
| `outcome` | `success` / `failure` / `unknown`. |
| `canonical_json_sha256` | Optional. Your **current** `raw_hash` (SHA-256 of canonical JSON of the parsed record). Kept for transition cross-checks only; it is **not** the integrity hash. |

**Transition note (important):** today your `raw_hash` hashes the *parsed* record and your `event_id` is `sha256(filename:row_index:raw_hash)[:16]`. Under this schema both change (hash of the original text; dataset-scoped id). Nothing is stored yet so nothing migrates, but **every event id will differ from today's output**, and tests that hard-code old ids (including `frontend/src/api/realBackendSamples.ts`) will need updating during integration.

### A3. Case identity and clustering
* Compute clusters from the **original full dataset**. For each cluster set `anchor_event_id` = the earliest event of the cluster ordered by `(timestamp, source_file, line_number, event_id)`, and `case_id = derive_case_id(dataset_id, correlation_key, anchor_event_id)`.
* `incident_id` (`inc_…`) is **not stored** (it changes with the alert set). Do not use it as an identity.
* Counterfactual runs must **never** produce or change a case id; they recompute in memory only. After a re-upload of the same bytes, reuse the stored cases (do not re-derive different ones).
* A case must include its anchor event in its event set, and must have an initial assessment.

### A4. Assessment fields (every case, every revision)
`verdict` (`likely_malicious|needs_investigation|likely_benign|insufficient_evidence`), `verdict_rationale`, `severity` (`low|medium|high|critical`), `risk_value` 0-100 **and** `risk_band` (`low|investigate|high`), `risk_reasoning[]`, `confidence_level` (`low|medium|high`) + `confidence_rationale`, `coverage_ratio` 0..1 + `coverage_present[]` + `coverage_missing[]`, `primary_entities[]`; optional containment (`action`, `target`, `rationale`, always a dry run). **Risk, confidence and coverage are three independent outputs**; none may be set by an LLM.

### A5. Findings
* `finding_id` (your current `alert_id` is fine), `rule_id`, `title`, `description`, `severity`.
* **`stance`** (`supporting` | `contradicting`) and a **signed numeric `weight`** (supporting ≥ 0, contradicting ≤ 0). Both are required; today's alerts have neither.
* **At least one cited event id**, and every cited id must be an event that is in the case (otherwise the insert is rejected).
* ATT&CK mappings: technique id `T####` or `T####.###`, with the **observed** events that justify it. Missing evidence: stable `missing_id`, `telemetry`, `why_it_matters`.

### A6. Reports
* One report describes one assessment version. `generated_by`: `llm` or `template_fallback` (a fallback must include a reason).
* Each claim: text, `verified`, optional `verification_note`, `citations[]` (event ids). **Never mark a claim `verified` unless it has ≥ 1 citation and every citation is a real event of the case.** Citations that do not resolve may still be returned (flagged `verified: false`); the database keeps them as unresolved and refuses to let them support a verified claim.
* Report the backend's citation counts (`total`, `verified`, `rejected`); `verified + rejected` must equal `total`.

### A7. Decisions, investigation, red team
* Decision: `approve|reject`, non-blank `analyst_id`, optional note. Always dry run. Repeats are allowed.
* Investigation: tools `get_related_auth_events`, `get_post_login_activity`, `get_ip_context`; `params` is an object of **string** values; `idempotency_key` is 8-128 chars `[A-Za-z0-9._:-]`; budget 3 per case. A new reassessment must be returned as a new assessment (never edit an old one). The request fingerprint (`request_hash`) is `sha256_hex` of canonical JSON of `{tool, params}` (sorted keys, compact); define it once in the backend and use it consistently, because the same key with a different hash is refused.
* Red team: scenarios `user_agent_injection`, `url_query_contamination`, `fake_analyst_authorization`; 1-10 trials; return only trials that actually ran (a missing trial is simply absent).

---

## B. Backend implementation responsibilities (yours)

| # | Task | Why the database needs it |
|---|---|---|
| B1 | Produce `raw_text`, correct `line_number`, `raw_sha256`, dataset-scoped `event_id` (A1, A2) | CHECK constraints; provenance |
| B2 | Compute `file_sha256` from raw bytes; derive `dataset_id`; reuse existing dataset on identical bytes | dataset dedupe (Q2) |
| B3 | Pick the cluster **anchor** and derive `case_id` from the original dataset (A3) | stable case identity |
| B4 | Emit `stance` and signed `weight` on findings; ≥ 1 citation each (A5) | NOT NULL + triggers |
| B5 | Compute verdict, risk (value **and** band), confidence, coverage, ATT&CK, containment, planner candidates (A4) | NOT NULL assessment columns |
| B6 | Make report citation verification honest (A6) | `verified` claims are constrained |
| B7 | Return **structured data** from services (dicts/dataclasses with the fields above). Do not write SQL, models or connections | persistence is owned by the DB owner |
| B8 | Keep detection/counterfactual functions **pure** (no global state, no file/DB access), so the persistence layer can call them inside a transaction | testability, transactions |
| B9 | Keep the error codes in `BACKEND_INTEGRATION_REQUEST.md` §2.1 | the persistence layer maps database errors to them (see below) |

**Please do NOT:** call `Base.metadata.create_all`, add competing table definitions or migrations, add a SQLite fallback, store secrets in code, or enable any code path that performs a real containment action.

## C. For information: how database errors will map to API errors (done by the integrator)
| SQLSTATE | Meaning | API |
|---|---|---|
| `SC001` | investigation budget exhausted | 409 `INVESTIGATION_BUDGET_EXHAUSTED` |
| `SC002` | idempotency key reused with a different request | 409 `IDEMPOTENCY_KEY_REUSED` |
| `SC003` | stale/foreign assessment (retry after re-reading) | 409 (retryable) |
| `SC404` | unknown case | 404 `CASE_NOT_FOUND` |
| `SC210` | revision out of sequence | 409 (retryable) |
| `SC220`/`SC221`/`SC230`/`SC231` | evidence/citation integrity violation | 500 (a backend bug: data it produced is inconsistent) |
| `23505`/`23503`/`23514`/`23502` | unique / foreign key / check / not-null violation | 500 unless the request caused it (then 400/409) |
| `55P03`, `57014`, `40001`, `40P01` | lock timeout, statement timeout, serialization/deadlock | 503, retry with the **same** idempotency key |

## D. How to check your outputs without a database
Unit-test the derivations against `database/tests/vectors.json`; assert on each event that `raw_sha256 == sha256_hex(raw_text)` and `event_id == derive_event_id(...)`; assert every finding has `stance`, a correctly signed `weight`, and ≥ 1 cited id that exists in the case's events. When the integrator runs the real pipeline, any violation is reported with the offending constraint name.

## E. Open items needing your answer (details in `SCHEMA_OPEN_QUESTIONS.md`)
B2 anchor/case id; B3 provenance and the id transition; B4 stance/weight; B5 band thresholds and confidence/coverage rules; B6 report regeneration; B7 repeated decisions; B8 investigation params/charging; B9 adversarial semantics; B10 JSON `raw_text` exactness; B11 CSV edge cases; and your test approach now that SQLite is not required (B1).
