import pytest

from app.services import llm_report_service as svc

CASE = "case_aaaaaaaaaaaaaaaa"
E = [f"evt_{i:016x}" for i in range(1, 6)]


def _events():
    return [{"event_id": e, "source_ip": "198.51.100.7", "destination_ip": None} for e in E]


def _findings(cites=None):
    return [{"finding_id": "alert_1", "rule_id": "DET-001", "title": "Brute force",
             "description": "5 failed logins from 198.51.100.7 against alice", "severity": "high",
             "stance": "supporting", "weight": 30, "event_ids": cites or E}]


ROW = {"risk_value": 80, "severity": "high", "coverage_missing": ["host_context"], "verdict_rationale": "rule based"}
MISSING = [{"telemetry": "Host context"}]


def good(report):
    inc = report["incidents"][0]["incident_id"]
    return {**report, "llm_status": "success", "llm_narrative": {
        "executive_summary": "Repeated failed logins were observed from 198.51.100.7.",
        "incident_explanations": [{"incident_id": inc, "explanation": "One correlated case."}],
        "claim_explanations": [{"claim_index": i, "explanation": f"Explains claim {i}."}
                               for i in range(len(report["claims"]))]}}


def test_success_keeps_claims_and_citations_and_labels_ai_text():
    rep = svc.build_llm_report(CASE, ROW, _events(), _findings(), MISSING, narrate=good)
    assert rep["generated_by"] == "llm" and rep["fallback_reason"] is None and rep["llm_model"]
    assert rep["summary"].startswith("AI-generated summary (")
    assert all("AI-generated explanation (" in c["text"] for c in rep["claims"])
    assert [c["citations"] for c in rep["claims"]][0] == E          # citations unchanged
    assert all(c["verified"] for c in rep["claims"])                 # deterministic verification kept
    assert rep["counts"] == {"total": 2, "verified": 2, "rejected": 0}
    assert rep["verdict_rationale"] == "rule based"                  # deterministic text untouched


def test_unresolvable_citation_stays_unverified_whatever_the_model_says():
    rep = svc.build_llm_report(CASE, ROW, _events(), _findings(cites=E + ["evt_deadbeefdeadbeef"]), MISSING, narrate=good)
    assert rep["claims"][0]["verified"] is False
    assert rep["counts"]["rejected"] >= 1


def test_fallback_status_raises_and_redacts_keys():
    def failing(report):
        return {**report, "llm_status": "fallback", "llm_error": "AuthenticationError: bad key gsk_ABCDEF123456"}
    with pytest.raises(svc.LlmReportRejected) as e:
        svc.build_llm_report(CASE, ROW, _events(), _findings(), MISSING, narrate=failing)
    assert e.value.code == "LLM_UNAVAILABLE" and "gsk_" not in e.value.message


@pytest.mark.parametrize("injected", ["evt_0000000000000fff", "203.0.113.99"])
def test_invented_event_id_or_ip_is_rejected(injected):
    def bad(report):
        out = good(report)
        out["llm_narrative"]["claim_explanations"][0]["explanation"] = f"See {injected} for details."
        return out
    with pytest.raises(svc.LlmReportRejected) as e:
        svc.build_llm_report(CASE, ROW, _events(), _findings(), MISSING, narrate=bad)
    assert e.value.code == "LLM_OUTPUT_REJECTED" and injected in e.value.message


def test_known_references_are_allowed():
    assert svc.ungrounded_references([f"{E[0]} from 198.51.100.7"], set(E), {"198.51.100.7"}) == []


def test_flag_defaults_to_disabled(monkeypatch):
    monkeypatch.delenv("LLM_REPORTS_ENABLED", raising=False)
    assert svc.enabled() is False
    monkeypatch.setenv("LLM_REPORTS_ENABLED", "true")
    assert svc.enabled() is True
    monkeypatch.setenv("LLM_REPORTS_ENABLED", "yes")
    assert svc.enabled() is False
