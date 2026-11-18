
from collections import defaultdict
from datetime import timedelta
from hashlib import sha256

from app.models.events import SecurityEvent


SEVERITY_POINTS = {
    "critical": 80,
    "high": 60,
    "medium": 40,
    "low": 20
}

CORRELATION_WINDOW = timedelta(minutes=30)


def get_alert_times(
    alert: dict,
    event_lookup: dict[str, SecurityEvent]
):
    """Get the earliest and latest timestamps for an alert."""

    matched_events = [
        event_lookup[event_id]
        for event_id in alert.get("event_ids", [])
        if event_id in event_lookup
    ]

    if not matched_events:
        return None, None

    timestamps = [event.timestamp for event in matched_events]

    return min(timestamps), max(timestamps)


def calculate_risk_score(alerts: list[dict]) -> dict:
    """
    Calculate a deterministic incident risk score.

    The score is based on:
    - Highest alert severity
    - Number of distinct detection rules
    - Number of distinct supporting events
    """

    if not alerts:
        return {
            "score": 0,
            "severity": "low",
            "reasoning": ["No alerts were associated with this incident."]
        }

    highest_severity = max(
        alerts,
        key=lambda alert: SEVERITY_POINTS.get(
            alert.get("severity", "low"), 20
        )
    ).get("severity", "low")

    base_score = SEVERITY_POINTS.get(highest_severity, 20)

    distinct_rules = {
        alert.get("rule_id")
        for alert in alerts
        if alert.get("rule_id")
    }

    distinct_events = {
        event_id
        for alert in alerts
        for event_id in alert.get("event_ids", [])
    }

    rule_bonus = min(20, max(0, len(distinct_rules) - 1) * 8)
    evidence_bonus = min(12, len(distinct_events) * 2)

    score = min(100, base_score + rule_bonus + evidence_bonus)

    if score >= 80:
        severity = "critical"
    elif score >= 60:
        severity = "high"
    elif score >= 35:
        severity = "medium"
    else:
        severity = "low"

    reasoning = [
        f"Highest contributing alert severity: {highest_severity}.",
        f"{len(distinct_rules)} distinct detection rule(s) contributed.",
        f"{len(distinct_events)} distinct event(s) support the incident.",
        f"Risk score: {base_score} base + {rule_bonus} rule bonus + "
        f"{evidence_bonus} evidence bonus."
    ]

    return {
        "score": score,
        "severity": severity,
        "reasoning": reasoning
    }


def correlate_alerts(
    alerts: list[dict],
    events: list[SecurityEvent],
    window_minutes: int = 30
) -> list[dict]:
    """
    Group alerts sharing a source IP when their event time ranges
    fall within the configured correlation window.
    """

    event_lookup = {
        event.event_id: event
        for event in events
    }

    grouped = defaultdict(list)

    for alert in alerts:
        source_ip = alert.get("evidence", {}).get("source_ip")

        # Alerts without a source IP remain separate incidents.
        grouping_key = source_ip or alert["alert_id"]

        start_time, end_time = get_alert_times(alert, event_lookup)

        grouped[grouping_key].append({
            "alert": alert,
            "start_time": start_time,
            "end_time": end_time
        })

    incidents = []

    for grouping_key, entries in grouped.items():
        entries.sort(
            key=lambda item: item["start_time"]
            if item["start_time"] is not None
            else item["end_time"]
        )

        clusters = []
        current_cluster = []
        current_end = None

        for entry in entries:
            start_time = entry["start_time"]
            end_time = entry["end_time"]

            if not current_cluster:
                current_cluster = [entry]
                current_end = end_time
                continue

            if (
                start_time is not None
                and current_end is not None
                and start_time <= current_end + timedelta(
                    minutes=window_minutes
                )
            ):
                current_cluster.append(entry)

                if end_time and end_time > current_end:
                    current_end = end_time
            else:
                clusters.append(current_cluster)
                current_cluster = [entry]
                current_end = end_time

        if current_cluster:
            clusters.append(current_cluster)

        for cluster in clusters:
            cluster_alerts = [
                item["alert"]
                for item in cluster
            ]

            alert_ids = sorted({
                alert["alert_id"]
                for alert in cluster_alerts
            })

            event_ids = sorted({
                event_id
                for alert in cluster_alerts
                for event_id in alert.get("event_ids", [])
            })

            risk = calculate_risk_score(cluster_alerts)

            incident_fingerprint = (
                grouping_key + ":" + ",".join(alert_ids)
            )

            incident_hash = sha256(
                incident_fingerprint.encode()
            ).hexdigest()[:16]

            incidents.append({
                "incident_id": f"inc_{incident_hash}",
                "correlation_key": grouping_key,
                "alert_ids": alert_ids,
                "event_ids": event_ids,
                "alert_count": len(alert_ids),
                "risk_score": risk["score"],
                "severity": risk["severity"],
                "risk_reasoning": risk["reasoning"],
                "status": "open"
            })

    return incidents
