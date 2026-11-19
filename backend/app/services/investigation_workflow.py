from app.models.events import SecurityEvent
from app.models.investigation import InvestigationRequest
from app.services.evidence_planner import (
    MAX_INVESTIGATION_BUDGET,
    run_investigation,
)
from app.services.investigation_engine import reevaluate_investigation


def investigate_incident(
    events: list[SecurityEvent],
    initial_event_ids: list[str],
    request: InvestigationRequest,
    budget_remaining: int = MAX_INVESTIGATION_BUDGET,
) -> dict:

    if not initial_event_ids:
        raise ValueError("At least one initial event ID is required.")

    if len(set(initial_event_ids)) != len(initial_event_ids):
        raise ValueError("Duplicate initial event IDs are not allowed.")

    event_lookup = {event.event_id: event for event in events}

    unknown = [
        event_id for event_id in initial_event_ids
        if event_id not in event_lookup
    ]
    if unknown:
        raise ValueError(f"Unknown initial event IDs: {unknown}")

    initial_events = [event_lookup[event_id] for event_id in initial_event_ids]

    # Scope the investigation to the same dataset as the original case.
    dataset_ids = {event.dataset_id for event in initial_events}
    if len(dataset_ids) != 1:
        raise ValueError("Initial evidence must belong to one dataset.")

    dataset_id = next(iter(dataset_ids))
    scoped_events = [
        event for event in events
        if event.dataset_id == dataset_id
    ]

    planner = run_investigation(
        events=scoped_events,
        request=request,
        known_event_ids=set(initial_event_ids),
        budget_remaining=budget_remaining,
    )

    retrieved_ids = [item.event_id for item in planner.evidence]

    if not retrieved_ids:
        return {
            "status": "completed_no_new_evidence",
            "planner": planner.model_dump(mode="json"),
            "reevaluation": None,
            "budget_remaining": planner.budget_remaining,
            "budget_consumed": planner.budget_consumed,
            "request_hash": planner.request_hash,
            "original_data_modified": False,
        }

    reevaluation = reevaluate_investigation(
        events=scoped_events,
        initial_event_ids=initial_event_ids,
        retrieved_event_ids=retrieved_ids,
    )

    return {
        "status": "completed",
        "planner": planner.model_dump(mode="json"),
        "reevaluation": reevaluation,
        "budget_remaining": planner.budget_remaining,
        "budget_consumed": planner.budget_consumed,
        "request_hash": planner.request_hash,
        "original_data_modified": False,
    }