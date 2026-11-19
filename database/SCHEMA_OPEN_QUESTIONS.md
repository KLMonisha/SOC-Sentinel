# Schema open questions (revision 2)

Status after your review. "Blocks" now means: **blocks applying the migrations to Supabase**. Nothing below blocks that; items marked **backend** block the *integration* (which you own once Member 1 finishes), and items marked **you** are decisions only you can make. Evidence is cited so each claim can be re-checked (backend = `origin/backend-dev @ d74a66c`; BIR = `BACKEND_INTEGRATION_REQUEST.md`).

## A. Resolved by your decisions

| # | Question | Resolution |
|---|---|---|
| Q1 | Immutable assessments vs current state | **Immutable `case_assessments`** (approved). Reports and decisions reference `assessment_id`. |
| Q2 | Dataset identity / re-upload | **Dedupe by file SHA-256, keep history** (approved with modification): `datasets` + `dataset_uploads`. |
| Q18 | Migration system / SQLite | **Supabase CLI SQL migrations only; Postgres only** (approved; SQLite fallback not required, Member 1 to confirm her test approach, see B1). |
| Q3 | Event id scope | Resolved: dataset-scoped derived id, composite PK, CHECK-enforced. |
| Q5 | `case_id` and several clusters per IP | Resolved by design: anchor-event identity (§3 of the design); backend must supply the anchor, see B2. |
| Q4 (schema part) | `raw_text`, hashes, line numbers | Resolved by design: `raw_sha256` of `raw_text`, legacy hash separate, line convention defined; backend must change, see B3. |
| Q15 | Persist counterfactuals? | Not in core migrations (contract says no). Optional audit file provided in `database/optional/` and tested. **You** decide whether to apply it. |
| Q21 | Multi-file datasets | Unchanged default: one file per dataset; schema tolerates more (`source_file` per event). |
| Q24 | Original timestamp text | Unchanged default: UTC `timestamptz` only; original stays in `raw_text`. |
| Q25 | Derived summary fields | Resolved: all derived in views. |

## B. Remaining: backend dependencies (needed before integration)

### B1. Test strategy and persistence layer ownership (was Q18 remainder) - **you + backend**
- **Ambiguity.** BIR says "SQLAlchemy (Supabase Postgres, SQLite fallback)". SQLite cannot represent triggers, RLS, composite-FK semantics or the budget functions.
- **Affects.** Every backend test that touches persistence; `requirements.txt` (SQLAlchemy 2.1.9 is listed but unused).
- **Default.** Backend unit tests that do not need a database stay as they are; anything touching persistence runs against a disposable PostgreSQL (the same approach as `database/tests/run_tests.py`). Integration is yours (SQLAlchemy models map to the existing tables; no `create_all`).
- **If wrong.** A SQLite test double would silently accept data the real database rejects.
- **Blocks:** integration (not migration).

### B2. Case anchor and stable id (Q5 backend half) - **backend**
- **Ambiguity.** Today `correlate_alerts` returns `incident_id` (unstable) and `correlation_key`; it returns neither an anchor event nor a cluster identity, and BIR §2.3's `(dataset_id, correlation_key)` is not unique across clusters.
- **Affects.** `cases.anchor_event_id`, `cases.case_id`; `GET /api/cases`.
- **Default.** For each cluster of the **original** dataset, the anchor is the earliest event of the cluster ordered by `(timestamp, source_file, line_number, event_id)`; `case_id = derive_case_id(dataset_id, correlation_key, anchor_event_id)`.
- **If wrong.** If clustering changes between runs on identical data, a re-upload (which resolves to the same dataset) must still reuse the stored cases, never re-derive them; otherwise duplicate cases appear. The DB rejects any id that does not match its derivation.
- **Blocks:** integration.

### B3. Original provenance from the backend (Q4 backend half) - **backend**
- **Ambiguity.** The backend produces no `raw_text`, no `line_number`; its `raw_hash` is the SHA-256 of canonical JSON of the parsed record; its `event_id` depends on that hash and on the filename; CSV `row_number` starts at 2 and is not a physical line for quoted multi-line fields; JSON uses the element index.
- **Affects.** `source_events` (CHECK-enforced), every event consumer.
- **Default.** Backend supplies `raw_text` (CSV: the exact record text; JSON: see Q26), `line_number` per the convention, `raw_sha256 = sha256(raw_text)`, and `event_id` per `derive_event_id`. Legacy hash optionally sent as `canonical_json_sha256`.
- **If wrong.** Inserts fail loudly on the first event (CHECK). **All event ids change** versus today's backend; `frontend/src/api/realBackendSamples.ts` ids go stale.
- **Blocks:** integration.

### B4. Finding stance and signed weight (Q6) - **backend**
- **Ambiguity.** Alerts have no `stance` and no weight; risk is `severity base + rule bonus + evidence bonus` per incident (`calculate_risk_score`), not a sum of finding weights; no contradicting rules exist.
- **Affects.** `findings.stance/weight` (NOT NULL; sign CHECK), UI contribution display.
- **Default.** `finding_id = alert_id`; backend emits `stance` and a signed `weight`; with no contradicting rules, only supporting findings are stored.
- **If wrong.** If weights cannot be produced, make `weight` nullable (one-line migration) and the UI must not show contribution.

### B5. Verdict, risk band, confidence, coverage, ATT&CK, containment, planner (Q7-Q9) - **backend**
- **Ambiguity.** None of these are computed today. Backend severities (≥80 critical, ≥60 high, ≥35 medium) are not the contract's band (`low|investigate|high`); verdict/confidence/coverage rules and the "expected telemetry" catalogue are undefined.
- **Affects.** `case_assessments` NOT NULL columns, `attack_mappings`, `planner_candidates`.
- **Default.** Store backend `severity` and contract `risk_band` separately; three separate columns for risk/confidence/coverage; enums CHECKed.
- **If wrong.** Enum changes are a one-line migration.

### B6. Report generation details (Q12, Q14) - **backend**
- **Ambiguity.** Regeneration policy after reassessment; whether rejected claims are removed or returned; `report_id` format (none in contract).
- **Default.** One report per assessment version, newest wins; unresolved citations stored as unresolved; `rep_<12 hex>` default, backend may supply its own.
- **If wrong.** One-report-per-case = add UNIQUE(case_id); stale reports after reassessment would otherwise be served.

### B7. Decisions semantics (Q13, Q14) - **backend**
- **Default.** Repeated decisions allowed and appended; status follows the latest; note optional; `dec_<12 hex>` default.
- **If wrong.** "One decision per case" = partial UNIQUE; "note required on reject" = CHECK. Both additive.

### B8. Investigation specifics (Q16) - **backend**
- **Ambiguity.** Allowed `params` keys per tool; whether failed queries cost budget; whether candidates are recomputed per assessment.
- **Default.** Only executed queries are charged (failures roll back); `params` object of strings with no key whitelist; candidates stored per assessment; the backend follows the begin/record protocol in one transaction and retries with the **same** idempotency key.
- **If wrong.** Charging failures = store failed rows with a `charged` flag; whitelist = CHECK.

### B9. Adversarial persistence and semantics (Q17) - **backend + you**
- **Ambiguity.** The endpoint has no GET and BIR's persistence table omits it; meaning of `trials` (requested vs completed), `injection_succeeded` criterion, per-trial citations are undefined.
- **Default.** Persist runs for audit/replay (write-only for now); reported counts and returned rows stored separately; partial runs visible; rates only from rows.
- **If wrong.** Skip migration `…400` entirely (isolated).

### B10. JSON `raw_text` exactness (new, Q26) - **backend**
- **Ambiguity.** `json.load` loses the original bytes of each element. "Exact serialized object text" cannot be recovered from a parsed array.
- **Default.** `raw_text` for JSON = compact re-serialization of the parsed element preserving key order (`json.dumps(el, ensure_ascii=False, separators=(",", ":"))`), documented as "verbatim as parsed", not byte-exact. Alternatively capture exact slices with a streaming/offset-aware parser.
- **If wrong.** Provenance claims for JSON must say "re-serialized". The hash still proves what is stored; it does not prove the bytes of the upload (the dataset-level `file_sha256` does).

### B11. CSV edge cases (new, Q27) - **backend**
- **Ambiguity.** Quoted multi-line fields, BOMs, `\r\n` handling for `raw_text`.
- **Default.** `raw_text` = the exact physical text of the record (one or more lines, no trailing newline, BOM removed because the backend reads `utf-8-sig`); `line_number` = first physical line.
- **If wrong.** Line numbers drift from the file; the unique `(dataset, file, line)` index still holds.

## C. Remaining decisions for you

### C1. Strictness of derivation CHECKs (new, Q28)
- **Ambiguity.** `dataset_id`, `event_id` and `case_id` are verified by CHECK against the derivation functions, making the database the last line of defence for stability. It also means the backend must match byte for byte.
- **Default.** Keep the CHECKs (verified Python↔PostgreSQL on 14 vectors including Unicode).
- **If wrong.** If Member 1 prefers her own id scheme, drop the three CHECKs (a small migration); stability guarantees then rest on the backend alone.

### C2. Supabase migration role and BYPASSRLS (new, Q29)
- **Ambiguity.** `FORCE ROW LEVEL SECURITY` means an owner without `BYPASSRLS` sees zero rows. Supabase's `postgres` role is expected to have `BYPASSRLS`, which I could not verify without touching your project.
- **Default.** Migrations run as `postgres` (Supabase CLI default). Verify with the query in `README.md` before relying on admin reads.
- **If wrong.** Admin tooling must connect as `soc_readonly` (read) or you add a dedicated admin policy; nothing breaks for `soc_api`.

### C3. Connection mode (Q23)
- **Default.** FastAPI uses the **session** pooler or the direct connection with role `soc_api`; if the transaction pooler is used, disable the driver's prepared-statement cache. The investigation protocol needs a real multi-statement transaction.
- **If wrong.** Runtime errors under load; no schema impact. Not testable without a live project.

### C4. Auth, retention, quarantine (Q19, Q20, Q22)
- **Defaults.** Single-tenant, no per-user policies (`analyst_id` is free text); no deletion path (all FK RESTRICT, no DELETE grant, triggers); quarantined `raw_record` stored but never returned.
- **If wrong.** Multi-tenancy needs a `tenant_id` and policy rewrite; a retention/erasure requirement needs a controlled purge function (intentionally absent); quarantine column can be dropped if you do not want to retain rejected rows.

### C5. PostgreSQL version (new)
- **Fact.** Local verification used PostgreSQL 18.6; Supabase runs 17.x. Only long-standing features are used, but the suite has not been run on 17.
- **Action.** Run `python database/tests/run_tests.py` on a 17.x server (a local install or Docker `postgres:17`) before the first production use.
