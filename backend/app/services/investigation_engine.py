
from app.models.events import SecurityEvent
from app.services.detection import run_detection
from app.services.correlation import correlate_alerts
from app.services.mitre_mapping import enrich_alerts_with_attack
from app.services.assessment import (
    enrich_alerts_with_confidence,
    assess_telemetry_coverage,
)

SEVERITY_ORDER = {
    "low": 1,
    "medium": 2,
    "high": 3,
    "critical": 4,
}


def _maximum_risk(incidents: list[dict]) -> int:
    return max(
        (incident.get("risk_score", 0) for incident in incidents),
        default=0,
    )


def _highest_severity(incidents: list[dict]) -> str:
    if not incidents:
        return "none"

    return max(
        (incident.get("severity", "low") for incident in incidents),
        key=lambda severity: SEVERITY_ORDER.get(severity, 0),
    )


def _filter_relevant_incidents(
    incidents: list[dict],
    context_event_ids: set[str],
) -> list[dict]:
    """Keep incidents that overlap with the investigation context."""

    return [
        incident
        for incident in incidents
        if context_event_ids.intersection(
            incident.get("event_ids", [])
        )
    ]


def reevaluate_investigation(
    events: list[SecurityEvent],
    initial_event_ids: list[str],
    retrieved_event_ids: list[str],
) -> dict:
    """
    Re-run detection and correlation using the original incident
    evidence plus newly retrieved events.

    The source dataset and original events are never modified.
    """

    if not initial_event_ids:
        raise ValueError("At least one initial event ID is required.")

    if not retrieved_event_ids:
        raise ValueError("At least one retrieved event ID is required.")

    event_lookup = {
        event.event_id: event
        for event in events
    }

    initial_ids = set(initial_event_ids)
    retrieved_ids = set(retrieved_event_ids)

    if len(initial_ids) != len(initial_event_ids):
        raise ValueError("Duplicate initial event IDs are not allowed.")

    if len(retrieved_ids) != len(retrieved_event_ids):
        raise ValueError("Duplicate retrieved event IDs are not allowed.")

    overlap = initial_ids.intersection(retrieved_ids)

    if overlap:
        raise ValueError(
            f"Retrieved events already exist in initial evidence: "
            f"{sorted(overlap)}"
        )

    requested_ids = initial_ids.union(retrieved_ids)

    unknown_ids = requested_ids.difference(event_lookup)

    if unknown_ids:
        raise ValueError(
            f"Unknown event IDs: {sorted(unknown_ids)}"
        )

    # Stage 1: Build the original investigation context.
    original_events = [
        event_lookup[event_id]
        for event_id in initial_event_ids
    ]

    # Stage 2: Build the expanded context.
    expanded_ids = initial_ids.union(retrieved_ids)

    expanded_events = [
        event
        for event in events
        if event.event_id in expanded_ids
    ]

    # Stage 3: Re-run the original analysis.
    original_alerts = run_detection(original_events)

    original_alerts = enrich_alerts_with_attack(original_alerts)
    original_alerts = enrich_alerts_with_confidence(
        original_alerts,
        original_events
    )

    original_coverage = assess_telemetry_coverage(original_events)

    original_incidents = correlate_alerts(
        original_alerts,
        original_events,
    )

    # Stage 4: Re-run analysis with additional evidence.
    updated_alerts = run_detection(expanded_events)

    updated_alerts = enrich_alerts_with_attack(updated_alerts)
    updated_alerts = enrich_alerts_with_confidence(
        updated_alerts,
        expanded_events
    )

    updated_coverage = assess_telemetry_coverage(expanded_events)

    updated_incidents = correlate_alerts(
        updated_alerts,
        expanded_events,
    )

    # Keep the incidents relevant to this investigation.
    original_incidents = _filter_relevant_incidents(
        original_incidents,
        initial_ids,
    )

    updated_incidents = _filter_relevant_incidents(
        updated_incidents,
        expanded_ids,
    )

    # Stage 5: Compare findings.
    original_alert_ids = {
        alert["alert_id"] for alert in original_alerts
    }

    updated_alert_ids = {
        alert["alert_id"] for alert in updated_alerts
    }

    added_alert_ids = sorted(
        updated_alert_ids - original_alert_ids
    )

    removed_alert_ids = sorted(
        original_alert_ids - updated_alert_ids
    )

    unchanged_alert_ids = sorted(
        original_alert_ids.intersection(updated_alert_ids)
    )

    # Stage 6: Explain how retrieved events were used.
    updated_alert_event_ids = {
        event_id
        for alert in updated_alerts
        for event_id in alert.get("event_ids", [])
    }

    evidence_classification = []

    for event_id in retrieved_event_ids:
        if event_id in updated_alert_event_ids:
            classification = "supporting"
            explanation = (
                "This event contributed to at least one "
                "updated detection finding."
            )
        else:
            classification = "context_only"
            explanation = (
                "This event was retrieved but did not trigger "
                "a detection finding. It is not automatically benign."
            )

        evidence_classification.append({
            "event_id": event_id,
            "classification": classification,
            "explanation": explanation,
        })

    original_risk = _maximum_risk(original_incidents)
    updated_risk = _maximum_risk(updated_incidents)

    original_severity = _highest_severity(original_incidents)
    updated_severity = _highest_severity(updated_incidents)

    return {
        "original_data_modified": False,
        "initial_event_count": len(original_events),
        "retrieved_event_count": len(retrieved_event_ids),
        "expanded_event_count": len(expanded_events),
        "original": {
            "alerts": original_alerts,
            "incidents": original_incidents,
            "risk_score": original_risk,
            "severity": original_severity,
        },
        "updated": {
            "alerts": updated_alerts,
            "incidents": updated_incidents,
            "risk_score": updated_risk,
            "severity": updated_severity,
        },
        "comparison": {
            "added_alert_ids": added_alert_ids,
            "removed_alert_ids": removed_alert_ids,
            "unchanged_alert_ids": unchanged_alert_ids,
            "risk_score_delta": updated_risk - original_risk,
            "severity_changed": original_severity != updated_severity,
        },
        "telemetry_coverage": {
            "original": original_coverage,
            "updated": updated_coverage,
        },
        "retrieved_evidence": evidence_classification,
    }
