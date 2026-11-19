
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
    event_type="authentication_failure",
):
    return SecurityEvent(
        event_id=event_id,
        dataset_id="ds_test",
        timestamp=datetime.now(timezone.utc) + timedelta(minutes=minutes),
        event_type=event_type,
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


def make_request(tool, params, limit=10):
    return InvestigationRequest(
        tool=tool,
        params=params,
        idempotency_key="test-key-0001",
        limit=limit,
    )


def test_get_related_auth_events(sample_events):
    request = make_request(
        "get_related_auth_events",
        {"username": "alice"},
    )

    result = run_investigation(
        events=sample_events,
        request=request,
        known_event_ids={"evt_1"},
    )

    returned_ids = {
        event["event_id"] for event in result.retrieved_events
    }

    assert returned_ids == {"evt_2", "evt_5"}
    assert result.budget_remaining == 2
    assert result.budget_consumed == 1


def test_related_auth_events_is_case_insensitive(sample_events):
    request = make_request(
        "get_related_auth_events",
        {"username": "ALICE"},
    )

    result = run_investigation(sample_events, request)

    assert result.retrieved_count == 3


def test_get_related_auth_events_by_source_ip(sample_events):
    request = make_request(
        "get_related_auth_events",
        {"source_ip": "10.0.0.1"},
    )

    result = run_investigation(sample_events, request)

    returned_ids = {
        event["event_id"] for event in result.retrieved_events
    }

    assert returned_ids == {"evt_1", "evt_2"}


def test_get_post_login_activity(sample_events):
    after = sample_events[0].timestamp.isoformat()

    request = make_request(
        "get_post_login_activity",
        {
            "username": "alice",
            "after": after,
        },
    )

    result = run_investigation(sample_events, request)

    returned_ids = {
        event["event_id"] for event in result.retrieved_events
    }

    assert returned_ids == {"evt_2", "evt_5"}


def test_get_ip_context(sample_events):
    request = make_request(
        "get_ip_context",
        {"source_ip": "10.0.0.1"},
    )

    result = run_investigation(sample_events, request)

    returned_ids = {
        event["event_id"] for event in result.retrieved_events
    }

    assert returned_ids == {"evt_1", "evt_2"}


def test_investigation_budget_exhaustion(sample_events):
    request = make_request(
        "get_related_auth_events",
        {"username": "alice"},
    )

    with pytest.raises(ValueError, match="budget exhausted"):
        run_investigation(
            events=sample_events,
            request=request,
            budget_remaining=0,
        )


def test_missing_required_params_are_rejected(sample_events):
    request = make_request(
        "get_ip_context",
        {},
    )

    with pytest.raises(ValueError):
        run_investigation(sample_events, request)


def test_invalid_timestamp_is_rejected(sample_events):
    request = make_request(
        "get_post_login_activity",
        {
            "username": "alice",
            "after": "2026-11-19T12:00:00",
        },
    )

    with pytest.raises(ValueError):
        run_investigation(sample_events, request)


def test_result_respects_limit(sample_events):
    request = make_request(
        "get_related_auth_events",
        {"username": "alice"},
        limit=1,
    )

    result = run_investigation(sample_events, request)

    assert result.retrieved_count == 1
    assert len(result.evidence) == 1
    assert result.budget_remaining == MAX_INVESTIGATION_BUDGET - 1


def test_empty_search_still_consumes_budget(sample_events):
    request = make_request(
        "get_related_auth_events",
        {"username": "nobody"},
    )

    result = run_investigation(sample_events, request)

    assert result.retrieved_count == 0
    assert result.budget_remaining == 2
    assert result.budget_consumed == 1


def test_request_hash_is_returned(sample_events):
    request = make_request(
        "get_related_auth_events",
        {"username": "alice"},
    )

    result = run_investigation(sample_events, request)

    assert len(result.request_hash) == 64
    assert all(
        character in "0123456789abcdef"
        for character in result.request_hash
    )


def test_invalid_idempotency_key_is_rejected():
    with pytest.raises(ValueError):
        InvestigationRequest(
            tool="get_ip_context",
            params={"source_ip": "10.0.0.1"},
            idempotency_key="bad key!",
        )
