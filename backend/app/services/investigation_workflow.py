
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
    """
    Coordinate one bounded investigation step.

    1. Validate the initial investigation evidence.
    2. Retrieve additional evidence.
    3. Re-evaluate detection and correlation when evidence is found.
    4. Return the updated investigation and remaining budget.

    This function does not persist case state. The caller must
    persist the budget and investigation history between requests.
    """

    if not initial_event_ids:
        raise ValueError("At least one initial event ID is required.")

    if len(set(initial_event_ids)) != len(initial_event_ids):
        raise ValueError("Duplicate initial event IDs are not allowed.")

    event_lookup = {
        event.event_id: event
        for event in events
    }

    unknown_initial_ids = [
        event_id
        for event_id in initial_event_ids
        if event_id not in event_lookup
    ]

    if unknown_initial_ids:
        raise ValueError(
            f"Unknown initial event IDs: {unknown_initial_ids}"
        )

    # Related-event searches must start from this investigation's evidence.
    if request.tool == "expand_related_events":
        if not set(request.seed_event_ids).issubset(
            set(initial_event_ids)
        ):
            raise ValueError(
                "Seed event IDs must belong to the initial investigation."
            )

    # Step 1: Retrieve additional evidence.
    planner_result = run_investigation(
        events=events,
        request=request,
        known_event_ids=set(initial_event_ids),
        budget_remaining=budget_remaining,
    )

    retrieved_ids = [
        item.event_id
        for item in planner_result.evidence
    ]

    # Step 2: If nothing was found, return without re-evaluation.
    if not retrieved_ids:
        return {
            "status": "completed_no_new_evidence",
            "planner": planner_result.model_dump(mode="json"),
            "reevaluation": None,
            "budget_remaining": planner_result.budget_remaining,
            "budget_consumed": planner_result.budget_consumed,
            "original_data_modified": False,
        }

    # Step 3: Re-run detection and correlation with expanded evidence.
    reevaluation = reevaluate_investigation(
        events=events,
        initial_event_ids=initial_event_ids,
        retrieved_event_ids=retrieved_ids,
    )

    return {
        "status": "completed",
        "planner": planner_result.model_dump(mode="json"),
        "reevaluation": reevaluation,
        "budget_remaining": planner_result.budget_remaining,
        "budget_consumed": planner_result.budget_consumed,
        "original_data_modified": False,
    }
