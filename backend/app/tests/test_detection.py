
from datetime import datetime, timedelta, timezone

from app.models.events import SecurityEvent
from app.services.detection import (
    detect_brute_force,
    detect_success_after_failures,
    detect_suspicious_access,
    run_detection
)


BASE_TIME = datetime(2026, 11, 18, 10, 0, tzinfo=timezone.utc)


def make_event(
    index,
    event_type,
    minutes,
    username="alice",
    source_ip="192.168.1.10",
    resource="/admin",
    outcome="unknown"
):
    return SecurityEvent(
        event_id=f"evt_{index}",
        timestamp=BASE_TIME + timedelta(minutes=minutes),
        event_type=event_type,
        username=username,
        source_ip=source_ip,
        destination_ip=None,
        host="server-01",
        resource=resource,
        outcome=outcome,
        source="test_logs.csv",
        raw_hash=f"{index:064x}",
        raw_record={"test": index}
    )


def test_detect_brute_force():
    events = [
        make_event(i, "authentication_failure", i)
        for i in range(5)
    ]

    alerts = detect_brute_force(events)

    assert len(alerts) == 1
    assert alerts[0]["rule_id"] == "DET-001"
    assert alerts[0]["severity"] == "high"
    assert len(alerts[0]["event_ids"]) == 5


def test_no_brute_force_below_threshold():
    events = [
        make_event(i, "authentication_failure", i)
        for i in range(4)
    ]

    assert detect_brute_force(events) == []


def test_no_brute_force_outside_time_window():
    events = [
        make_event(i, "authentication_failure", i * 5)
        for i in range(5)
    ]

    assert detect_brute_force(events) == []


def test_detect_success_after_failures():
    events = [
        make_event(i, "authentication_failure", i)
        for i in range(3)
    ]

    events.append(
        make_event(
            4,
            "authentication_success",
            5,
            outcome="success"
        )
    )

    alerts = detect_success_after_failures(events)

    assert len(alerts) == 1
    assert alerts[0]["rule_id"] == "DET-002"
    assert alerts[0]["severity"] == "critical"
    assert len(alerts[0]["event_ids"]) == 4


def test_no_success_after_failures_without_success():
    events = [
        make_event(i, "authentication_failure", i)
        for i in range(5)
    ]

    assert detect_success_after_failures(events) == []


def test_detect_suspicious_access():
    events = [
        make_event(
            i,
            "web_access",
            i,
            outcome="failure"
        )
        for i in range(5)
    ]

    alerts = detect_suspicious_access(events)

    assert len(alerts) == 1
    assert alerts[0]["rule_id"] == "DET-003"
    assert alerts[0]["severity"] == "medium"
    assert len(alerts[0]["event_ids"]) == 5


def test_no_suspicious_access_below_threshold():
    events = [
        make_event(
            i,
            "web_access",
            i,
            outcome="failure"
        )
        for i in range(4)
    ]

    assert detect_suspicious_access(events) == []


def test_run_detection_combines_rules():
    events = [
        make_event(i, "authentication_failure", i)
        for i in range(5)
    ]

    events.extend([
        make_event(
            i + 10,
            "web_access",
            i,
            outcome="failure"
        )
        for i in range(5)
    ])

    alerts = run_detection(events)

    rule_ids = {alert["rule_id"] for alert in alerts}

    assert "DET-001" in rule_ids
    assert "DET-003" in rule_ids


def test_alert_contains_traceable_event_ids():
    events = [
        make_event(i, "authentication_failure", i)
        for i in range(5)
    ]

    alert = detect_brute_force(events)[0]

    assert all(event_id.startswith("evt_") for event_id in alert["event_ids"])
    assert alert["evidence"]["source_ip"] == "192.168.1.10"
