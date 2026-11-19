
import pytest

from datetime import datetime, timedelta, timezone

from app.models.events import SecurityEvent
from app.models.investigation import InvestigationRequest
from app.services.investigation_workflow import investigate_incident


@pytest.fixture
def sample_events():
    base_time = datetime.now(timezone.utc)

    return [
        SecurityEvent(
            event_id=f"evt_{i}",
            dataset_id="ds_test",
            timestamp=base_time + timedelta(minutes=i),
            event_type="authentication_failure",
            username="alice",
            source_ip="203.0.113.45",
            outcome="failure",
            source="test.csv",
            line_number=i,
            raw_text=f'{{"event_id":"evt_{i}"}}',
            raw_hash="a" * 64,
            raw_record={},
        )
        for i in range(1, 6)
    ]


def make_request(username="alice"):
    return InvestigationRequest(
        tool="get_related_auth_events",
        params={"username": username},
        idempotency_key="workflow-test-001",
    )


def test_workflow_retrieves_and_reevaluates(sample_events):
    request = make_request()

    result = investigate_incident(
        events=sample_events,
        initial_event_ids=["evt_1", "evt_2", "evt_3", "evt_4"],
        request=request,
    )

    assert result["status"] == "completed"
    assert result["planner"]["retrieved_count"] == 1
    assert result["reevaluation"] is not None
    assert result["budget_remaining"] == 2
    assert result["original_data_modified"] is False
    assert len(result["request_hash"]) == 64


def test_workflow_handles_no_new_evidence(sample_events):
    request = make_request("nobody")

    result = investigate_incident(
        events=sample_events,
        initial_event_ids=["evt_1"],
        request=request,
    )

    assert result["status"] == "completed_no_new_evidence"
    assert result["reevaluation"] is None
    assert result["budget_remaining"] == 2
    assert result["original_data_modified"] is False


def test_workflow_rejects_unknown_initial_event(sample_events):
    request = make_request()

    with pytest.raises(ValueError, match="Unknown initial event IDs"):
        investigate_incident(
            events=sample_events,
            initial_event_ids=["unknown"],
            request=request,
        )


def test_workflow_rejects_duplicate_initial_ids(sample_events):
    request = make_request()

    with pytest.raises(ValueError, match="Duplicate initial"):
        investigate_incident(
            events=sample_events,
            initial_event_ids=["evt_1", "evt_1"],
            request=request,
        )


def test_workflow_rejects_exhausted_budget(sample_events):
    request = make_request()

    with pytest.raises(ValueError, match="budget exhausted"):
        investigate_incident(
            events=sample_events,
            initial_event_ids=["evt_1"],
            request=request,
            budget_remaining=0,
        )


def test_workflow_rejects_empty_initial_event_ids(sample_events):
    request = make_request()

    with pytest.raises(ValueError):
        investigate_incident(
            events=sample_events,
            initial_event_ids=[],
            request=request,
        )


def test_workflow_does_not_modify_original_events(sample_events):
    request = make_request()

    original_ids = [event.event_id for event in sample_events]

    investigate_incident(
        events=sample_events,
        initial_event_ids=["evt_1", "evt_2", "evt_3", "evt_4"],
        request=request,
    )

    assert [event.event_id for event in sample_events] == original_ids
