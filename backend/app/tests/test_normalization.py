
import json

import pytest

from app.services.normalization import (
    normalize_record,
    normalize_event_type,
)


DATASET_ID = "ds_test"


def normalize_test_record(record, source, row_index):
    raw_text = json.dumps(
        record,
        ensure_ascii=False,
        separators=(",", ":"),
    )

    return normalize_record(
        record=record,
        source=source,
        row_index=row_index + 1,
        dataset_id=DATASET_ID,
        raw_text=raw_text,
    )


def test_authentication_log_normalization():
    record = {
        "timestamp": "2026-11-18T10:00:00Z",
        "username": "alice",
        "ip": "192.0.2.10",
        "event": "failed_login",
        "host": "server-01",
    }

    event = normalize_test_record(record, "auth_logs.csv", 0)

    assert event.username == "alice"
    assert event.source_ip == "192.0.2.10"
    assert event.event_type == "authentication_failure"
    assert event.outcome == "failure"
    assert event.dataset_id == DATASET_ID
    assert event.line_number == 1


def test_web_log_normalization():
    record = {
        "time": "2026-11-18T10:03:00Z",
        "user": "alice",
        "source_ip": "192.0.2.10",
        "path": "/admin",
        "status": 403,
        "host": "web-01",
    }

    event = normalize_test_record(record, "web_logs.json", 0)

    assert event.username == "alice"
    assert event.resource == "/admin"
    assert event.event_type == "web_access"
    assert event.outcome == "failure"


def test_event_id_is_deterministic():
    record = {
        "timestamp": "2026-11-18T10:00:00Z",
        "username": "alice",
        "ip": "192.0.2.10",
        "event": "failed_login",
    }

    event1 = normalize_test_record(record, "auth.csv", 0)
    event2 = normalize_test_record(record, "auth.csv", 0)

    assert event1.event_id == event2.event_id


def test_different_rows_have_different_ids():
    record = {
        "timestamp": "2026-11-18T10:00:00Z",
        "username": "alice",
        "ip": "192.0.2.10",
        "event": "failed_login",
    }

    event1 = normalize_test_record(record, "auth.csv", 0)
    event2 = normalize_test_record(record, "auth.csv", 1)

    assert event1.event_id != event2.event_id


def test_raw_hash_is_generated():
    record = {
        "timestamp": "2026-11-18T10:00:00Z",
        "username": "alice",
        "ip": "192.0.2.10",
        "event": "failed_login",
    }

    event = normalize_test_record(record, "auth.csv", 0)

    assert len(event.raw_hash) == 64
    assert event.raw_hash == event.raw_hash.lower()


def test_missing_timestamp_is_rejected():
    record = {
        "username": "alice",
        "event": "failed_login",
    }

    with pytest.raises(ValueError):
        normalize_test_record(record, "auth.csv", 0)


def test_timezone_missing_is_rejected():
    record = {
        "timestamp": "2026-11-18T10:00:00",
        "username": "alice",
        "event": "failed_login",
    }

    with pytest.raises(ValueError):
        normalize_test_record(record, "auth.csv", 0)


def test_web_access_preserves_explicit_failure():
    record = {
        "event_type": "web_access",
        "outcome": "failure",
    }

    assert normalize_event_type(record) == ("web_access", "failure")


def test_web_access_preserves_explicit_success():
    record = {
        "event_type": "web_access",
        "outcome": "success",
    }

    assert normalize_event_type(record) == ("web_access", "success")


def test_unknown_event_preserves_explicit_outcome():
    record = {
        "event_type": "custom_event",
        "outcome": "failure",
    }

    assert normalize_event_type(record) == ("custom_event", "failure")


def test_unknown_event_without_outcome_remains_unknown():
    record = {
        "event_type": "custom_event",
    }

    assert normalize_event_type(record) == ("custom_event", "unknown")


def test_invalid_explicit_outcome_is_rejected():
    record = {
        "event_type": "web_access",
        "outcome": "maybe",
    }

    with pytest.raises(ValueError, match="Invalid outcome"):
        normalize_event_type(record)
