from datetime import datetime, timedelta, timezone

import pytest

from app.models.events import SecurityEvent
from app.services.counterfactual import run_counterfactual


def create_test_events():
    """Create five failed login events from the same IP and user."""

    events = []

    base_time = datetime(2026, 11, 18, 10, 0, tzinfo=timezone.utc)

    for i in range(5):
        events.append(
            SecurityEvent(
                event_id=f"evt_{i}",
                timestamp=base_time + timedelta(minutes=i),
                event_type="authentication_failure",
                username="alice",
                source_ip="203.0.113.45",
                outcome="failure",
                source="test",
                raw_hash=str(i) * 64,
                raw_record={"test": True}
            )
        )

    return events


def test_counterfactual_recomputes_detection():
    events = create_test_events()

    result = run_counterfactual(
        events=events,
        event_ids_to_exclude=["evt_0"],
        reason="Testing whether one failed login changes the finding."
    )

    assert result["original"]["event_count"] == 5
    assert result["hypothetical"]["event_count"] == 4

    assert len(result["original"]["alerts"]) == 1
    assert len(result["hypothetical"]["alerts"]) == 0

    assert result["comparison"]["original_max_risk_score"] > 0
    assert result["comparison"]["hypothetical_max_risk_score"] == 0


def test_original_events_are_not_modified():
    events = create_test_events()

    original_ids = [
        event.event_id for event in events
    ]

    run_counterfactual(
        events=events,
        event_ids_to_exclude=["evt_0"],
        reason="Check original event preservation."
    )

    assert len(events) == 5

    assert [
        event.event_id for event in events
    ] == original_ids


def test_unknown_event_id_is_rejected():
    events = create_test_events()

    with pytest.raises(ValueError, match="Unknown event IDs"):
        run_counterfactual(
            events=events,
            event_ids_to_exclude=["does_not_exist"],
            reason="Testing invalid event ID."
        )


def test_cannot_exclude_all_events():
    events = create_test_events()

    with pytest.raises(ValueError, match="Cannot exclude all"):
        run_counterfactual(
            events=events,
            event_ids_to_exclude=[
                event.event_id for event in events
            ],
            reason="Testing complete exclusion."
        )


def test_empty_reason_is_rejected():
    events = create_test_events()

    with pytest.raises(ValueError, match="reason"):
        run_counterfactual(
            events=events,
            event_ids_to_exclude=["evt_0"],
            reason="   "
        )


def test_empty_exclusion_list_is_rejected():
    events = create_test_events()

    with pytest.raises(ValueError, match="At least one event"):
        run_counterfactual(
            events=events,
            event_ids_to_exclude=[],
            reason="Testing empty exclusion."
        )

def test_per_incident_risk_comparison():
    events = create_test_events()

    result = run_counterfactual(
        events=events,
        event_ids_to_exclude=["evt_0"],
        reason="Testing per-incident risk changes."
    )

    changes = result["comparison"]["per_incident_changes"]

    assert len(changes) == 1

    assert changes[0]["change_type"] == "removed"
    assert changes[0]["original_risk_score"] > 0
    assert changes[0]["hypothetical_risk_score"] == 0
    assert changes[0]["risk_score_change"] < 0