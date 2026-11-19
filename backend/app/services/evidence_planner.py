
from datetime import datetime
from typing import Any

from app.models.events import SecurityEvent
from app.models.investigation import (
    InvestigationRequest,
    InvestigationResult,
    RetrievedEvidence,
)


MAX_INVESTIGATION_BUDGET = 3


def _entity_value(event: SecurityEvent, field: str) -> str | None:
    value = getattr(event, field, None)

    if value is None:
        return None

    value = str(value).strip()
    return value or None


def _parse_aware_datetime(value: str, field_name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        raise ValueError(f"{field_name} must be a valid ISO-8601 timestamp.")

    if parsed.tzinfo is None:
        raise ValueError(f"{field_name} must include timezone information.")

    return parsed


def _event_to_dict(event: SecurityEvent) -> dict[str, Any]:
    return event.model_dump(mode="json")


def _shared_entities(
    first: SecurityEvent,
    second: SecurityEvent
) -> list[str]:
    fields = [
        "username",
        "source_ip",
        "destination_ip",
        "host",
        "resource",
    ]

    shared = []

    for field in fields:
        first_value = _entity_value(first, field)
        second_value = _entity_value(second, field)

        if (
            first_value
            and second_value
            and first_value.casefold() == second_value.casefold()
        ):
            shared.append(field)

    return shared


def run_investigation(
    events: list[SecurityEvent],
    request: InvestigationRequest,
    known_event_ids: set[str] | None = None,
    budget_remaining: int = MAX_INVESTIGATION_BUDGET,
) -> InvestigationResult:
    """
    Retrieve additional evidence from an existing dataset.

    Each successful investigation call consumes one budget unit.
    This service never modifies the original events.
    """

    if budget_remaining < 0:
        raise ValueError("Investigation budget cannot be negative.")

    if budget_remaining == 0:
        raise ValueError("Investigation budget exhausted.")

    if not events:
        raise ValueError("No events are available to investigate.")

    known_event_ids = known_event_ids or set()

    # Build a lookup of events that actually exist in this dataset.
    event_lookup = {event.event_id: event for event in events}

    candidates: list[tuple[SecurityEvent, int, str]] = []

    # TOOL 1: Search by a specific entity.
    if request.tool == "search_by_entity":

        if not request.entity_type or not request.entity_value:
            raise ValueError(
                "entity_type and entity_value are required "
                "for search_by_entity."
            )

        search_value = request.entity_value.strip()

        if not search_value:
            raise ValueError("entity_value cannot be empty.")

        for event in events:
            if event.event_id in known_event_ids:
                continue

            value = _entity_value(event, request.entity_type)

            if value and value.casefold() == search_value.casefold():
                candidates.append((
                    event,
                    100,
                    f"Exact match on {request.entity_type}."
                ))

    # TOOL 2: Search within a specified time window.
    elif request.tool == "search_time_window":

        if not request.start_time or not request.end_time:
            raise ValueError(
                "start_time and end_time are required "
                "for search_time_window."
            )

        start = _parse_aware_datetime(
            request.start_time,
            "start_time"
        )
        end = _parse_aware_datetime(
            request.end_time,
            "end_time"
        )

        if start > end:
            raise ValueError("start_time cannot be after end_time.")

        for event in events:
            if event.event_id in known_event_ids:
                continue

            if start <= event.timestamp <= end:
                candidates.append((
                    event,
                    70,
                    "Event occurred within the requested time window."
                ))

    # TOOL 3: Expand the investigation using shared entities.
    elif request.tool == "expand_related_events":

        if not request.seed_event_ids:
            raise ValueError(
                "At least one seed event ID is required."
            )

        unknown_ids = [
            event_id
            for event_id in request.seed_event_ids
            if event_id not in event_lookup
        ]

        if unknown_ids:
            raise ValueError(
                f"Unknown seed event IDs: {unknown_ids}"
            )

        seeds = [
            event_lookup[event_id]
            for event_id in request.seed_event_ids
        ]

        for event in events:
            if event.event_id in known_event_ids:
                continue

            if event.event_id in request.seed_event_ids:
                continue

            matching_fields = set()

            for seed in seeds:
                matching_fields.update(
                    _shared_entities(event, seed)
                )

            if matching_fields:
                ordered_fields = sorted(matching_fields)
                score = min(100, len(ordered_fields) * 25)

                candidates.append((
                    event,
                    score,
                    "Shares " + ", ".join(ordered_fields)
                    + " with the seed evidence."
                ))

    # Rank by relevance, then by timestamp.
    candidates.sort(
        key=lambda item: (
            -item[1],
            item[0].timestamp,
            item[0].event_id
        )
    )

    selected = candidates[:request.limit]

    evidence = [
        RetrievedEvidence(
            event_id=event.event_id,
            relevance_score=score,
            match_reason=reason,
        )
        for event, score, reason in selected
    ]

    retrieved_events = [
        _event_to_dict(event)
        for event, _, _ in selected
    ]

    return InvestigationResult(
        tool=request.tool,
        retrieved_events=retrieved_events,
        evidence=evidence,
        retrieved_count=len(selected),
        budget_remaining=budget_remaining - 1,
        budget_consumed=1,
        message=(
            f"Retrieved {len(selected)} additional event(s)."
            if selected
            else "No additional matching events were found."
        ),
    )
