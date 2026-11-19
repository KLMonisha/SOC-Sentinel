
from datetime import datetime, timedelta, timezone

from app.models.events import SecurityEvent
from app.services.assessment import (
    assess_alert_confidence,
    assess_telemetry_coverage,
)


def make_event(
    event_id,
    event_type,
    username="alice",
    source_ip="203.0.113.10",
    resource=None,
    host=None,
    outcome="failure",
):
    return SecurityEvent(
        event_id=event_id,
        timestamp=datetime.now(timezone.utc),
        event_type=event_type,
        username=username,
        source_ip=source_ip,
        resource=resource,
        host=host,
        outcome=outcome,
        source="test",
        raw_hash="a" * 64,
        raw_record={},
    )


def test_brute_force_alert_has_high_confidence():
    events = [
        make_event(f"evt_{i}", "authentication_failure")
        for i in range(5)
    ]

    alert = {
        "rule_id": "DET-001",
        "event_ids": [event.event_id for event in events],
        "evidence": {
            "source_ip": "203.0.113.10",
            "username": "alice",
        },
    }

    result = assess_alert_confidence(alert, events)

    assert result["level"] == "high"


def test_missing_event_reference_reduces_confidence():
    events = [
        make_event(f"evt_{i}", "authentication_failure")
        for i in range(5)
    ]

    alert = {
        "rule_id": "DET-001",
        "event_ids": [event.event_id for event in events] + ["missing_id"],
        "evidence": {
            "source_ip": "203.0.113.10",
            "username": "alice",
        },
    }

    result = assess_alert_confidence(alert, events)

    assert result["level"] == "medium"


def test_unknown_rule_returns_low_confidence():
    result = assess_alert_confidence(
        {"rule_id": "UNKNOWN", "event_ids": [], "evidence": {}},
        [],
    )

    assert result["level"] == "low"


def test_telemetry_coverage_detects_present_dimensions():
    events = [
        make_event(
            "evt_1",
            "authentication_failure",
            host="workstation-01",
        ),
        make_event(
            "evt_2",
            "web_access",
            resource="/admin",
            host="web-server-01",
        ),
    ]

    result = assess_telemetry_coverage(events)

    assert result["coverage_ratio"] == 1.0
    assert result["dimensions_present"] == [
        "authentication",
        "web_access",
        "source_attribution",
        "host_context",
    ]
    assert result["dimensions_missing"] == []


def test_missing_telemetry_is_reported_not_assumed_benign():
    events = [
        make_event(
            "evt_1",
            "authentication_failure",
            host=None,
        )
    ]

    result = assess_telemetry_coverage(events)

    assert result["coverage_ratio"] == 0.5
    assert "web_access" in result["dimensions_missing"]
    assert "host_context" in result["dimensions_missing"]


def test_empty_dataset_has_zero_coverage():
    result = assess_telemetry_coverage([])

    assert result["coverage_ratio"] == 0
    assert len(result["dimensions_missing"]) == 4
