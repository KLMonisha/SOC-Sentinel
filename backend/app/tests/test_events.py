
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.models.events import SecurityEvent


def create_event():
    return SecurityEvent(
        event_id="evt_001",
        timestamp="2026-11-18T10:30:00Z",
        event_type="authentication_failure",
        username="alice",
        source_ip="192.0.2.10",
        outcome="failure",
        source="auth.csv",
        raw_hash="a" * 64,
        raw_record={
            "username": "alice",
            "event": "failed_login"
        }
    )


def test_valid_event():
    event = create_event()

    assert event.event_id == "evt_001"
    assert event.username == "alice"
    assert event.outcome == "failure"


def test_timestamp_is_utc():
    event = create_event()

    assert event.timestamp.tzinfo is not None
    assert event.timestamp.utcoffset().total_seconds() == 0


def test_invalid_outcome():
    with pytest.raises(ValidationError):
        SecurityEvent(
            event_id="evt_002",
            timestamp="2026-11-18T10:30:00Z",
            event_type="login",
            outcome="maybe",
            source="auth.csv",
            raw_hash="a" * 64
        )


def test_missing_timezone():
    with pytest.raises(ValidationError):
        SecurityEvent(
            event_id="evt_003",
            timestamp="2026-11-18T10:30:00",
            event_type="login",
            source="auth.csv",
            raw_hash="a" * 64
        )


def test_extra_fields_rejected():
    with pytest.raises(ValidationError):
        SecurityEvent(
            event_id="evt_004",
            timestamp="2026-11-18T10:30:00Z",
            event_type="login",
            source="auth.csv",
            raw_hash="a" * 64,
            unexpected_field="test"
        )
