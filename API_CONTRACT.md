# SOC Sentinel API Contract v1.0

**Status: decisions below CONFIRMED by Member 1. Field-level details marked ⚠ are still open.**
Field shapes: `frontend/src/api/types.ts` (frontend's reading of the agreement). Scope source: `docs/SOC_Sentinel_Revised_24_Hour_Build_Plan.docx` §9.

## Conventions (confirmed)

- Every response includes `schema_version: "1.0"` and `request_id`.
- Consistent error envelope; frontend currently assumes `{ schema_version, request_id, error: { code, message, details? } }` ⚠ (see open items).
- Timestamps ISO-8601 UTC. Event IDs are deterministic and stable across reruns of identical datasets; every graph node, timeline entry and report citation uses source event IDs.
- Risk score (0–100) is a **heuristic, never a probability**. Risk score, confidence and coverage are three separate outputs.
- All containment is dry-run: `dry_run: true`. Nothing is blocked, disabled or isolated.
- The frontend talks only to FastAPI (never to Supabase/Postgres directly). Dev: Vite `/api` proxy → `127.0.0.1:8000`. Deployed: `VITE_API_BASE_URL`.

## Endpoints

| Endpoint | Notes (confirmed) |
|---|---|
| `POST /api/upload` | Frontend's ingestion path: ingest, normalize, detect, correlate, persist, create cases. Returns dataset ID + `CaseSummary[]`. `/api/analyze` is retained by backend for backward compatibility; **the frontend does not use it**. |
| `GET /api/cases` | `CaseSummary[]`. One dataset may yield many cases; each summary carries `dataset_id`. |
| `GET /api/cases/{id}` | `CaseDetail`: verdict, risk score, confidence + rationale, coverage, missing telemetry, findings (supporting/contradicting), ATT&CK mappings, related events, timeline, planner state, containment recommendation, analyst decisions. |
| `GET /api/cases/{id}/report` | Claims cite **event IDs only**; every citation must resolve to an event in that case. |
| `POST /api/cases/{id}/counterfactual` | **MVP supports only `exclude_event`** `{event_id, reason}`. Does not mutate the stored case. Frontend types cannot even express `verified_corporate_vpn`, `invalidate_ioc` or `verified_maintenance`; they will be added only when the backend supports them. |
| `POST /api/cases/{id}/investigate` | Requires `idempotency_key`. Same key retried ⇒ no extra budget. Initial budget 3. Retrieves existing events only. Exhaustion ⇒ error code `INVESTIGATION_BUDGET_EXHAUSTED`. |
| `POST /api/adversarial/run` | `scenario_id` ∈ `user_agent_injection`, `url_query_contamination`, `fake_analyst_authorization`. `trials` configurable, **max 10**. Returns baseline vs hardened outcomes, trial counts, citation verification, model settings. |
| `POST /api/cases/{id}/decision` | `analyst_id` (free text) required and echoed in every record. |

Enums: verdict `likely_malicious | needs_investigation | likely_benign | insufficient_evidence`; risk band `low | investigate | high`.

## Open field-level items ⚠ (please confirm or correct)

1. **Error envelope + codes.** Exact JSON shape, HTTP status per code, and casing. `INVESTIGATION_BUDGET_EXHAUSTED` is upper-snake; the frontend assumes the same style for others (e.g. `CASE_NOT_FOUND`, `UNSUPPORTED_OVERRIDE`, `FILE_TOO_LARGE`). Need the full code list. FastAPI's default `{"detail": ...}` for 422/validation errors must be wrapped too. Assumed 409 for budget exhaustion.
2. **`CaseDetail.timeline`.** Assumed `{event_id, timestamp, label}[]`. Is it derived from `events[]` or separate?
3. **`CaseDetail.verdict_rationale`** (string) separate from `confidence.rationale`. Assumed; confirm names.
4. **Supporting vs contradicting.** Assumed `findings[].stance` plus signed `weight`. Is contradicting evidence only expressed as findings, or also as raw events?
5. **Graph.** Node `kind` (`user|ip|host|event`), `state` (`observed|inferred|missing`), edge `relation` vocabulary, and whether inferred/missing nodes have IDs stable across reruns. Are graph nodes for events keyed `event_id`?
6. **Upload errors.** Codes/status for whole-file failures (bad type, >10 MB, empty, too many rows, wrong schema) vs row-level quarantine (`validation_errors[]` with `row_number`, `reason`). Are `total_records`, `valid_events`, `quarantined_records` the final names? Does upload create zero cases when nothing is detected?
7. **Counterfactual details.** May `overrides[]` hold multiple `exclude_event` items? Does the response include recomputed `graph`? What if the event is not in the case (assumed 404)? Is the exclusion persisted anywhere, or purely ephemeral?
8. **Planner.** `candidates[].params` shape per tool; whether `used` is reported; is the idempotency key scoped per case; what if the same key is reused with a different tool (assumed error)?
9. **Decisions.** Can a case be decided more than once? Does `case_status` change (`open → approved|rejected`)? Is audit history ordered ascending?
10. **Adversarial.** `settings` fields beyond model/temperature; whether runs are synchronous (10 trials may be slow: needs expected latency/timeout); how `injection_succeeded` is determined.
11. **Report.** `generated_by` values (`llm | template_fallback`); are unverified/rejected claims returned (flagged) or removed?
12. **Cases list.** Pagination/sort, or full list?
