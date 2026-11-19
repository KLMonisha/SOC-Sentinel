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
| Evidence Room: graph, list, inspector, replay, focus, provenance | ✅ 🧪 | Core since Phase 5; **visually rebuilt in F1** (full-bleed graph, flat header, transport-style replay, hairline panels, provenance-complete indicator, Export tab). Behaviour unchanged; tested with mocks only. |
| Report page + citation navigation | ✅ 🧪 | Milestone B. Browser-verified against the mock only. |
| Analyst decision + audit history | ✅ 🧪 | Milestone B. Report page + Evidence Room "Decision" tab. Mock only (the mock keeps decisions in page memory, so a full reload resets them). |
| Counterfactual Lab | ✅ 🧪 | Milestone C. Branch composition, validation, changed/unchanged verdicts, failures, integrity re-check. **Mock only.** No adapter to the real stateless `/api/counterfactual` by decision: waits for stable cases and events. |
| Investigation Lab | ✅ 🧪 | Milestone D. Case picker, evidence planner, three-segment budget, execution stage, provenance ledger, before/after assessment, idempotent retries, all failure states. **Mock only** (scripted fixtures, labelled). |
| Red Team Lab | ✅ 🧪 | Milestone E. Three scenario modules, 1–10 trial configuration with exact-request review, indeterminate execution stage, baseline vs hardened comparison computed from returned trial records, trial inspector, citation integrity, partial/empty/error states. **Mock only** (hand-written fixtures, labelled, not measurements). |
| End-to-end journeys A–E | ❌ | Journey A partial (upload → queue → evidence), mock only. |
| Real-backend integration | ❌ | See §1. Blocked on Member 1 (events, envelope, cases, persistence). |
| Demo datasets and walkthrough | ❌ | Demo CSV drafted (see below). |
| Accessibility | 🟡 | Semantics and reduced motion present; no systematic audit. |
| Performance | 🟡 | Bundle sizes known (Landing ≈ 940 kB lazy, app ≈ 810 kB); no profiling. |
| Tests | ✅ | 372 passing after Milestone F1 (57 added: CSV, report model, PDF, graph PNG, export UI, config). |

## 3. Completion estimate (Member 2 scope, honest)
- **Overall: ≈ 88% after Milestone F1 (frontend feature-complete against the mock contract; exports and Evidence Room refinement done).** Remaining: end-to-end journeys and demo datasets, accessibility audit, performance pass, optional ZIP package. Real-backend work is outside Member 2 until Member 1 delivers the endpoints.
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

## 6. Frontend exports: implemented in Milestone F1 (see §9)

The exports scheduled here (PDF report, events/findings CSV, graph PNG) are built. The combined ZIP package with manifest and SHA-256 checksums is the only item still deferred.

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

## 7. Milestone D: backend functionality the Investigation Lab needs (not integrated)

The Investigation Lab (`/app/investigation[/:caseId]`) runs **only against the development mock**. Nothing below exists in the real backend today, and no adapter to `/api/analyze` or `/api/counterfactual` was written. Detail and acceptance criteria are in `BACKEND_INTEGRATION_REQUEST.md` §5.1; this list is what the screen specifically depends on.

| # | Needed from the backend | Why the UI needs it |
|---|---|---|
| 1 | `GET /api/cases/{id}` returning `planner {budget_total, budget_remaining, candidates[]}` with `tool`, `params`, `reason`, `used`, `recommended`, and (if real) `relevance`, `expected_uncertainty_reduction`, `retrieval_cost` | Planner modules and the budget meter. The UI shows exactly these fields and computes no scores. |
| 2 | `POST /api/cases/{id}/investigate` with `{tool, params?, idempotency_key}` | The only way to retrieve evidence. `params`, when sent, are the candidate's own, unmodified. |
| 3 | Response `retrieved_events[]` as full `SourceEvent` (`event_id`, `timestamp`, `source_file`, `line_number`, `raw_text`, `raw_hash`, entities) | Provenance ledger. Missing fields are displayed as missing, never filled. |
| 4 | Response `updated_case` (full `CaseDetail`, events folded in, verdict/risk/confidence/coverage/findings recomputed) and `previous {verdict, risk_score, confidence}` | Before/after comparison. If `updated_case` is absent the UI says so and shows no new assessment. |
| 5 | Response `budget_remaining`, authoritative and persisted per case | The UI never decrements the budget itself. |
| 6 | Idempotency: same key + same request returns the stored response and charges nothing; same key + different tool/params returns 409 `IDEMPOTENCY_KEY_REUSED`; keys scoped per case and persisted | Safe retry after a timeout or a transient failure. |
| 7 | 409 `INVESTIGATION_BUDGET_EXHAUSTED` when the budget is 0 | Locks the console. |
| 8 | Error codes with the envelope: `CASE_NOT_FOUND` (404), `UNSUPPORTED_TOOL` or `invalid_request` (400), a transient-failure code with 5xx (the mock uses `QUERY_FAILED` 503). **Please state whether a 5xx guarantees nothing was charged.** | The UI retries 5xx, timeouts and network errors with the same key, and does not retry 4xx. |
| 9 | Whether `retrieved_events[]` may contain events already in the case (the UI labels these "Already in case") and the allowed `params` keys per tool | Display and request validation. |
| 10 | Server-side request timeout expectation | The console gives up after 15 s and retries with the same key. |

Mock-only in Milestone D: all candidate sets, retrieved events, assessment changes, the scripted failure/slow/exhausted cases (`case_inv_*`), and the placeholder hashes. The UI-owned "investigation question" wording per tool is a label, not backend data.

## 8. Milestone E: Red Team Lab (`/app/red-team`), frontend state and backend dependencies

**Implemented (mock-tested only):** scenario selection (native radio group; exactly the three agreed ids), 1–10 trial validation, exact request review (`{scenario_id, trials}` and nothing else), duplicate-submit guard, cancel, 90 s client timeout, indeterminate running state (no progress or percentages are drawn because the contract returns one final response), baseline vs hardened comparison, trial inspector, citation integrity indicators, and explicit empty, partial, error and inconsistent-response states. Every displayed count and rate is computed from `outputs[]`; `injection_successes` is only compared against them and flagged if it disagrees. Attacker-controlled text (payloads, outputs) is rendered as inert text in a visually distinct hatched style. Descriptive text (what each surface is, expected defence) is UI-owned and labelled "descriptive, not measured".

**Mock-only:** every result. The fixtures in `api/mocks/redTeamScenarios.ts` are hand-written patterns (baseline fails/hardened resists; both resist; both fail; empty; partial; invalid or missing citations; 503 then success). They are selected by trial count because the request carries nothing else (map shown in the lab in mock mode). They are **not** measurements or benchmarks. Mock vs live isolation is covered by tests; live mode never falls back to fixtures.

**Backend dependencies (none verified; `/api/adversarial/run` does not exist yet):**
1. `POST /api/adversarial/run` with the agreed request and response shapes, `schema_version`, `request_id` and the error envelope; `trials` > 10 or < 1 returns 400.
2. Real baseline and hardened pipelines returning actual `outputs[]` per trial (no derived percentages).
3. An objective, documented rule for `injection_succeeded`.
4. `citation_check` that adds up (`verified + rejected = total`) and a statement of what "total" counts.
5. Run latency or a timeout statement (the UI assumes 90 s) and a statement of whether runs are synchronous.

**New contract ambiguities found while building this screen** (added to the questions for Member 1):
- **Per-trial citations:** the contract returns citation counts per pipeline only. The inspector can therefore show the pipeline totals but not "which citations in trial 3 were rejected". Request an optional `citations[{event_id, verified}]` on each output if wanted.
- **Why a trial counted as a success:** only a boolean is returned; there is no per-trial evidence field. The inspector says so rather than inventing one.
- **Partial results:** is `trials` the number requested, the number completed, or the number of records? What is returned if some trials error? The UI flags any difference between `trials` and `outputs.length`.
- **Trial pairing:** are baseline and hardened trial `n` the same input? The UI aligns them by trial number and shows a missing one as "not returned".
- **Payload provenance:** is `untrusted_payload` always an inert fixed string from the harness? The UI assumes so and renders it as text only.
- **`settings`:** only `model` and `temperature` are typed; any other keys are shown as returned.
- **Error codes:** no code list for this endpoint (the mock uses `ADVERSARIAL_RUN_FAILED`, 503); retries send a new independent request because there is no idempotency key.
- **Scenario catalogue:** there is no endpoint listing scenarios, so titles, surfaces and expected defences shown before a run are UI-owned text.

## 9. Milestone F1: Evidence Room refinement and investigation exports

**Implemented (all client-side, from stored case/report data; mock-tested only):**
- **Evidence Room:** rebuilt to the shell's visual language: full-bleed graph stage, flat architectural header with one instrument line of metrics, transport-style replay controls, hairline panels instead of nested boxes, provenance-complete / incomplete indicator in the Inspector, new Export tab. Graph, replay, focus, event deep links, citation navigation and the keyboard list fallback are unchanged. The 3D room remains deferred.
- **PDF report** (jsPDF, loaded on demand; real selectable text): branding, case ID and generation time, executive summary, verdict / risk / confidence / coverage as separate fields, supporting and contradicting findings, inferred and missing relationships, limitations, ATT&CK, chronology with source file:line, claims marked VERIFIED / NOT VERIFIED with unresolved citations flagged, dry-run containment, analyst audit, generation method, and an appendix quoting every source event with its SHA-256. Counterfactual and investigation sections appear **only** if they ran in this browser session. Mock reports carry a banner and a diagonal watermark on every page. Log text is escaped (`\xNN`, `\uNNNN`) so hidden or bidi characters cannot disguise content.
- **CSV** (events, findings, decision audit): explicit headers, deterministic order, stable IDs and provenance, `data_source` column, `missing_fields` column (null is kept, not dropped), formula-injection neutralisation (leading `= + - @ TAB CR` get an apostrophe), every field quoted, UTF-8 BOM.
- **Graph PNG:** drawn from the same normalised graph and layout as the on-screen view (not a screenshot), so it always covers the whole graph regardless of viewport, replay or zoom. Includes labels, legend, case ID, export time and source label; scale is capped by side length and pixel count and refused with a reason if the graph is too large.
- **Export interface** on the Report page (section 11) and in the Evidence Room (Export tab and header action): filename pattern, format, availability, disabled-with-reason states, results and errors announced, duplicate-click guard. Mock files are prefixed `DEVFIXTURE_`.
- **Red Team follow-ups:** adversarial timeout is configurable (`VITE_REDTEAM_TIMEOUT_MS`, 1000–600000, default 90000); the earlier browser-test selector was corrected and the check passes.

**Found and fixed while verifying the real files:** the PDF watermark was clipped at both ends of the page, and table cells split ordinary words mid-word (both fixed; the watermark has a geometry test). The PNG watermark was clipped and is now sized from its measured width.

**Not done / limitations:**
- Combined ZIP package with manifest and checksums: deferred.
- The PDF uses standard Helvetica/Courier (Latin-1). Non-Latin-1 characters are shown as visible escapes, not glyphs.
- The PNG is a faithful redraw of the model, not a pixel capture of React Flow, so styling is very close but not identical.
- Session-only content (counterfactual run, investigation queries) is in memory and is lost on reload; the API stores neither.
- No PDF/CSV/PNG came from a real backend case. Bundle: the main chunk grew to ≈ 993 kB; jsPDF (≈ 399 kB) loads only when a PDF is requested.
- No new backend endpoint was requested or created. Real-backend integration remains 0%.
