
import hashlib
import json
from datetime import datetime
from typing import Any

from app.models.events import SecurityEvent
from app.models.investigation import (
    InvestigationRequest,
    InvestigationResult,
    RetrievedEvidence,
)


MAX_INVESTIGATION_BUDGET = 3


def _value(event: SecurityEvent, field: str) -> str | None:
    result = getattr(event, field, None)
    if result is None:
        return None
    result = str(result).strip()
    return result or None


def _matches(value: str | None, expected: str | None) -> bool:
    if value is None or expected is None:
        return False
    return value.casefold() == expected.strip().casefold()


def _request_hash(tool: str, params: dict[str, str]) -> str:
    canonical = json.dumps(
        {"tool": tool, "params": params},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _parse_time(value: str, name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be a valid ISO-8601 timestamp.") from exc

    if parsed.tzinfo is None:
        raise ValueError(f"{name} must include timezone information.")

    return parsed


def _event_dict(event: SecurityEvent) -> dict[str, Any]:
    return event.model_dump(mode="json")


def _add_candidate(
    candidates: list,
    event: SecurityEvent,
    score: int,
    reason: str,
    known_ids: set[str],
):
    if event.event_id not in known_ids:
        candidates.append((event, score, reason))


def run_investigation(
    events: list[SecurityEvent],
    request: InvestigationRequest,
    known_event_ids: set[str] | None = None,
    budget_remaining: int = MAX_INVESTIGATION_BUDGET,
) -> InvestigationResult:

    if budget_remaining < 0:
        raise ValueError("Investigation budget cannot be negative.")
    if budget_remaining == 0:
        raise ValueError("Investigation budget exhausted.")
    if not events:
        raise ValueError("No events are available to investigate.")

    known_ids = known_event_ids or set()
    params = request.params
    candidates = []

    if request.tool == "get_related_auth_events":
        username = params.get("username")
        source_ip = params.get("source_ip")

        if not username and not source_ip:
            raise ValueError(
                "get_related_auth_events requires username or source_ip."
            )

        for event in events:
            if event.event_type not in {
                "authentication_failure",
                "authentication_success",
            }:
                continue

            username_match = _matches(
                _value(event, "username"),
                username,
            )
            ip_match = _matches(
                _value(event, "source_ip"),
                source_ip,
            )

            # If both are supplied, require both to match.
            matches = (
                username_match and ip_match
                if username and source_ip
                else username_match or ip_match
            )

            if matches:
                _add_candidate(
                    candidates,
                    event,
                    100,
                    "Related authentication event matched the supplied identity context.",
                    known_ids,
                )

    elif request.tool == "get_post_login_activity":
        username = params.get("username")
        source_ip = params.get("source_ip")
        after_value = params.get("after")

        if not username and not source_ip:
            raise ValueError(
                "get_post_login_activity requires username or source_ip."
            )
        if not after_value:
            raise ValueError(
                "get_post_login_activity requires an ISO-8601 'after' timestamp."
            )

        after = _parse_time(after_value, "after")

        for event in events:
            if event.timestamp <= after:
                continue

            username_match = _matches(
                _value(event, "username"),
                username,
            )
            ip_match = _matches(
                _value(event, "source_ip"),
                source_ip,
            )

            matches = (
                username_match and ip_match
                if username and source_ip
                else username_match or ip_match
            )

            if matches:
                _add_candidate(
                    candidates,
                    event,
                    90,
                    "Event occurred after the supplied login time and matched the account or IP context.",
                    known_ids,
                )

    elif request.tool == "get_ip_context":
        source_ip = params.get("source_ip")

        if not source_ip:
            raise ValueError("get_ip_context requires source_ip.")

        for event in events:
            if _matches(_value(event, "source_ip"), source_ip):
                _add_candidate(
                    candidates,
                    event,
                    80,
                    "Event contains the requested source IP address.",
                    known_ids,
                )

    candidates.sort(
        key=lambda item: (
            -item[1],
            item[0].timestamp,
            item[0].event_id,
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

    return InvestigationResult(
        tool=request.tool,
        retrieved_events=[
            _event_dict(event) for event, _, _ in selected
        ],
        evidence=evidence,
        retrieved_count=len(selected),
        budget_remaining=budget_remaining - 1,
        budget_consumed=1,
        request_hash=_request_hash(request.tool, request.params),
        message=(
            f"Retrieved {len(selected)} additional event(s)."
            if selected
            else "No additional matching events were found."
        ),
    )
