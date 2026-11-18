# SOC Sentinel: Frontend ↔ Backend Integration Status

_Audit date: 2026-11-19. Frontend: branch `feat/frontend-experience`. Backend audited read-only from `origin/backend-dev` @ `d74a66c` (one commit past `main`), run in an isolated virtualenv (58 backend tests pass)._

**Headline:** the frontend is built against the agreed 8-endpoint contract and has been exercised **only against the in-app mock**. The real backend currently implements **2 of the 8 operations, in different shapes**, with no persistence. No frontend screen has been verified against a real backend response for the agreed contract.

## 1. Backend reality (actual responses observed)

| Agreed operation | Backend today | Status |
|---|---|---|
| `POST /api/upload` | **Missing.** `POST /api/analyze` exists (multipart `file`). | Mismatch |
| `GET /api/cases` | **Missing** (404). No persistence. | Missing |
| `GET /api/cases/{id}` | **Missing** (404). | Missing |
| `GET /api/cases/{id}/report` | **Missing.** No report/LLM code. | Missing |
| `POST /api/cases/{id}/counterfactual` | **Different.** `POST /api/counterfactual` is **stateless**: re-uploads the file plus `event_ids_to_exclude` (JSON list) and `reason` as multipart. Real recomputation works. | Mismatch (works) |
| `POST /api/cases/{id}/investigate` | **Missing.** No planner. | Missing |
| `POST /api/adversarial/run` | **Missing.** | Missing |
| `POST /api/cases/{id}/decision` | **Missing.** | Missing |

### What `/api/analyze` really returns
`{status, dataset, summary{total_records, valid_events, quarantined_records, alerts_generated, incidents_created}, alerts[], incidents[], quarantined_records[{row_number, reason}]}`
- `alerts[]`: `{alert_id, rule_id, title, severity, description, event_ids[], evidence{…}}`
- `incidents[]`: `{incident_id, correlation_key, alert_ids[], event_ids[], alert_count, risk_score, severity, risk_reasoning[], status}`
- Event IDs are deterministic (`evt_<16 hex>`) ✔.

### Gaps against what the UI needs (blockers for Member 1)
1. **No source events are returned.** Only event IDs. The Evidence Room needs `SourceEvent` (timestamp, user, IP, host, outcome, `source_file`, `line_number`, `raw_text`, `raw_hash`). Without it there is no raw-log provenance, graph or replay.
2. **No `schema_version` / `request_id`** on any response; **no error envelope**: errors are FastAPI `{"detail": "…"}` (404/400). The client's `schema_mismatch` check would reject every real response.
3. **No persistence / case identity.** Cases, datasets and decisions cannot be listed or revisited. `incident_id` is derived from the alert set, so it **changes** when evidence is excluded (counterfactual returns the same `correlation_key` as `removed` + `added`).
4. **No verdict, confidence, coverage, missing-telemetry, ATT&CK, containment, planner state, graph** fields. `risk_score` can reach 100 (heuristic) but there is no `risk band`.
5. **No `stance`**: contradicting evidence is not modelled.
6. **Counterfactual is file-based**, not case-based; it supports multiple excluded IDs (the contract currently says single).
7. CORS is not configured (fine behind the Vite `/api` proxy; needed for a deployed split origin).
8. `README.md` is a single line; `requirements.txt` is UTF-16 (breaks `pip install -r` on some tools).

### Compatibility fixtures captured
Real `/api/analyze` and `/api/counterfactual` responses from the demo CSV (8 rows: 6 failures + success + 1 other login) were recorded for contract tests. See `frontend/src/api/realBackendSamples.ts`.

## 2. Frontend inventory

**Legend:** ✅ implemented and verified · 🟡 implemented, incomplete or unverified · 🧪 mock-only · ❌ not implemented

| Area | State | Notes |
|---|---|---|
| Landing page (3D hero, scroll dissolve, fallback, reduced motion) | ✅ | Approved. Software-WebGL verified only; no real-GPU check. |
| Landing → app transition | ✅🟡 | 22 scripted browser checks. Smoothness on a GPU unverified. |
| App shell, rail, context bar, page transitions | ✅ | |
| Design tokens and primitives | ✅ | |
| Typed API client, errors, schema check, idempotency key, mock isolation | ✅ 🧪 | 8 operations typed; **never run against the real backend**. |
| Command Center (upload, Case Field, queue) | ✅ 🧪 | Real UI; data from mocks only. |
| Evidence Room: graph, list, inspector, replay, focus, provenance | 🟡 🧪 | Functional and tested (mocked renderer); **visual composition predates the redesign** (nested panels, small labels). Browser-verified earlier only at one width. |
| Report page + citation navigation | ✅ 🧪 | Milestone B. Browser-verified against the mock only. |
| Analyst decision + audit history | ✅ 🧪 | Milestone B. Report page + Evidence Room "Decision" tab. Mock only (the mock keeps decisions in page memory, so a full reload resets them). |
| Counterfactual Lab | ✅ 🧪 | Milestone C. Branch composition, validation, changed/unchanged verdicts, failures, integrity re-check. **Mock only.** No adapter to the real stateless `/api/counterfactual` by decision: waits for stable cases and events. |
| Investigation Lab (planner) | ❌ | `Placeholder`. Client + mock exist. |
| Red Team Lab | ❌ | `Placeholder`. Client + mock exist. |
| End-to-end journeys A–E | ❌ | Journey A partial (upload → queue → evidence), mock only. |
| Real-backend integration | ❌ | See §1. Blocked on Member 1 (events, envelope, cases, persistence). |
| Demo datasets and walkthrough | ❌ | Demo CSV drafted (see below). |
| Accessibility | 🟡 | Semantics and reduced motion present; no systematic audit. |
| Performance | 🟡 | Bundle sizes known (Landing ≈ 940 kB lazy, app ≈ 810 kB); no profiling. |
| Tests | ✅ | 125 passing at start of this phase. |

## 3. Completion estimate (Member 2 scope, honest)
- **Overall: ≈ 60% after Milestone C (frontend complete for Counterfactual, mock-tested only).** Foundation, landing, shell, Command Center and the Evidence Room core exist; four product screens, the decision/report flows, journeys and demo are not built.
- **Real-backend integration: 0%.** No agreed endpoint has been exercised successfully against the real backend. This number only moves when one has.

## 4. Working agreement for this phase
- Build the remaining screens against the agreed contract and mocks; **label every result as a development fixture** when mocks are on.
- Do not adapt the UI to the interim `/api/analyze` shape: it lacks events and would hide the gap. Instead Member 1 closes the gaps in §1.
- Never claim integration until the endpoint has been exercised against the real backend.

## 5. Requests to Member 1 (ordered by unblock value)
1. Persist upload results and add `POST /api/upload`, `GET /api/cases`, `GET /api/cases/{id}` returning `SourceEvent[]` (see `frontend/src/api/types.ts`), with `schema_version`, `request_id` and the error envelope.
2. Move counterfactual to `POST /api/cases/{id}/counterfactual` (reuse the existing `run_counterfactual`), keep the case unmodified, return before/after outcome with finding diffs keyed by stable IDs.
3. Add `GET …/report` (validated citations; deterministic fallback) and `POST …/decision` (`analyst_id`, optional note; dry-run only; return the audit record).
4. Add the planner (`investigate`, idempotency key, budget 3) and `adversarial/run` (trials ≤ 10).
5. Confirm open contract items 1–12 in `API_CONTRACT.md`.

## 6. Scheduled frontend backlog: exports (Phase 6, deferred by decision on 2026-11-19)

Not started. To be done with the reporting / Evidence Room refinement work (Milestone F), not during Milestone C.

| Export | Notes |
|---|---|
| Downloadable forensic investigation PDF | Mirrors the report page: summary, verdict (separate risk/confidence/coverage), evidence with citations, missing telemetry, ATT&CK, chronology with source-file:line provenance, containment with the dry-run statement, decision audit. |
| Evidence and findings CSV | One CSV for events (with provenance and `raw_hash`) and one for findings. **Must neutralise CSV formula injection** (any cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed/escaped; all fields quoted) because log content is untrusted. |
| High-resolution Evidence Constellation PNG | Rendered from the same normalized graph (observed/inferred/missing visibly distinct). SVG optional; if produced, all text must be escaped (no markup or scripts from log content). |
| Future combined ZIP case package | `manifest.json` (case id, dataset id, `exported_at`, `data_source`, file list) plus SHA-256 checksums of every file. |

Cross-cutting requirements for every export:
- Preserve source provenance (event id, `source_file`, `line_number`, `raw_hash`).
- State the data source explicitly: **mock exports are watermarked "DEVELOPMENT FIXTURE" and carry `data_source: "mock"` in the manifest**; live exports carry `data_source: "live"`.
- Treat all log-derived text as untrusted (escaping, safe filenames, no formula/markup injection).
- Never present a recomputed counterfactual as the stored case outcome.
