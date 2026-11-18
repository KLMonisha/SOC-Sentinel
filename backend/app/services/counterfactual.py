from app.models.events import SecurityEvent
from app.services.detection import run_detection
from app.services.correlation import correlate_alerts


def run_counterfactual(
    events: list[SecurityEvent],
    event_ids_to_exclude: list[str],
    reason: str
) -> dict:
    """
    Run a hypothetical investigation without modifying original events.

    Excluded events are removed only from the hypothetical copy.
    Detection, correlation, and risk scoring are recomputed from scratch.
    """

    # 1. Validate the analyst's request.

    if not events:
        raise ValueError("No security events were provided.")

    if not reason or not reason.strip():
        raise ValueError("A reason for the simulation is required.")

    if not event_ids_to_exclude:
        raise ValueError("At least one event must be selected for exclusion.")

    event_lookup = {
        event.event_id: event
        for event in events
    }

    excluded_ids = set(event_ids_to_exclude)

    unknown_ids = excluded_ids - set(event_lookup)

    if unknown_ids:
        raise ValueError(
            f"Unknown event IDs: {sorted(unknown_ids)}"
        )

    if len(excluded_ids) >= len(event_lookup):
        raise ValueError(
            "Cannot exclude all security events."
        )

    # 2. Run the original investigation.

    original_alerts = run_detection(events)

    original_incidents = correlate_alerts(
        original_alerts,
        events
    )

    # 3. Create a separate hypothetical event list.

    hypothetical_events = [
        event
        for event in events
        if event.event_id not in excluded_ids
    ]

    # 4. Rerun the complete detection pipeline.

    hypothetical_alerts = run_detection(
        hypothetical_events
    )

    hypothetical_incidents = correlate_alerts(
        hypothetical_alerts,
        hypothetical_events
    )

    # 5. Compare alerts using their deterministic IDs.

    original_alert_lookup = {
        alert["alert_id"]: alert
        for alert in original_alerts
    }

    hypothetical_alert_lookup = {
        alert["alert_id"]: alert
        for alert in hypothetical_alerts
    }

    original_alert_ids = set(original_alert_lookup)
    hypothetical_alert_ids = set(hypothetical_alert_lookup)

    added_alert_ids = sorted(
        hypothetical_alert_ids - original_alert_ids
    )

    removed_alert_ids = sorted(
        original_alert_ids - hypothetical_alert_ids
    )

    unchanged_alert_ids = sorted(
        original_alert_ids & hypothetical_alert_ids
    )

    # 6. Compare incidents.

    original_incident_ids = {
        incident["incident_id"]
        for incident in original_incidents
    }

    hypothetical_incident_ids = {
        incident["incident_id"]
        for incident in hypothetical_incidents
    }

    added_incidents = sorted(
        hypothetical_incident_ids - original_incident_ids
    )

    removed_incidents = sorted(
        original_incident_ids - hypothetical_incident_ids
    )

    unchanged_incidents = sorted(
        original_incident_ids & hypothetical_incident_ids
    )

    # 7. Compare the highest incident risk scores.

    original_max_risk = max(
        (incident["risk_score"] for incident in original_incidents),
        default=0
    )

    hypothetical_max_risk = max(
        (incident["risk_score"] for incident in hypothetical_incidents),
        default=0
    )

    original_max_severity = max(
        original_incidents,
        key=lambda incident: incident["risk_score"],
        default=None
    )

    hypothetical_max_severity = max(
        hypothetical_incidents,
        key=lambda incident: incident["risk_score"],
        default=None
    )

    # 8. Compare risk scores for individual incidents.

    original_by_id = {
        incident["incident_id"]: incident
        for incident in original_incidents
    }

    hypothetical_by_id = {
        incident["incident_id"]: incident
        for incident in hypothetical_incidents
    }

    per_incident_changes = []

    # Match incidents that retain the same deterministic ID.
    for incident_id in sorted(
        set(original_by_id) & set(hypothetical_by_id)
    ):
        original_incident = original_by_id[incident_id]
        hypothetical_incident = hypothetical_by_id[incident_id]

        per_incident_changes.append({
            "incident_id": incident_id,
            "correlation_key": original_incident["correlation_key"],
            "change_type": "unchanged",
            "original_risk_score": original_incident["risk_score"],
            "hypothetical_risk_score": hypothetical_incident["risk_score"],
            "risk_score_change": (
                hypothetical_incident["risk_score"]
                - original_incident["risk_score"]
            ),
            "original_severity": original_incident["severity"],
            "hypothetical_severity": hypothetical_incident["severity"]
        })

    # Report incidents that disappeared entirely.
    for incident_id in sorted(
        set(original_by_id) - set(hypothetical_by_id)
    ):
        incident = original_by_id[incident_id]

        per_incident_changes.append({
            "incident_id": incident_id,
            "correlation_key": incident["correlation_key"],
            "change_type": "removed",
            "original_risk_score": incident["risk_score"],
            "hypothetical_risk_score": 0,
            "risk_score_change": -incident["risk_score"],
            "original_severity": incident["severity"],
            "hypothetical_severity": None
        })

    # Report newly created incidents.
    for incident_id in sorted(
        set(hypothetical_by_id) - set(original_by_id)
    ):
        incident = hypothetical_by_id[incident_id]

        per_incident_changes.append({
            "incident_id": incident_id,
            "correlation_key": incident["correlation_key"],
            "change_type": "added",
            "original_risk_score": 0,
            "hypothetical_risk_score": incident["risk_score"],
            "risk_score_change": incident["risk_score"],
            "original_severity": None,
            "hypothetical_severity": incident["severity"]
        })

    return {
        "simulation_type": "event_exclusion",
        "reason": reason.strip(),

        "excluded_event_ids": sorted(excluded_ids),

        "original": {
            "event_count": len(events),
            "alerts": original_alerts,
            "incidents": original_incidents
        },

        "hypothetical": {
            "event_count": len(hypothetical_events),
            "alerts": hypothetical_alerts,
            "incidents": hypothetical_incidents
        },

        "comparison": {
            "alerts_added": [
                hypothetical_alert_lookup[alert_id]
                for alert_id in added_alert_ids
            ],

            "alerts_removed": [
                original_alert_lookup[alert_id]
                for alert_id in removed_alert_ids
            ],

            "alerts_unchanged": unchanged_alert_ids,

            "incidents_added": added_incidents,
            "incidents_removed": removed_incidents,
            "incidents_unchanged": unchanged_incidents,

            "original_max_risk_score": original_max_risk,
            "hypothetical_max_risk_score": hypothetical_max_risk,

            "risk_score_change": (
                hypothetical_max_risk - original_max_risk
            ),

            "original_highest_severity": (
                original_max_severity["severity"]
                if original_max_severity else "low"
            ),

            "hypothetical_highest_severity": (
                hypothetical_max_severity["severity"]
                if hypothetical_max_severity else "low"
            ),

            "per_incident_changes": per_incident_changes
        },

        "original_data_modified": False
    }