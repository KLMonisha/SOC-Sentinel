
from datetime import datetime, timedelta, timezone

from app.models.events import SecurityEvent
from app.services.correlation import (
    calculate_risk_score,
    correlate_alerts
)


BASE_TIME = datetime(2026, 11, 18, 10, 0, tzinfo=timezone.utc)


def make_event(event_id, minutes, source_ip="192.168.1.10"):
    return SecurityEvent(
        event_id=event_id,
        timestamp=BASE_TIME + timedelta(minutes=minutes),
        event_type="authentication_failure",
        username="alice",
        source_ip=source_ip,
        destination_ip=None,
        host="server-01",
        resource="/admin",
        outcome="failure",
        source="test_logs.csv",
        raw_hash="a" * 64,
        raw_record={"test": event_id}
    )


def make_alert(
    alert_id,
    rule_id,
    severity,
    event_ids,
    source_ip="192.168.1.10"
):
    return {
        "alert_id": alert_id,
        "rule_id": rule_id,
        "title": "Test alert",
        "severity": severity,
        "description": "Test description",
        "event_ids": event_ids,
        "evidence": {
            "source_ip": source_ip
        }
    }


def test_correlate_alerts_with_same_ip():
    events = [
        make_event("evt_1", 0),
        make_event("evt_2", 5)
    ]

    alerts = [
        make_alert("alert_1", "DET-001", "high", ["evt_1"]),
        make_alert("alert_2", "DET-002", "critical", ["evt_2"])
    ]

    incidents = correlate_alerts(alerts, events)

    assert len(incidents) == 1
    assert incidents[0]["alert_count"] == 2


def test_different_ips_create_separate_incidents():
    events = [
        make_event("evt_1", 0, "192.168.1.10"),
        make_event("evt_2", 5, "192.168.1.20")
    ]

    alerts = [
        make_alert(
            "alert_1", "DET-001", "high", ["evt_1"],
            "192.168.1.10"
        ),
        make_alert(
            "alert_2", "DET-001", "high", ["evt_2"],
            "192.168.1.20"
        )
    ]

    incidents = correlate_alerts(alerts, events)

    assert len(incidents) == 2


def test_alerts_outside_window_create_separate_incidents():
    events = [
        make_event("evt_1", 0),
        make_event("evt_2", 45)
    ]

    alerts = [
        make_alert("alert_1", "DET-001", "high", ["evt_1"]),
        make_alert("alert_2", "DET-002", "high", ["evt_2"])
    ]

    incidents = correlate_alerts(alerts, events, window_minutes=30)

    assert len(incidents) == 2


def test_incident_contains_traceable_ids():
    events = [
        make_event("evt_1", 0),
        make_event("evt_2", 5)
    ]

    alerts = [
        make_alert("alert_1", "DET-001", "high", ["evt_1"]),
        make_alert("alert_2", "DET-002", "critical", ["evt_2"])
    ]

    incident = correlate_alerts(alerts, events)[0]

    assert set(incident["alert_ids"]) == {"alert_1", "alert_2"}
    assert set(incident["event_ids"]) == {"evt_1", "evt_2"}


def test_critical_alert_produces_high_risk_score():
    alerts = [
        make_alert("alert_1", "DET-002", "critical", ["evt_1"])
    ]

    result = calculate_risk_score(alerts)

    assert result["score"] == 82
    assert result["severity"] == "critical"


def test_multiple_rules_increase_risk_score():
    one_rule = [
        make_alert("alert_1", "DET-001", "high", ["evt_1"])
    ]

    two_rules = [
        make_alert("alert_1", "DET-001", "high", ["evt_1"]),
        make_alert("alert_2", "DET-002", "high", ["evt_2"])
    ]

    first_score = calculate_risk_score(one_rule)["score"]
    second_score = calculate_risk_score(two_rules)["score"]

    assert second_score > first_score


def test_risk_score_never_exceeds_100():
    alerts = [
        make_alert(
            f"alert_{i}",
            f"DET-{i:03}",
            "critical",
            [f"evt_{i}"]
        )
        for i in range(20)
    ]

    result = calculate_risk_score(alerts)

    assert result["score"] <= 100


def test_empty_alerts_return_zero_score():
    result = calculate_risk_score([])

    assert result["score"] == 0
    assert result["severity"] == "low"


def test_incident_ids_are_deterministic():
    events = [make_event("evt_1", 0)]
    alerts = [
        make_alert("alert_1", "DET-001", "high", ["evt_1"])
    ]

    first = correlate_alerts(alerts, events)
    second = correlate_alerts(alerts, events)

    assert first[0]["incident_id"] == second[0]["incident_id"]
