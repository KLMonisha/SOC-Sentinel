
from collections import Counter


# These describe the telemetry dimensions currently supported
# by our normalized event model. They are not a claim of full SOC coverage.
SUPPORTED_TELEMETRY = {
    "authentication": "Authentication success/failure events",
    "web_access": "Web resource access events",
    "source_attribution": "Events containing a source IP address",
    "host_context": "Events containing host information",
}


RULE_REQUIREMENTS = {
    "DET-001": {
        "minimum_events": 5,
        "event_type": "authentication_failure",
        "required_evidence": ["source_ip", "username"],
        "description": "Repeated failed authentication attempts",
    },
    "DET-002": {
        "minimum_events": 4,
        "event_type": None,
        "required_evidence": [
            "source_ip",
            "username",
            "successful_event_id",
        ],
        "description": "Repeated failures followed by successful authentication",
    },
    "DET-003": {
        "minimum_events": 5,
        "event_type": "web_access",
        "required_evidence": ["source_ip", "resource"],
        "description": "Repeated denied access to a resource",
    },
}


def assess_alert_confidence(
    alert: dict,
    events: list
) -> dict:
    """
    Assess confidence using evidence completeness and event consistency.

    Confidence is not the same as severity or probability.
    """

    rule_id = alert.get("rule_id")
    requirements = RULE_REQUIREMENTS.get(rule_id)

    if requirements is None:
        return {
            "level": "low",
            "rationale": [
                "No confidence assessment is configured for this rule."
            ],
        }

    event_lookup = {
        event.event_id: event
        for event in events
    }

    event_ids = alert.get("event_ids", [])
    matched_events = [
        event_lookup[event_id]
        for event_id in event_ids
        if event_id in event_lookup
    ]

    rationale = []
    checks_passed = 0
    total_checks = 3

    # Check 1: Evidence references resolve to actual events.
    if matched_events and len(matched_events) == len(set(event_ids)):
        checks_passed += 1
        rationale.append(
            "All cited event IDs resolve to available normalized events."
        )
    else:
        rationale.append(
            "Some cited event IDs are missing or unresolved."
        )

    # Check 2: The alert has the expected amount of evidence.
    if len(matched_events) >= requirements["minimum_events"]:
        checks_passed += 1
        rationale.append(
            f"{len(matched_events)} supporting events meet the "
            f"minimum requirement of {requirements['minimum_events']}."
        )
    else:
        rationale.append(
            f"Only {len(matched_events)} supporting events are available; "
            f"{requirements['minimum_events']} are expected."
        )

    # Check 3: Evidence matches the behavior described by the rule.
    evidence = alert.get("evidence", {})
    evidence_complete = all(
        evidence.get(field) is not None
        for field in requirements["required_evidence"]
    )

    if requirements["event_type"] is not None:
        evidence_consistent = (
            bool(matched_events)
            and all(
                event.event_type == requirements["event_type"]
                for event in matched_events
            )
        )
    else:
        successful_event_id = evidence.get("successful_event_id")
        evidence_consistent = (
            bool(matched_events)
            and any(
                event.event_id == successful_event_id
                and event.event_type == "authentication_success"
                for event in matched_events
            )
            and any(
                event.event_type == "authentication_failure"
                for event in matched_events
            )
        )

    if evidence_complete and evidence_consistent:
        checks_passed += 1
        rationale.append(
            "Required rule evidence is present and supporting event "
            "types are consistent with the detection."
        )
    else:
        rationale.append(
            "Some required evidence is missing or supporting event types "
            "do not fully match the detection rule."
        )

    if checks_passed == 3:
        level = "high"
    elif checks_passed == 2:
        level = "medium"
    else:
        level = "low"

    rationale.append(
        "Confidence reflects evidence completeness and consistency; "
        "it is not a probability that an attack occurred."
    )

    return {
        "level": level,
        "rationale": rationale,
    }


def assess_telemetry_coverage(events: list) -> dict:
    """
    Describe which supported telemetry dimensions appear in the dataset.

    A dimension is present when at least one event provides that context.
    """

    authentication_events = [
        event for event in events
        if event.event_type in {
            "authentication_failure",
            "authentication_success",
        }
    ]

    web_events = [
        event for event in events
        if event.event_type == "web_access"
    ]

    source_ip_events = [
        event for event in events
        if event.source_ip
    ]

    host_events = [
        event for event in events
        if event.host
    ]

    observed = {
        "authentication": bool(authentication_events),
        "web_access": bool(web_events),
        "source_attribution": bool(source_ip_events),
        "host_context": bool(host_events),
    }

    present = [
        key for key, available in observed.items()
        if available
    ]

    missing = [
        key for key, available in observed.items()
        if not available
    ]

    total_dimensions = len(SUPPORTED_TELEMETRY)
    coverage_ratio = (
        len(present) / total_dimensions
        if total_dimensions else 0
    )

    return {
        "coverage_ratio": round(coverage_ratio, 2),
        "dimensions_present": present,
        "dimensions_missing": missing,
        "dimension_details": {
            "authentication": {
                "present": observed["authentication"],
                "event_count": len(authentication_events),
                "description": SUPPORTED_TELEMETRY["authentication"],
            },
            "web_access": {
                "present": observed["web_access"],
                "event_count": len(web_events),
                "description": SUPPORTED_TELEMETRY["web_access"],
            },
            "source_attribution": {
                "present": observed["source_attribution"],
                "event_count": len(source_ip_events),
                "description": SUPPORTED_TELEMETRY["source_attribution"],
            },
            "host_context": {
                "present": observed["host_context"],
                "event_count": len(host_events),
                "description": SUPPORTED_TELEMETRY["host_context"],
            },
        },
        "interpretation": (
            "Coverage measures the presence of supported telemetry "
            "dimensions in this dataset. It does not measure the "
            "completeness of the organization's entire security monitoring."
        ),
    }


def enrich_alerts_with_confidence(
    alerts: list[dict],
    events: list
) -> list[dict]:
    """Add confidence assessments without modifying original alerts."""

    enriched = []

    for alert in alerts:
        item = dict(alert)
        item["confidence"] = assess_alert_confidence(alert, events)
        enriched.append(item)

    return enriched
