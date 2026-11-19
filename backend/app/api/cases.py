"""Contract endpoints (API_CONTRACT.md v1.0): POST /api/upload, GET /api/cases, GET /api/cases/{id}.
Backed by Supabase PostgreSQL only; there is no mock or in-memory fallback."""
import tempfile
import uuid
from datetime import timezone
from decimal import Decimal
from pathlib import Path

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.db import repository as repo
from app.db.engine import DatabaseNotConfigured, get_engine
from app.services.assessment import assess_telemetry_coverage, enrich_alerts_with_confidence
from app.services.case_builder import build_case
from app.services.correlation import correlate_alerts
from app.services.detection import run_detection
from app.services.ingestion import MAX_FILE_SIZE, ingest_file
from app.services.mitre_mapping import enrich_alerts_with_attack

SCHEMA_VERSION = "1.0"
router = APIRouter(prefix="/api", tags=["Contract"])


def _rid() -> str:
    return f"req_{uuid.uuid4().hex[:12]}"


def _err(status: int, code: str, message: str, rid: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"schema_version": SCHEMA_VERSION, "request_id": rid,
                                                     "error": {"code": code, "message": message}})


def _db_err(exc: Exception, rid: str) -> JSONResponse:
    if isinstance(exc, DatabaseNotConfigured):
        return _err(503, "DATABASE_NOT_CONFIGURED", str(exc), rid)
    if isinstance(exc, IntegrityError):
        constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None) or ""
        return _err(409, "PERSISTENCE_CONFLICT", f"Database rejected the data ({constraint}).", rid)
    return _err(503, "DATABASE_ERROR", f"Database error (SQLSTATE {getattr(exc.orig, 'sqlstate', '?')}).", rid)


def _ts(v) -> str:
    return v.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _num(v):
    return float(v) if isinstance(v, Decimal) else v


def _summary(r) -> dict:
    return {"case_id": r["case_id"], "dataset_id": r["dataset_id"], "title": r["title"], "status": r["status"],
            "verdict": r["verdict"], "severity": r["severity"], "primary_entities": list(r["primary_entities"]),
            "event_count": r["event_count"], "first_seen": _ts(r["first_seen"]), "last_seen": _ts(r["last_seen"]),
            "risk_score": {"value": r["risk_value"], "band": r["risk_band"], "reasoning": list(r["risk_reasoning"])}}


@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    rid = _rid()
    name = file.filename or ""
    ext = Path(name).suffix.lower()
    if ext not in {".csv", ".json"}:
        return _err(400, "UNSUPPORTED_FORMAT", "Upload a CSV or JSON file.", rid)
    content = await file.read(MAX_FILE_SIZE + 1)
    await file.close()
    if not content:
        return _err(400, "EMPTY_FILE", "Uploaded file is empty.", rid)
    if len(content) > MAX_FILE_SIZE:
        return _err(413, "FILE_TOO_LARGE", "File exceeds the 10 MB size limit.", rid)

    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", suffix=ext, delete=False) as t:
            t.write(content)
            tmp = Path(t.name)
        ing = ingest_file(tmp, source_name=name)
    except (ValueError, UnicodeDecodeError) as exc:
        return _err(400, "INVALID_FILE", str(exc)[:500], rid)
    finally:
        if tmp and tmp.exists():
            tmp.unlink()

    try:
        engine = get_engine()
        with engine.begin() as conn:
            existing = repo.find_dataset(conn, ing["file_sha256"])
            if existing:
                repo.record_duplicate_upload(conn, existing["dataset_id"], ing["source_file"], rid)
                dataset_id = existing["dataset_id"]
            else:
                events = ing["events"]
                alerts = enrich_alerts_with_confidence(enrich_alerts_with_attack(run_detection(events)), events)
                coverage = assess_telemetry_coverage(events)
                cases = correlate_alerts(alerts, events)
                a_by = {a["alert_id"]: a for a in alerts}
                e_by = {e.event_id: e for e in events}
                repo.insert_dataset(conn, ing, ing["source_file"], len(content), ext[1:], rid)
                for c in cases:
                    repo.insert_case(conn, ing["dataset_id"], build_case(c, a_by, e_by, coverage))
                dataset_id = ing["dataset_id"]
        with engine.connect() as conn:
            ds = repo.dataset_row(conn, dataset_id)
            rows = repo.list_case_rows(conn, dataset_id)
            quarantine = repo.quarantine_rows(conn, dataset_id)
    except (DatabaseNotConfigured, DBAPIError) as exc:
        return _db_err(exc, rid)

    return {"schema_version": SCHEMA_VERSION, "request_id": rid, "dataset_id": dataset_id,
            "filename": ds["canonical_filename"], "file_sha256": ds["file_sha256"],
            "counts": {"total_records": ds["total_records"], "valid_events": ds["valid_events"],
                       "quarantined_records": ds["quarantined_records"]},
            "validation_errors": [{"row_number": q["row_number"], "reason": q["reason"]} for q in quarantine],
            "cases": [_summary(r) for r in rows]}


@router.get("/cases")
def list_cases():
    rid = _rid()
    try:
        with get_engine().connect() as conn:
            rows = repo.list_case_rows(conn)
    except (DatabaseNotConfigured, DBAPIError) as exc:
        return _db_err(exc, rid)
    return {"schema_version": SCHEMA_VERSION, "request_id": rid, "cases": [_summary(r) for r in rows]}


@router.get("/cases/{case_id}")
def get_case(case_id: str):
    rid = _rid()
    try:
        with get_engine().connect() as conn:
            r = repo.get_case_row(conn, case_id)
            if not r:
                return _err(404, "CASE_NOT_FOUND", f"No case {case_id}.", rid)
            events = repo.case_events(conn, case_id)
            findings, attack, missing, decisions = repo.case_children(conn, case_id, r["assessment_id"])
    except (DatabaseNotConfigured, DBAPIError) as exc:
        return _db_err(exc, rid)

    ev = [{"event_id": e["event_id"], "timestamp": _ts(e["timestamp"]), "event_type": e["event_type"],
           "username": e["username"], "source_ip": e["source_ip"], "host": e["host"], "resource": e["resource"],
           "outcome": e["outcome"], "source_file": e["source_file"], "line_number": e["line_number"],
           "raw_text": e["raw_text"], "raw_hash": e["raw_hash"]} for e in events]
    containment = None
    if r["containment_action"]:
        containment = {"action": r["containment_action"], "target": r["containment_target"],
                       "rationale": r["containment_rationale"], "dry_run": True}
    return {"schema_version": SCHEMA_VERSION, "request_id": rid, "summary": _summary(r),
            "verdict_rationale": r["verdict_rationale"],
            "confidence": {"level": r["confidence_level"], "rationale": r["confidence_rationale"]},
            "coverage": {"ratio": _num(r["coverage_ratio"]), "present": list(r["coverage_present"]),
                         "missing": list(r["coverage_missing"])},
            "findings": [{"finding_id": f["finding_id"], "rule_id": f["rule_id"], "title": f["title"],
                          "description": f["description"], "severity": f["severity"], "stance": f["stance"],
                          "weight": _num(f["weight"]), "event_ids": list(f["event_ids"])} for f in findings],
            "missing_evidence": [{"missing_id": m["missing_id"], "telemetry": m["telemetry"],
                                  "why_it_matters": m["why_it_matters"]} for m in missing],
            "attack_mappings": [{"technique_id": m["technique_id"], "name": m["name"], "tactic": m["tactic"],
                                 "event_ids": list(m["event_ids"])} for m in attack],
            "graph": r["graph"], "events": ev,
            "timeline": [{"event_id": e["event_id"], "timestamp": e["timestamp"], "label": e["event_type"]}
                         for e in ev],
            "planner": {"budget_total": r["investigation_budget_total"], "budget_remaining": r["budget_remaining"],
                        "candidates": []},
            "containment": containment,
            "decisions": [{"decision_id": d["decision_id"], "case_id": d["case_id"], "decision": d["decision"],
                           "analyst_id": d["analyst_id"], "note": d["note"], "decided_at": _ts(d["decided_at"]),
                           "dry_run": True} for d in decisions]}


@router.get("/cases/{case_id}/report")
def get_report(case_id: str):
    """Report for the case's CURRENT assessment. Built once from the persisted findings and events with the
    backend's deterministic generator (no language model), stored append-only, then served from storage."""
    from types import SimpleNamespace
    from app.services.reporting import generate_investigation_report

    rid = _rid()
    try:
        with get_engine().begin() as conn:
            r = repo.get_case_row(conn, case_id)
            if not r:
                return _err(404, "CASE_NOT_FOUND", f"No case {case_id}.", rid)
            stored = repo.latest_report_for_assessment(conn, case_id, r["assessment_id"])
            if stored is None:
                events = repo.case_events(conn, case_id)
                findings, _attack, missing, _dec = repo.case_children(conn, case_id, r["assessment_id"])
                event_ids = [e["event_id"] for e in events]
                alerts = [{"alert_id": f["finding_id"], "rule_id": f["rule_id"], "title": f["title"],
                           "description": f["description"], "severity": f["severity"], "stance": f["stance"],
                           "weight": _num(f["weight"]), "event_ids": list(f["event_ids"])} for f in findings]
                incident = {"case_id": case_id, "event_ids": event_ids, "alert_count": len(alerts),
                            "risk_score": r["risk_value"], "severity": r["severity"]}
                coverage = {"dimensions_missing": list(r["coverage_missing"])}
                built = generate_investigation_report([SimpleNamespace(event_id=i) for i in event_ids],
                                                      alerts, [incident], coverage)
                in_case = set(event_ids)
                claims = []
                for c in built["claims"]:
                    text_ = c["text"] if c["type"] != "detection_finding" else f"{c['title']}: {c['text']}"
                    claims.append({"text": text_, "verified": c["verified"],
                                   "verification_note": c["verification_note"], "citations": list(c["citations"]),
                                   "resolved": {i for i in c["citations"] if i in in_case}})
                rep = {"generated_by": built["generated_by"], "fallback_reason": built["fallback_reason"],
                       "summary": built["executive_summary"], "verdict_rationale": r["verdict_rationale"],
                       "missing_information": [m["telemetry"] for m in missing],
                       "counts": built["citation_counts"], "claims": claims}
                report_id = repo.insert_report(conn, case_id, r["dataset_id"], r["assessment_id"], rep, rid)
                stored = repo.latest_report_for_assessment(conn, case_id, r["assessment_id"])
                assert stored["report_id"] == report_id
            claims = repo.report_with_claims(conn, stored["report_id"])
    except (DatabaseNotConfigured, DBAPIError) as exc:
        return _db_err(exc, rid)

    return {"schema_version": SCHEMA_VERSION, "request_id": rid, "case_id": case_id,
            "generated_by": stored["generated_by"], "summary": stored["summary"],
            "verdict_rationale": stored["verdict_rationale"],
            "claims": [{"claim_id": c["claim_id"], "text": c["text"], "citations": list(c["citations"]),
                        "verified": c["verified"], "verification_note": c["verification_note"]} for c in claims],
            "missing_information": list(stored["missing_information"]),
            "citation_check": {"total": stored["citation_total"], "verified": stored["citation_verified"],
                               "rejected": stored["citation_rejected"]}}
