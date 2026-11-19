"""LLM-assisted report for one persisted case. Reuses Member 1's generate_llm_narrative unchanged.

Groq only writes prose. Claims, citations and verified flags come from the deterministic report and are never
changed. Output is rejected if it mentions an event id or IPv4 address that is not part of the case."""
import os
import re
from types import SimpleNamespace

from app.services import llm_reporting
from app.services.reporting import generate_investigation_report

_EVT = re.compile(r"\bevt_[0-9a-f]{16}\b")
_IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_KEY = re.compile(r"gsk_[A-Za-z0-9]+")
MAX_EXPLANATION = 2000


class LlmReportRejected(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def _safe(msg: str) -> str:
    return _KEY.sub("[redacted]", str(msg))[:300]


def enabled() -> bool:
    return os.environ.get("LLM_REPORTS_ENABLED", "").strip().lower() == "true"


def ungrounded_references(texts: list[str], event_ids: set[str], known_ips: set[str]) -> list[str]:
    bad = []
    for t in texts:
        bad += [e for e in _EVT.findall(t) if e not in event_ids]
        bad += [i for i in _IPV4.findall(t) if i not in known_ips]
    return sorted(set(bad))


def build_llm_report(case_id: str, case_row, events, findings, missing, narrate=None) -> dict:
    """Return the dict repository.insert_report expects. Raises LlmReportRejected on any failure (nothing stored)."""
    narrate = narrate or llm_reporting.generate_llm_narrative
    llm_reporting.MODEL = os.environ.get("GROQ_MODEL", llm_reporting.MODEL)

    event_ids = [e["event_id"] for e in events]
    alerts = [{"alert_id": f["finding_id"], "rule_id": f["rule_id"], "title": f["title"],
               "description": f["description"], "severity": f["severity"], "stance": f["stance"],
               "weight": float(f["weight"]), "event_ids": list(f["event_ids"])} for f in findings]
    incident_id = "inc_" + case_id[5:]
    incident = {"case_id": case_id, "incident_id": incident_id, "alert_ids": [a["alert_id"] for a in alerts],
                "event_ids": event_ids, "alert_count": len(alerts), "risk_score": case_row["risk_value"],
                "severity": case_row["severity"]}
    built = generate_investigation_report([SimpleNamespace(event_id=i) for i in event_ids], alerts, [incident],
                                          {"dimensions_missing": list(case_row["coverage_missing"])})
    # adapter: Member 1's narrative payload reads claim keys "statement" and "event_ids"
    for c in built["claims"]:
        c["statement"], c["event_ids"] = c["text"], list(c["citations"])

    result = narrate(built)
    if result.get("llm_status") != "success":
        raise LlmReportRejected("LLM_UNAVAILABLE", _safe(result.get("llm_error") or "Groq did not return a usable result."))

    nar = result["llm_narrative"]
    by_index = {x["claim_index"]: x["explanation"].strip()[:MAX_EXPLANATION] for x in nar["claim_explanations"]}
    case_expl = " ".join(x["explanation"].strip() for x in nar["incident_explanations"])[:MAX_EXPLANATION]
    summary = nar["executive_summary"].strip()

    known_ips = {e["source_ip"] for e in events if e["source_ip"]} | {e["destination_ip"] for e in events if e["destination_ip"]}
    known_ips |= set(_IPV4.findall(" ".join(f["description"] for f in findings)))
    bad = ungrounded_references([summary, case_expl, *by_index.values()], set(event_ids), known_ips)
    if bad:
        raise LlmReportRejected("LLM_OUTPUT_REJECTED", "Generated text referenced values not found in this case: " + ", ".join(bad[:5]))
    if not summary:
        raise LlmReportRejected("LLM_OUTPUT_REJECTED", "Generated summary was empty.")

    in_case = set(event_ids)
    claims = []
    for i, c in enumerate(built["claims"]):
        base = c["text"] if c["type"] != "detection_finding" else f"{c['title']}: {c['text']}"
        claims.append({"text": f"{base}\n\nAI-generated explanation ({llm_reporting.MODEL}): {by_index[i]}",
                       "verified": c["verified"], "verification_note": c["verification_note"],
                       "citations": list(c["citations"]), "resolved": {x for x in c["citations"] if x in in_case}})
    text = f"AI-generated summary ({llm_reporting.MODEL}): {summary}"
    if case_expl:
        text += f"\n\nAI-generated case explanation: {case_expl}"
    return {"generated_by": "llm", "fallback_reason": None, "llm_model": llm_reporting.MODEL, "summary": text,
            "verdict_rationale": case_row["verdict_rationale"], "missing_information": [m["telemetry"] for m in missing],
            "counts": built["citation_counts"], "claims": claims}
