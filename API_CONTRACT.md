# SOC Sentinel API Contract — PROPOSAL v1.0

**Status: proposed by Member 2 (frontend). Not yet confirmed by Member 1.**
Source of truth for field-level shapes is `frontend/src/api/types.ts`. Source of scope: `docs/SOC_Sentinel_Revised_24_Hour_Build_Plan.docx` §9.

Please reply per item below with *agree / change to X*. Until confirmed, the frontend builds against mocks that conform to these shapes.

## Conventions

- All responses are JSON and include `schema_version` (`"1.0"`) and `request_id`.
- Errors: HTTP 4xx/5xx with `{ schema_version, request_id, error: { code, message, details? } }`.
  Note: today's FastAPI default is `{ "detail": ... }`; a global exception handler is needed.
- Timestamps are ISO-8601 UTC. IDs are opaque strings.
- Three separate score outputs, never merged: `risk_score` (0–100 **heuristic, not a probability**), `confidence` (low/medium/high + rationale), `coverage` (ratio + present/missing telemetry).
- Missing telemetry is reported as `missing`, never as benign.
- Every finding/claim carries `event_ids` that resolve to `events[]` in the case. No orphan citations.
- Containment is dry-run: `dry_run` is always `true`.

## Endpoints

| Endpoint | Request | Response |
|---|---|---|
| `POST /api/upload` | multipart `file` (CSV/JSON) | `UploadResponse`: dataset id, file SHA-256, counts, validation errors (quarantined rows), created `CaseSummary[]` |
| `GET /api/cases` | — | `{ cases: CaseSummary[] }` |
| `GET /api/cases/{id}` | — | `CaseDetail`: findings (supporting/contradicting), missing evidence, ATT&CK mappings, graph, source events with raw line, planner state, containment, decisions |
| `GET /api/cases/{id}/report` | — | `ReportResponse`: claims with citations and per-claim verification, `generated_by` (`llm` or `template_fallback`) |
| `POST /api/cases/{id}/counterfactual` | `{ overrides: [...] }` | original vs recomputed outcome, `score_delta`, added/removed/changed findings with reasons. Stored case unchanged |
| `POST /api/cases/{id}/investigate` | `{ tool, params?, idempotency_key }` | retrieved real events, `budget_remaining`, `updated_case`, previous outcome |
| `POST /api/adversarial/run` | `{ scenario_id, trials }` | scenario + payload, baseline vs hardened per-trial outputs, injection counts, citation check, model settings |
| `POST /api/cases/{id}/decision` | `{ decision, analyst_id, note? }` | audit `DecisionRecord`, new `case_status` |

## Items needing Member 1's confirmation

1. **`/api/upload` vs existing `/api/analyze`.** Backend currently exposes `/api/analyze` returning `alerts`/`incidents`. Contract asks for `/api/upload` returning cases. Rename, add alongside, or change contract?
2. **Case model.** Is an "incident" a "case"? Contract needs `verdict`, `confidence`, `coverage`, `missing_evidence`, `attack_mappings`, `graph`, and `events` (with `source_file`, `line_number`, `raw_text`) per case.
3. **Verdict enum:** `likely_malicious | needs_investigation | likely_benign | insufficient_evidence`; risk bands `low | investigate | high`.
4. **Event IDs** must be stable across reruns and counterfactuals so citations and graph nodes stay linkable.
5. **Counterfactual overrides** (discriminated by `type`): `verified_corporate_vpn{ip}`, `invalidate_ioc{indicator}`, `exclude_event{event_id, reason}`, `verified_maintenance{host,start,end,reason}`. Are all four supported?
6. **Planner state in `CaseDetail`:** `planner.candidates[]` with ranking heuristics + `recommended` + `reason`, and `budget_remaining` (initial 3). Alternatively a separate GET.
7. **Investigate idempotency:** same `idempotency_key` must not spend budget twice. Out-of-budget error code?
8. **Adversarial:** are `trials` caller-set (and capped)? Can the API return the scenario list, or are the three IDs fixed (`user_agent_injection`, `url_query_contamination`, `fake_analyst_authorization`)?
9. **Citation resolution:** report claims cite `event_id`s only (frontend resolves to `events[]`).
10. **Analyst identity:** is `analyst_id` free text for the demo?
11. **Database:** PostgreSQL/Supabase (plan said SQLite). Does not affect the HTTP contract; frontend never touches DB credentials.
12. **CORS / base URL** for the deployed backend (dev uses a Vite `/api` proxy to `:8000`).
