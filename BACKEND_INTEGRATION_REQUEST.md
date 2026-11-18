# Backend Integration Request: Frontend (Member 2) → Backend (Member 1)

_Prepared 2026-11-19. Sources: `API_CONTRACT.md`, `INTEGRATION_STATUS.md`, `frontend/src/api/types.ts` (the exact shapes the UI consumes), real responses recorded in `frontend/src/api/realBackendSamples.ts`, and the backend code on `origin/backend-dev` @ `d74a66c` (read-only)._

**Everything in the JSON examples below is illustrative.** Values are made up to show shape; none are measured results. The authoritative field list is `frontend/src/api/types.ts`.

---

## 0. Summary

The frontend is feature-complete for the shared case model against an in-app mock. On the real backend, **2 of the 8 agreed operations exist** (`/api/analyze`, and a stateless `/api/counterfactual`), in different shapes, with no persistence. The frontend cannot show a single real case today because responses contain event **IDs only**, no cases, no envelope.

Almost every screen depends on the same three foundations, so they come first:

1. **A shared case/event model** (cases, `SourceEvent[]` with provenance, findings, verdict/risk/confidence/coverage).
2. **Persistence** (so a case can be listed, reopened, decided on and referenced by reports).
3. **The API envelope** (`schema_version`, `request_id`, error envelope).

Then the case-scoped operations (counterfactual, report, decision), then the planner and adversarial harness.

### Priority table

| Pri | Item | Unblocks |
|---|---|---|
| **P0** | Envelope: `schema_version` + `request_id` on every response; error envelope; 422 wrapping | Every screen (the client currently rejects all real responses) |
| **P0** | Persistence of datasets, events, findings, cases (SQLAlchemy; SQLite acceptable) | Case queue, reopen, refresh, decisions, reports |
| **P0** | `POST /api/upload` (replaces `/api/analyze` for the UI) returning dataset summary + `CaseSummary[]` | Journey A start |
| **P0** | `GET /api/cases`, `GET /api/cases/{id}` returning the full `CaseDetail` incl. **`SourceEvent[]`** | Command Center, Evidence Room, graph, replay, provenance |
| **P0** | Stable, deterministic IDs (event, finding, case) | Citations, deep links, counterfactual diffs |
| **P1** | `POST /api/cases/{id}/counterfactual` (case-based, `exclude_event`) | Counterfactual Lab |
| **P1** | `GET /api/cases/{id}/report` (stored, citation-verified, deterministic fallback) | Report, citation navigation |
| **P1** | `POST /api/cases/{id}/decision` (dry run, audit trail) | Analyst decision + audit history |
| **P2** | `POST /api/cases/{id}/investigate` (planner, budget 3, idempotency) | Investigation Lab |
| **P2** | `POST /api/adversarial/run` | Red Team Lab |
| **P2** | CORS config, README, UTF-8 `requirements.txt` | Deployed demo, onboarding |

---

## 1. Actual mismatches found in the audit

Observed by running `origin/backend-dev` and recording responses.

| # | Agreed | Actual | Impact |
|---|---|---|---|
| 1 | `POST /api/upload` → `{dataset_id, filename, file_sha256, counts{total_records,valid_events,quarantined_records}, validation_errors[], cases[]}` | `POST /api/analyze` → `{status, dataset, summary{total_records, valid_events, quarantined_records, alerts_generated, incidents_created}, alerts[], incidents[], quarantined_records[]}` | Renames + a `cases[]` model needed; no dataset id/hash |
| 2 | `GET /api/cases`, `GET /api/cases/{id}` | 404 | No case concept persists |
| 3 | Events returned (`SourceEvent[]`) | Only `event_ids[]` on alerts/incidents | No provenance, graph, replay, raw log |
| 4 | `schema_version`, `request_id` on every response | Absent | Client's schema check rejects every response |
| 5 | Error envelope `{schema_version, request_id, error{code,message,details?}}` | FastAPI default `{"detail": "…"}` (400/404/413; validation errors are 422 `detail` arrays) | UI shows a generic message and loses the useful text |
| 6 | `POST /api/cases/{id}/counterfactual` with `{overrides:[{type:"exclude_event",event_id,reason}]}` | `POST /api/counterfactual` multipart: `file`, `event_ids_to_exclude` (JSON list), `reason`; **re-uploads the file** | Not case-based; works, but unusable without cases |
| 7 | Counterfactual diff by stable finding ID | `incident_id` is derived from the alert set, so it **changes** when evidence is excluded (same `correlation_key` appears as one `removed` and one `added`) | Diffs must key on finding/alert IDs and `correlation_key` |
| 8 | Verdict, confidence, coverage, missing telemetry, ATT&CK, containment, planner, graph | Not present. Only `risk_score` (can reach 100), `severity`, `risk_reasoning[]` | Core investigation fields missing |
| 9 | `stance` on findings (supporting/contradicting) | Not modelled | "What contradicts the conclusion?" cannot be answered |
| 10 | Risk **band** (`low|investigate|high`) | Not present | UI never derives bands itself |
| 11 | `report`, `investigate`, `adversarial/run`, `decision` | 404 | |
| 12 | Repo hygiene | `README.md` is one line; `requirements.txt` is UTF-16; no CORS | |

What already matches and should be kept: deterministic event IDs (`evt_<16 hex>`), deterministic `alert_id`/`incident_id` generation, real recomputation in `run_counterfactual`, `original_data_modified: false`.

---

## 2. P0: shared model, persistence, envelope

### 2.1 Envelope (every JSON response, success and error)

Success: the payload plus
```json
{ "schema_version": "1.0", "request_id": "req_8f3a1c" }
```
Error (all non-2xx, including FastAPI 422 validation errors, wrapped in a global exception handler):
```json
{
  "schema_version": "1.0",
  "request_id": "req_8f3a1c",
  "error": { "code": "CASE_NOT_FOUND", "message": "Case case_9 was not found.", "details": { "case_id": "case_9" } }
}
```
- `code`: upper-snake, stable, machine-readable. `message`: safe to show an analyst (no stack traces, paths or secrets).
- `request_id`: unique per request; also log it server-side and return it as an `X-Request-ID` header.
- `schema_version` is a `MAJOR.MINOR` string. The UI rejects a different MAJOR. Bump MAJOR for breaking changes.

Codes the UI already handles by name: `INVESTIGATION_BUDGET_EXHAUSTED` (409). Proposed full set:

| HTTP | code | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Malformed body/field (incl. validation failures; put field errors in `details`) |
| 400 | `UNSUPPORTED_FILE_TYPE`, `EMPTY_FILE`, `INVALID_SCHEMA` | Upload whole-file failures |
| 413 | `FILE_TOO_LARGE` | > 10 MB |
| 404 | `CASE_NOT_FOUND`, `EVENT_NOT_FOUND` | Unknown id (event not in the case) |
| 400 | `UNSUPPORTED_OVERRIDE` | Any override type other than `exclude_event` |
| 409 | `INVESTIGATION_BUDGET_EXHAUSTED` | Budget is 0 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different tool/params |
| 409 | `DECISION_NOT_ALLOWED` | If repeated decisions are refused (see 6.3) |
| 422→400 | `INVALID_REQUEST` | Wrap FastAPI 422 |
| 500 | `INTERNAL_ERROR` | Anything unexpected (generic message) |

### 2.2 Persistence
Persist at upload, via SQLAlchemy (Supabase Postgres, SQLite fallback). The frontend never touches the database.

| Table | Key fields |
|---|---|
| `datasets` | `dataset_id`, `filename`, `file_sha256`, `uploaded_at`, counts |
| `events` | `event_id` (PK, deterministic), `dataset_id`, normalized fields, `source_file`, `line_number`, `raw_text`, `raw_hash` |
| `findings` | `finding_id`, `case_id`, rule, title, description, severity, `stance`, `weight`, `event_ids` |
| `cases` | `case_id`, `dataset_id`, title, status, verdict, risk (value/band/reasoning), confidence, coverage, missing evidence, ATT&CK, containment, planner budget |
| `decisions` | `decision_id`, `case_id`, decision, `analyst_id`, note, `decided_at`, `dry_run` (always true) |
| `reports` | `case_id`, `generated_by`, summary, rationale, claims, citation check, `created_at` |
| `investigation_requests` | `(case_id, idempotency_key)` unique, request hash, stored response, budget effect |

Counterfactual runs are **not** persisted and must never modify a stored case.

### 2.3 Stable IDs
- **`event_id`**: deterministic from the event's content + source (already true: `evt_<16 hex>`). Same file re-uploaded ⇒ same IDs. Must be unique within the dataset.
- **`finding_id`**: deterministic from `(rule_id, sorted event_ids)` (the existing `alert_id` already is). Used as the key for counterfactual diffs.
- **`case_id`**: must be **stable under recomputation**. Derive from `(dataset_id, correlation_key)`, **not** from the alert set (today's `incident_id` changes when evidence is removed, which breaks before/after comparison). One dataset may produce many cases; each summary carries `dataset_id`.

### 2.4 Source-log provenance (per event)
Return in `CaseDetail.events[]` for every event that appears in any finding, graph node, citation or timeline:

```json
{
  "event_id": "evt_03cc0d991bd4025a",
  "timestamp": "2026-11-18T10:00:00Z",
  "event_type": "authentication_failure",
  "username": "alice",
  "source_ip": "203.0.113.45",
  "host": "server-01",
  "resource": null,
  "outcome": "failure",
  "source_file": "auth_logs.csv",
  "line_number": 2,
  "raw_text": "2026-11-18T10:00:00Z,alice,203.0.113.45,failed_login,server-01",
  "raw_hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
}
```
- `raw_text`: the **verbatim original record** (for CSV, the exact line; for JSON, the exact serialized object text). Never normalized, never trimmed. Treated as untrusted by the UI (rendered as inert text).
- `raw_hash`: SHA-256 of `raw_text` (hex). The UI displays it as provenance.
- `source_file`: original upload filename (basename). `line_number`: 1-based line in that file (state your convention for JSON arrays, e.g. 1-based element index, and keep it consistent). **(`source_file`, `line_number`) must be unique per file**: the UI orders replay by `timestamp`, then `source_file`, `line_number`, `event_id`.
- Timestamps: ISO-8601 UTC with `Z`.
- Include fields the UI should not infer (e.g. destination IP, per-event dataset) only if they are actually parsed; otherwise omit. **Never fabricate.**

### 2.5 Verdict, risk, confidence, coverage (three separate outputs)
Computed **deterministically by the backend**; the frontend never derives them.

| Output | Semantics |
|---|---|
| `verdict` | `likely_malicious \| needs_investigation \| likely_benign \| insufficient_evidence`. A function of findings and risk, stated in `verdict_rationale` (a string distinct from `confidence.rationale`). |
| `risk_score` | `{ value: 0-100, band: "low"\|"investigate"\|"high", reasoning: string[] }`. **A heuristic, not a probability.** Return the **band** (and tell us the thresholds) so the UI never invents them. |
| `confidence` | `{ level: "low"\|"medium"\|"high", rationale }`. How much the evidence supports the verdict (e.g. number of independent rules, presence of contradicting evidence). Independent of risk. |
| `coverage` | `{ ratio: 0-1, present: string[], missing: string[] }`. Share of **expected telemetry sources** present in the dataset. Independent of both of the above. |

An LLM must never set any of these.

### 2.6 Findings and stance
`findings[]` replaces `alerts[]` in the case. Add `stance`: `"supporting"` or `"contradicting"`. `weight` is the **signed** contribution to the risk score (contradicting ⇒ negative). `event_ids` must be non-empty and every id must exist in `events[]`.

```json
{
  "finding_id": "alert_3ffbc02a82637cc5",
  "rule_id": "DET-001",
  "title": "Possible Brute-Force Attack",
  "description": "5 failed login attempts were detected from 203.0.113.45 against user alice within 10 minutes.",
  "severity": "high",
  "stance": "supporting",
  "weight": 25,
  "event_ids": ["evt_03cc0d991bd4025a", "evt_733b2f3931f7fbe2"]
}
```
If no contradicting-evidence rules exist yet, return an empty set of `contradicting` findings: the UI states "none recorded" rather than guessing.

### 2.7 ATT&CK mappings
A static table from `rule_id` to technique, with the event IDs that justify it (a subset of that finding's events). Only observed events: never map from inference.
```json
{ "technique_id": "T1110", "name": "Brute Force", "tactic": "Credential Access", "event_ids": ["evt_03cc0d991bd4025a"] }
```

### 2.8 Missing telemetry
`missing_evidence[]`: `{ missing_id, telemetry, why_it_matters }` for expected sources absent from the dataset (e.g. "VPN gateway logs"). `coverage.missing` should list the same names.

### 2.9 Graph (optional for v1)
The UI derives observed relationships from event fields itself (event→user/ip/host and finding→event), so **`graph` may be an empty `{nodes:[],edges:[]}`**. Populate it only for non-observed items: `state: "inferred"` (hypotheses, with the events that motivated them) and `state: "missing"` (absent telemetry links). Node/edge ids must be stable across reruns.

---

## 3. P0 endpoints

### 3.1 `POST /api/upload` (multipart `file`)
Runs ingest → normalize → detect → correlate → persist → create cases. 10 MB limit, `.csv`/`.json`. Keep `/api/analyze` for backward compatibility.

Response (illustrative):
```json
{
  "schema_version": "1.0", "request_id": "req_a1",
  "dataset_id": "ds_5f2c9a", "filename": "brute.csv", "file_sha256": "…64 hex…",
  "counts": { "total_records": 8, "valid_events": 8, "quarantined_records": 0 },
  "validation_errors": [ { "row_number": 4, "reason": "invalid timestamp" } ],
  "cases": [ { "case_id": "case_7d1e", "dataset_id": "ds_5f2c9a", "title": "Brute-force escalation against alice",
    "status": "open", "verdict": "likely_malicious",
    "risk_score": { "value": 70, "band": "high", "reasoning": ["+25 repeated failures"] },
    "severity": "critical", "primary_entities": ["alice", "203.0.113.45", "server-01"],
    "event_count": 7, "first_seen": "2026-11-18T10:00:00Z", "last_seen": "2026-11-18T10:07:00Z" } ]
}
```
Row-level problems go to `validation_errors[]` (quarantine); whole-file failures are errors (section 2.1). Zero detections ⇒ `cases: []` (not an error).

### 3.2 `GET /api/cases` → `{ ..., "cases": CaseSummary[] }`
All persisted cases (a full list is fine for the demo; add pagination later).

### 3.3 `GET /api/cases/{case_id}` → `CaseDetail`
```json
{
  "schema_version": "1.0", "request_id": "req_b2",
  "summary": { "...CaseSummary..." },
  "verdict_rationale": "Three independent rules fired on one IP within 7 minutes; no benign context is available.",
  "confidence": { "level": "medium", "rationale": "Three independent rules agree; no IP reputation or VPN context." },
  "coverage": { "ratio": 0.5, "present": ["authentication logs", "web server logs"], "missing": ["VPN gateway logs", "endpoint telemetry"] },
  "findings": [ "...see 2.6..." ],
  "missing_evidence": [ { "missing_id": "m_vpn", "telemetry": "VPN gateway logs", "why_it_matters": "Would show whether 203.0.113.45 is a corporate VPN egress." } ],
  "attack_mappings": [ "...see 2.7..." ],
  "graph": { "nodes": [], "edges": [] },
  "events": [ "...SourceEvent, see 2.4..." ],
  "timeline": [ { "event_id": "evt_03cc0d991bd4025a", "timestamp": "2026-11-18T10:00:00Z", "label": "authentication_failure" } ],
  "planner": { "budget_total": 3, "budget_remaining": 3, "candidates": [ "...see 5.1..." ] },
  "containment": { "action": "Block source IP at perimeter and force password reset", "target": "203.0.113.45 / alice", "rationale": "…", "dry_run": true },
  "decisions": []
}
```
`containment` is `null` when nothing is recommended. `timeline` may be omitted or derived from `events` (the UI builds chronology from `events`).

---

## 4. P1 endpoints

### 4.1 `POST /api/cases/{case_id}/counterfactual`
Reuse the existing `run_counterfactual` logic, but **case-based** (events come from storage; no file upload). It must **rerun detection, correlation and scoring** on the reduced event set and **must not mutate or persist anything**.

Request (`reason` required):
```json
{ "overrides": [ { "type": "exclude_event", "event_id": "evt_c9546fafb941c33e", "reason": "Confirmed test traffic" } ] }
```
- Only `exclude_event` is supported. Any other `type` ⇒ 400 `UNSUPPORTED_OVERRIDE`. Unknown/foreign event ⇒ 404 `EVENT_NOT_FOUND`. Excluding every event ⇒ 400 `INVALID_REQUEST`.
- Multiple `exclude_event` items in one request are welcome (the existing code supports a list); please confirm. The UI currently sends one.

Response (illustrative):
```json
{
  "schema_version": "1.0", "request_id": "req_c3", "case_id": "case_7d1e",
  "original":   { "verdict": "likely_malicious", "risk_score": { "value": 70, "band": "high", "reasoning": [] },
                  "confidence": { "level": "medium", "rationale": "…" }, "findings": [ "..." ], "graph": { "nodes": [], "edges": [] } },
  "recomputed": { "verdict": "needs_investigation", "risk_score": { "value": 45, "band": "investigate", "reasoning": [] },
                  "confidence": { "level": "low", "rationale": "…" }, "findings": [ "..." ], "graph": { "nodes": [], "edges": [] } },
  "score_delta": -25,
  "added":   [ { "finding": { "...Finding..." }, "reason": "Became visible once the excluded event no longer masked it." } ],
  "removed": [ { "finding": { "...Finding..." }, "reason": "Its supporting events included the excluded event." } ],
  "changed": [ { "before": { "...Finding..." }, "after": { "...Finding..." }, "reason": "Fewer supporting events." } ],
  "explanation": "Excluding evt_c9546… removed the success-after-failures finding, lowering the heuristic score."
}
```
- `original` is the **stored case's outcome, unchanged**; `recomputed` is the genuine rerun. If nothing changes, return the same verdict and `score_delta: 0` (a valid, non-error result).
- `recomputed` should also carry `coverage` if it can change (optional); the UI shows it when present.
- Diffs are keyed on **stable `finding_id`** (section 2.3). Do not diff on `incident_id`.
- Do **not** add `verified_corporate_vpn`, `invalidate_ioc` or `verified_maintenance` until recomputation and verification logic exist for them.

### 4.2 `GET /api/cases/{case_id}/report`
Generate **once**, validate, store, and return the stored report on later GETs (no LLM call per request). On generation failure, store and return a deterministic template report with `generated_by: "template_fallback"`.

```json
{
  "schema_version": "1.0", "request_id": "req_d4", "case_id": "case_7d1e",
  "generated_by": "llm",
  "summary": "Repeated failed logins for alice from 203.0.113.45 were followed by a successful login.",
  "verdict_rationale": "Three independent rules fired on the same IP within 7 minutes.",
  "claims": [
    { "claim_id": "c1", "text": "Five failed logins for alice occurred between 10:00 and 10:04.",
      "citations": ["evt_03cc0d991bd4025a", "evt_733b2f3931f7fbe2"], "verified": true, "verification_note": null }
  ],
  "missing_information": ["VPN gateway logs"],
  "citation_check": { "total": 1, "verified": 1, "rejected": 0 }
}
```
Citation verification (server-side, before storing): every `citations[]` id must exist in that case's `events[]`; claims whose citations are missing or unresolvable must be removed or returned with `verified: false` and a `verification_note`. Rejected counts go in `citation_check`. The report text must never contain facts that are not backed by case data, and **untrusted log content must never be able to change the verdict or add citations** (see 5.2). The verdict shown in the report is the deterministic one.

### 4.3 `POST /api/cases/{case_id}/decision`
```json
{ "decision": "approve", "analyst_id": "priyanka", "note": "Contain pending review." }
```
- `analyst_id` (free text) required (non-blank), echoed in every record. `note` optional (tell us if a reason should be mandatory for `reject`).
- **Dry run only.** There must be no code path that blocks an IP, disables an account or isolates a host. Return `dry_run: true` always.
- Append-only audit. **Please confirm repeated-decision behaviour**: proposed = allowed, each appended, `case_status` follows the latest decision. If you refuse repeats, return 409 `DECISION_NOT_ALLOWED`.

Response:
```json
{
  "schema_version": "1.0", "request_id": "req_e5",
  "record": { "decision_id": "dec_1", "case_id": "case_7d1e", "decision": "approve", "analyst_id": "priyanka",
              "note": "Contain pending review.", "decided_at": "2026-11-19T04:10:00Z", "dry_run": true },
  "case_status": "approved"
}
```
`decisions[]` on `CaseDetail` returns the full history; please return it **oldest first** (the UI also sorts by `decided_at` defensively).

---

## 5. P2 endpoints

### 5.1 `POST /api/cases/{case_id}/investigate` (bounded evidence planner)
Tools (names fixed): `get_related_auth_events`, `get_post_login_activity`, `get_ip_context`. **Retrieve events that already exist in the dataset; never fabricate evidence.** Please define `params` per tool (the UI renders them as `Record<string,string>`; e.g. `{ "username": "bob" }`, `{ "ip": "198.51.100.20" }`) and document the allowed keys.

`CaseDetail.planner.candidates[]` (the proposals, shown **before** anything is executed):
```json
{ "tool": "get_post_login_activity", "params": { "username": "bob" }, "relevance": 0.9,
  "expected_uncertainty_reduction": 0.8, "retrieval_cost": 1, "recommended": true,
  "reason": "Post-login behaviour best separates benign recovery from takeover.", "used": false }
```
Please state how `relevance`/`expected_uncertainty_reduction` are computed (or omit them if they are not real; the UI only shows what it is given).

Request: `{ "tool": "get_post_login_activity", "params": { "username": "bob" }, "idempotency_key": "9b2f…uuid" }`

- **Budget**: initial 3 per case; each *executed* query costs 1; exhausted ⇒ 409 `INVESTIGATION_BUDGET_EXHAUSTED`.
- **Idempotency**: same `idempotency_key` + same request ⇒ **return the stored response, charge no budget**. Same key + different tool/params ⇒ 409 `IDEMPOTENCY_KEY_REUSED`. Scope keys per case. Persist them (`investigation_requests`).
- A query with no results is a valid 200 with `retrieved_events: []` (it still consumes budget).

Response:
```json
{
  "schema_version": "1.0", "request_id": "req_f6", "case_id": "case_amb", "tool": "get_post_login_activity",
  "reason": "Post-login behaviour best separates benign recovery from takeover.",
  "retrieved_events": [ "...SourceEvent with full provenance..." ],
  "budget_remaining": 2,
  "updated_case": { "...CaseDetail with the new events folded in and findings/verdict recomputed..." },
  "previous": { "verdict": "insufficient_evidence", "risk_score": { "value": 25, "band": "investigate", "reasoning": [] }, "confidence": { "level": "low", "rationale": "…" } }
}
```

### 5.2 `POST /api/adversarial/run`
Request: `{ "scenario_id": "user_agent_injection" | "url_query_contamination" | "fake_analyst_authorization", "trials": 1..10 }` (`trials` > 10 ⇒ 400).

Response: scenario (`scenario_id`, `title`, `field`, `untrusted_payload`), `settings` (at least `model`, `temperature`; add whatever else is relevant), and two pipeline results, `baseline` and `hardened`, each `{ trials, injection_successes, outputs[{trial, output, injection_succeeded}], citation_check{total,verified,rejected} }`. **Return actual outputs; no derived percentages.**

Please document: how `injection_succeeded` is determined (it should be an objective check, e.g. the output adopts the injected claim or cites a non-existent event); whether the run is synchronous and its expected latency (10 trials may be slow; tell us a timeout, or make it a job with polling); and what is returned on partial failure.

---

## 6. Safeguards and non-functional requirements

1. **Dry-run containment only.** No code path performs a live action. `dry_run` is a literal `true`.
2. **Deterministic core.** Detection, correlation, risk, verdict, confidence, coverage and ATT&CK are produced by deterministic code. The LLM may only write the report narrative and must not be able to authorize actions.
3. **Untrusted content.** Raw log fields are data. Never concatenate them into an instruction position; the adversarial harness exists to prove this.
4. **No fabricated evidence** in any response.
5. **CORS:** the frontend uses a same-origin Vite proxy locally (`/api` → `127.0.0.1:8000`). For a deployed split-origin demo, allow the frontend origin explicitly.
6. **Repo hygiene:** write a real `README.md` (how to run), save `requirements.txt` as UTF-8, and expose OpenAPI at `/openapi.json` (it already is).

---

## 7. Acceptance checklist (what "done" looks like for each tier)

**P0 done when:**
- [ ] Every response has `schema_version` and `request_id`; errors use the envelope; 422 is wrapped.
- [ ] Upload creates persisted cases; `GET /api/cases` still lists them after a server restart.
- [ ] `GET /api/cases/{id}` returns `events[]` with `source_file`, `line_number`, `raw_text`, `raw_hash`, and every finding/ATT&CK/citation id exists in `events[]`.
- [ ] Re-uploading the same file yields the same `event_id`s and `case_id`s.
- [ ] Verdict, risk (with band), confidence and coverage are present and independent.

**P1 done when:** counterfactual leaves the stored case byte-identical (verify by GET before/after); report citations all resolve; a decision appears in `decisions[]` and changes `status`.

**P2 done when:** repeating an `idempotency_key` costs no budget; the 4th query returns `INVESTIGATION_BUDGET_EXHAUSTED`; adversarial `trials: 11` returns 400.

## 8. How we will verify on the frontend
- `frontend/src/api/realBackendContract.test.ts` currently asserts today's gaps. As each item lands, those expectations flip and become real contract tests.
- Switch off mocks (`VITE_USE_MOCKS` unset) and run against `uvicorn` on port 8000 via the Vite proxy; each journey (upload → case → report → counterfactual → investigate → red team → decision) is then exercised end to end.
- The frontend will not report an endpoint as integrated until it has been exercised successfully against the real backend.

## 9. Questions for Member 1 (answers change what the UI does)
1. Case ID derivation (section 2.3): OK to derive from `(dataset_id, correlation_key)`?
2. Verdict and band thresholds: what are they? (We will display them as returned.)
3. Multiple `exclude_event` overrides per request: supported? (We would like yes.)
4. Repeated decisions: allowed, and is a note required for `reject`?
5. Is `graph` going to be populated, or should the UI keep deriving observed relationships itself? (Our preference: keep deriving; populate only inferred/missing.)
6. Adversarial runs: synchronous? expected latency and timeout?
7. `line_number` convention for JSON inputs.

---

## Appendix: message to Member 1 (ready to send)

> **Subject: SOC Sentinel: the three backend pieces that unblock the whole frontend**
>
> Hi, quick status and one big ask. The frontend is built end to end against our agreed contract (Command Center, Evidence Room, report with citations, decisions, and now the Counterfactual Lab), but it's all running on a mock, because the backend doesn't yet expose the shared case model. I ran `backend-dev` (d74a66c) and recorded real responses; the 58 backend tests pass and `run_counterfactual` genuinely recomputes, which is great.
>
> **What blocks us, in order:**
> 1. **Envelope:** `schema_version` + `request_id` on every response, and the error envelope (including wrapping FastAPI's 422/`detail`). Today my client rejects every real response.
> 2. **Persistence + case model:** persist upload results and add `POST /api/upload`, `GET /api/cases`, `GET /api/cases/{id}`. Please return **`events[]` with `source_file`, `line_number`, `raw_text`, `raw_hash`**; at the moment only event IDs come back, so there is nothing to show as provenance. Please also make `case_id` stable (derive it from dataset + correlation_key), because today's `incident_id` changes when evidence is excluded.
> 3. **Verdict / confidence / coverage / band** as separate deterministic outputs, and findings with a `stance`.
>
> Then: counterfactual as `POST /api/cases/{id}/counterfactual` (reuse your function, just case-based), the stored report, and decisions (dry run). Planner and adversarial harness last.
>
> Everything is written up with schemas and example payloads in `BACKEND_INTEGRATION_REQUEST.md` (repo root), with P0/P1/P2 priorities and a checklist for each tier; the exact shapes I consume are in `frontend/src/api/types.ts`. There are seven small questions at the end whose answers I need. Happy to pair on the P0 piece. Once the envelope and `GET /api/cases/{id}` exist I can verify against the real backend the same day.
