
import pytest

from datetime import datetime, timedelta, timezone

from app.models.events import SecurityEvent
from app.models.investigation import InvestigationRequest
from app.services.evidence_planner import (
    run_investigation,
    MAX_INVESTIGATION_BUDGET,
)


def make_event(
    event_id,
    username=None,
    source_ip=None,
    host=None,
    resource=None,
    minutes=0,
):
    return SecurityEvent(
        event_id=event_id,
        dataset_id="ds_test",
        timestamp=datetime.now(timezone.utc) + timedelta(minutes=minutes),
        event_type="authentication_failure",
        username=username,
        source_ip=source_ip,
        host=host,
        resource=resource,
        outcome="failure",
        source="test.csv",
        line_number=minutes + 1,
        raw_text=f'{{"event_id":"{event_id}"}}',
        raw_hash="a" * 64,
        raw_record={},
    )


@pytest.fixture
def sample_events():
    return [
        make_event("evt_1", username="alice", source_ip="10.0.0.1", minutes=0),
        make_event("evt_2", username="alice", source_ip="10.0.0.1", minutes=2),
        make_event("evt_3", username="bob", source_ip="10.0.0.2", minutes=5),
        make_event("evt_4", username="charlie", source_ip="10.0.0.3", minutes=10),
        make_event("evt_5", username="alice", source_ip="10.0.0.4", minutes=15),
    ]


def test_search_by_entity(sample_events):
    request = InvestigationRequest(
        tool="search_by_entity",
        entity_type="username",
        entity_value="alice",
    )

    result = run_investigation(
        events=sample_events,
        request=request,
        known_event_ids={"evt_1"},
    )

    returned_ids = {event["event_id"] for event in result.retrieved_events}

    assert returned_ids == {"evt_2", "evt_5"}
    assert result.budget_remaining == 2
    assert result.budget_consumed == 1


def test_search_by_entity_is_case_insensitive(sample_events):
    request = InvestigationRequest(
        tool="search_by_entity",
        entity_type="username",
        entity_value="ALICE",
    )

    result = run_investigation(sample_events, request)

    assert result.retrieved_count == 3


def test_search_time_window(sample_events):
    start = sample_events[1].timestamp.isoformat()
    end = sample_events[2].timestamp.isoformat()

    request = InvestigationRequest(
        tool="search_time_window",
        start_time=start,
        end_time=end,
    )

    result = run_investigation(events=sample_events, request=request)

    returned_ids = {event["event_id"] for event in result.retrieved_events}

    assert returned_ids == {"evt_2", "evt_3"}


def test_expand_related_events(sample_events):
    request = InvestigationRequest(
        tool="expand_related_events",
        seed_event_ids=["evt_1"],
    )

    result = run_investigation(
        events=sample_events,
        request=request,
        known_event_ids={"evt_1"},
    )

    returned_ids = {event["event_id"] for event in result.retrieved_events}

    assert "evt_2" in returned_ids
    assert "evt_3" not in returned_ids


def test_investigation_budget_exhaustion(sample_events):
    request = InvestigationRequest(
        tool="search_by_entity",
        entity_type="username",
        entity_value="alice",
    )

    with pytest.raises(ValueError, match="budget exhausted"):
        run_investigation(
            events=sample_events,
            request=request,
            budget_remaining=0,
        )


def test_unknown_seed_event_is_rejected(sample_events):
    request = InvestigationRequest(
        tool="expand_related_events",
        seed_event_ids=["unknown_event"],
    )

    with pytest.raises(ValueError, match="Unknown seed event IDs"):
        run_investigation(sample_events, request)


def test_invalid_time_range_is_rejected(sample_events):
    request = InvestigationRequest(
        tool="search_time_window",
        start_time="2026-11-20T12:00:00+00:00",
        end_time="2026-11-19T12:00:00+00:00",
    )

    with pytest.raises(ValueError, match="cannot be after"):
        run_investigation(sample_events, request)


def test_result_respects_limit(sample_events):
    request = InvestigationRequest(
        tool="search_by_entity",
        entity_type="username",
        entity_value="alice",
        limit=1,
    )

    result = run_investigation(sample_events, request)

    assert result.retrieved_count == 1
    assert len(result.evidence) == 1
    assert result.budget_remaining == MAX_INVESTIGATION_BUDGET - 1


def test_empty_search_still_consumes_budget(sample_events):
    request = InvestigationRequest(
        tool="search_by_entity",
        entity_type="username",
        entity_value="nobody",
    )

    result = run_investigation(sample_events, request)

    assert result.retrieved_count == 0
    assert result.budget_remaining == 2
    assert result.budget_consumed == 1
