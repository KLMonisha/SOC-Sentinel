
from datetime import datetime, timezone

from app.models.events import SecurityEvent
from app.services.reporting import (
    generate_investigation_report,
    validate_report_citations,
)


def make_event(event_id):
    return SecurityEvent(
        event_id=event_id,
        dataset_id="ds_test",
        timestamp=datetime.now(timezone.utc),
        event_type="authentication_failure",
        username="alice",
        source_ip="203.0.113.10",
        outcome="failure",
        source="test",
        line_number=1,
        raw_text=f'{{"event_id":"{event_id}"}}',
        raw_hash="a" * 64,
        raw_record={},
    )


def test_report_generation():
    events = [make_event(f"evt_{i}") for i in range(5)]

    alerts = [{
        "alert_id": "alert_1",
        "rule_id": "DET-001",
        "title": "Possible Brute-Force Attack",
        "description": "Repeated failed login attempts.",
        "severity": "high",
        "event_ids": [event.event_id for event in events],
        "confidence": {"level": "high", "rationale": []},
        "mitre_attack": [],
        "stance": "supporting",
        "weight": 30,
    }]

    incidents = [{
        "incident_id": "inc_1",
        "alert_count": 1,
        "event_ids": [event.event_id for event in events],
        "risk_score": 72,
        "severity": "high",
    }]

    coverage = {
        "coverage_ratio": 0.5,
        "dimensions_missing": ["host_context", "web_access"],
    }

    report = generate_investigation_report(
        events,
        alerts,
        incidents,
        coverage,
    )

    assert report["report_status"] == "completed"
    assert report["generated_by"] == "template_fallback"
    assert report.get("fallback_reason")
    assert len(report["claims"]) == 2

    for claim in report["claims"]:
        assert "text" in claim
        assert "citations" in claim
        assert isinstance(claim["verified"], bool)

        if claim["verified"]:
            assert claim["citations"]

    counts = report["citation_counts"]

    assert counts["total"] == (
        counts["verified"] + counts["rejected"]
    )


def test_report_with_no_alerts_does_not_claim_environment_is_benign():
    report = generate_investigation_report(
        events=[make_event("evt_1")],
        alerts=[],
        incidents=[],
        telemetry_coverage={
            "coverage_ratio": 0.25,
            "dimensions_missing": ["web_access"],
        },
    )

    assert report["dataset_summary"]["alert_count"] == 0
    assert "does not establish" in report["executive_summary"]


def test_report_never_executes_containment():
    report = generate_investigation_report(
        events=[make_event("evt_1")],
        alerts=[],
        incidents=[],
        telemetry_coverage={"dimensions_missing": []},
    )

    assert report["containment"]["dry_run"] is True
    assert report["containment"]["executed"] is False


def test_invalid_citations_are_detected():
    report = {
        "claims": [{
            "text": "A suspicious authentication pattern was observed.",
            "citations": ["evt_1", "evt_missing"],
            "verified": False,
        }]
    }

    result = validate_report_citations(report, {"evt_1"})

    assert result["citation_counts"]["total"] == 1
    assert result["citation_counts"]["verified"] == 0
    assert result["citation_counts"]["rejected"] == 1

    claim = result["claims"][0]

    assert claim["verified"] is False
    assert "evt_missing" not in claim["citations"]


def test_claim_without_citations_is_never_verified():
    report = {
        "claims": [{
            "text": "An unsupported claim.",
            "citations": [],
            "verified": True,
        }]
    }

    result = validate_report_citations(report, set())

    assert result["claims"][0]["verified"] is False
    assert result["citation_counts"]["verified"] == 0


def test_claim_with_valid_citation_is_verified():
    report = {
        "claims": [{
            "text": "Repeated authentication failures were observed.",
            "citations": ["evt_1"],
            "verified": False,
        }]
    }

    result = validate_report_citations(report, {"evt_1"})

    assert result["claims"][0]["verified"] is True
    assert result["citation_counts"]["verified"] == 1
    assert result["citation_counts"]["rejected"] == 0
