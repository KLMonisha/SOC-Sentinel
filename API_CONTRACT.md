# SOC Sentinel API Contract v1.0

**Status: decisions below CONFIRMED by Member 1. Field-level details marked ⚠ are still open.**
**Backend reality check (2026-11-19): see `INTEGRATION_STATUS.md`. `origin/backend-dev` implements only `/api/analyze` and a stateless `/api/counterfactual`; the frontend has run against the in-app mock only.**
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

## Phase 5 frontend assumptions (Evidence Room) ⚠ provisional, awaiting Member 1

The Evidence Room derives its graph in a replaceable adapter (`frontend/src/features/evidence/model/graphModel.ts`) from existing `CaseDetail` fields. No new backend fields were added.

- **Observed edges are derived, not taken from `graph`.** For each `events[]` item the UI draws `event → user` (`username`), `event → ip` (`source_ip`), `event → host` (`host`), and `finding → event` for every `findings[].event_ids` entry. Each edge's inspector text names the exact field and `source_file:line_number`. Entities are never linked to each other directly and nothing is linked by time proximity.
- **`graph` is used only for non-observed items.** Backend `graph.nodes/edges` with `state` of `inferred` or `missing` are rendered (dashed/dotted, labelled). Backend `observed` nodes/edges are ignored. Inferred/missing edges must reference real `event_ids` (or an empty list for a missing link) and endpoints that resolve; otherwise they are dropped and a warning is shown. **Open question #5 (graph vocabulary) therefore now only concerns inferred/missing items.**
- **Stable view IDs:** `user:<username>`, `ip:<address>`, `host:<host>`, `event:<event_id>`, `finding:<finding_id>`, `missing:<missing_id>`, `ext:<backend node id>`. Backend inferred/missing node ids must be stable across reruns for selection to survive a refetch.
- **Replay order** is `timestamp`, then `source_file`, `line_number`, `event_id`. The UI relies on `line_number` being unique per file.
- **Timeline** is rendered from `events[]`; `CaseDetail.timeline` is currently unused (open question #2 stands: confirm whether it is needed).
- **Contradicting evidence** is shown from `findings[].stance === "contradicting"`. If the backend wants raw contradicting events without a finding, it needs a field for them (open question #4).
- **Unresolved citations:** any `event_id` (finding, ATT&CK mapping, edge) that is not in `events[]` is displayed as "unresolved", never hidden. Every citation must resolve (confirmed item 9).
- **Fields not in the contract are not displayed:** destination IP and any per-event dataset ID are not shown. If wanted, they must be added to `SourceEvent`.
- Replay shows a note that verdict/risk/confidence are for the full investigation, because the backend provides no historical (as-of) verdicts.

## Phase 6 frontend assumptions (Report, citations, decisions) ⚠ provisional

- `GET /api/cases/{id}/report` is **read-only for the UI**: the frontend never asks for regeneration and re-reads it only on page load.
- Every `claims[].citations[]` id must resolve to an event in `GET /api/cases/{id}`. Unresolved citations are **displayed as unresolved** (not linked, not dropped); claims with `verified: false` or no citations are shown with their `verification_note`.
- Report chronology is built from `CaseDetail.events` (ordered by timestamp, source_file, line_number, event_id); `CaseDetail.timeline` is unused (open item 2).
- Deep link convention: `/app/evidence/{case_id}?event={event_id}` selects that event (revealing it if replay hid it). The URL follows the selection.
- `POST …/decision`: `analyst_id` required (trimmed); `note` optional (omitted when blank; open item 9 on whether a reason is required for reject). The UI asks for explicit confirmation, sends one request per confirmation, and never claims anything beyond "decision recorded, dry run".
- **Repeated decisions** are not assumed impossible: the UI lets the analyst attempt another decision, shows every returned `decisions[]` record oldest first (sorted client-side by `decided_at`; open item 9 asks for server ordering), and surfaces any backend refusal as an error.
- Approve/reject are disabled when `containment` is `null` (nothing to decide on).

## Phase 7 frontend assumptions (Counterfactual Lab) ⚠ provisional

- The lab sends exactly one `exclude_event` override with a trimmed, **required** `reason`. Open item 7 asks whether several overrides per request are supported.
- `original` in the response must equal the **stored case outcome**. The UI compares it to the case it loaded and flags any mismatch; it also flags `score_delta` that differs from `recomputed.risk_score.value − original.risk_score.value`. It always displays the backend's values unmodified.
- After a run the UI **re-reads `GET /api/cases/{id}`** and verifies verdict, risk, findings and event count are unchanged ("a counterfactual never mutates the case").
- `CaseOutcome` carries no `coverage`. The UI shows the stored coverage for the original and **"not returned" for the recomputed side**; it never derives one. (If the backend can recompute coverage, add an optional `coverage` to `CaseOutcome`.)
- `added`/`removed`/`changed` are keyed by stable `finding_id`. "No longer cited" / "newly cited" events are derived from the returned findings' `event_ids`, nothing else.
- An unchanged verdict (and even an unchanged score) is a normal 200 result.
- Error codes handled by name: `UNSUPPORTED_OVERRIDE`, `EVENT_NOT_FOUND` (upper-snake, as proposed in `BACKEND_INTEGRATION_REQUEST.md`).
- The dev mock's recomputation is a labelled stand-in (a finding with 0–1 supporting events left is removed; 2+ keeps a proportionally smaller weight). It is **not** a model of the backend's rules.

## Phase 8 frontend assumptions (Investigation Lab) ⚠ provisional

- Routes: `/app/investigation` (case picker) and `/app/investigation/:caseId`; `/app/investigate[/:caseId]` redirect there.
- Candidates are shown exactly as `planner.candidates[]` provides them. A candidate is a **proposal** (status Proposed); evidence exists only after a successful `POST …/investigate`. `params` are sent verbatim (omitted when empty); the UI never edits or adds parameters. A candidate whose `tool` is not one of the three agreed tools is shown as unsupported and never sent.
- The initial budget is `planner.budget_total` / `budget_remaining` as returned (3 in the mock). After a response the UI uses the response's `budget_remaining`; it is never decremented locally. `INVESTIGATION_BUDGET_EXHAUSTED` locks the console for that case.
- Each user-initiated action gets a fresh `crypto.randomUUID()` key, retained across retries of that action (timeout, network error, 5xx) and discarded after success or a non-retryable error. A synchronous guard prevents duplicate submission while a request is in flight. The request times out client-side after 15 s.
- The before/after view uses `previous` (before) and `updated_case` (after). If `updated_case` is missing the UI states "No updated assessment was returned". Findings are diffed by `finding_id`. An unchanged verdict is presented as a valid outcome.
- Raw log text is rendered as inert text. Provenance is checked for presence and shape only (SHA-256 is a 64-hex check; the UI does not recompute the hash). Evidence Room links use `/app/evidence/{case}?event={event_id}` and are offered only if the event is in `updated_case.events`.
- Query history is **not** in the contract: only queries run in the current browser session are listed (in-memory; lost on reload). The candidate `used` flag is the only persisted trace.
- Wording for each tool's "investigation question" is UI-owned; the contract has no such field.

## Phase 9 frontend assumptions (Red Team Lab) ⚠ provisional

- Route `/app/red-team`. The request is exactly `{ scenario_id, trials }`; `trials` is an integer 1–10 validated before sending. The three scenario ids are the only ones offered.
- Rates, counts and "observed trust-boundary violations" are computed from `baseline.outputs[]` and `hardened.outputs[]` (`injection_succeeded`). Reported `trials` and `injection_successes` are compared with the records and any difference is shown as a note; the records win.
- `citation_check` is shown per pipeline. `total = 0` is displayed as "no citations checked or returned" (never as valid); `verified + rejected ≠ total` is flagged as inconsistent. Per-trial citation results are not in the contract and are shown as "not returned per trial".
- Expected behaviour, attacker surface and boundary-violation descriptions are UI-owned and labelled descriptive. `scenario.field` and `scenario.untrusted_payload` come from the response and are rendered as inert text.
- A single final response is assumed (no progress, so none is shown). Client timeout 90 s. No idempotency key: each start is an independent run.
