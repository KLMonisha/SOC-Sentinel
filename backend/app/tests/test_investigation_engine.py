
import pytest

from datetime import datetime, timedelta, timezone

from app.models.events import SecurityEvent
from app.services.investigation_engine import reevaluate_investigation


def make_event(event_id, minutes):
    return SecurityEvent(
        event_id=event_id,
        timestamp=datetime.now(timezone.utc) + timedelta(minutes=minutes),
        event_type="authentication_failure",
        username="alice",
        source_ip="203.0.113.45",
        outcome="failure",
        source="test.csv",
        raw_hash="a" * 64,
        raw_record={},
    )


@pytest.fixture
def sample_events():
    return [
        make_event("evt_1", 0),
        make_event("evt_2", 1),
        make_event("evt_3", 2),
        make_event("evt_4", 3),
        make_event("evt_5", 4),
    ]


def test_retrieved_event_changes_detection(sample_events):
    result = reevaluate_investigation(
        events=sample_events,
        initial_event_ids=[
            "evt_1", "evt_2", "evt_3", "evt_4"
        ],
        retrieved_event_ids=["evt_5"],
    )

    assert result["original"]["alerts"] == []
    assert len(result["updated"]["alerts"]) >= 1
    assert result["comparison"]["added_alert_ids"]
    assert result["original_data_modified"] is False


def test_expanded_context_contains_retrieved_events(sample_events):
    result = reevaluate_investigation(
        events=sample_events,
        initial_event_ids=[
            "evt_1", "evt_2", "evt_3", "evt_4"
        ],
        retrieved_event_ids=["evt_5"],
    )

    assert result["expanded_event_count"] == 5
    assert result["retrieved_event_count"] == 1


def test_retrieved_event_is_classified_as_supporting(sample_events):
    result = reevaluate_investigation(
        events=sample_events,
        initial_event_ids=[
            "evt_1", "evt_2", "evt_3", "evt_4"
        ],
        retrieved_event_ids=["evt_5"],
    )

    evidence = result["retrieved_evidence"]

    assert evidence[0]["event_id"] == "evt_5"
    assert evidence[0]["classification"] == "supporting"


def test_initial_events_are_required(sample_events):
    with pytest.raises(ValueError, match="initial event ID"):
        reevaluate_investigation(
            events=sample_events,
            initial_event_ids=[],
            retrieved_event_ids=["evt_5"],
        )


def test_retrieved_events_are_required(sample_events):
    with pytest.raises(ValueError, match="retrieved event ID"):
        reevaluate_investigation(
            events=sample_events,
            initial_event_ids=["evt_1"],
            retrieved_event_ids=[],
        )


def test_unknown_event_is_rejected(sample_events):
    with pytest.raises(ValueError, match="Unknown event IDs"):
        reevaluate_investigation(
            events=sample_events,
            initial_event_ids=["evt_1"],
            retrieved_event_ids=["does_not_exist"],
        )


def test_duplicate_event_ids_are_rejected(sample_events):
    with pytest.raises(ValueError, match="Duplicate initial"):
        reevaluate_investigation(
            events=sample_events,
            initial_event_ids=["evt_1", "evt_1"],
            retrieved_event_ids=["evt_5"],
        )


def test_overlap_between_initial_and_retrieved_is_rejected(sample_events):
    with pytest.raises(ValueError, match="already exist"):
        reevaluate_investigation(
            events=sample_events,
            initial_event_ids=["evt_1"],
            retrieved_event_ids=["evt_1"],
        )
