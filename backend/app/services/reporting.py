
from datetime import datetime, timezone


def _resolve_event_ids(
    event_ids: list[str],
    available_event_ids: set[str],
) -> list[str]:
    """Keep only valid, unique evidence references."""

    return sorted({
        event_id
        for event_id in event_ids
        if event_id in available_event_ids
    })


def validate_report_citations(
    report: dict,
    available_event_ids: set[str],
) -> dict:
    """
    Verify that every report claim references existing events.
    Invalid claims are marked rather than silently accepted.
    """

    validation_results = []
    all_valid = True

    for index, claim in enumerate(report.get("claims", [])):
        cited_ids = claim.get("event_ids", [])

        valid_ids = _resolve_event_ids(
            cited_ids,
            available_event_ids,
        )

        valid = (
            bool(cited_ids)
            and len(valid_ids) == len(set(cited_ids))
        )

        if not valid:
            all_valid = False

        validation_results.append({
            "claim_index": index,
            "valid": valid,
            "cited_event_ids": cited_ids,
            "resolved_event_ids": valid_ids,
        })

    report["citation_validation"] = {
        "all_valid": all_valid,
        "total_claims": len(validation_results),
        "validated_claims": sum(
            item["valid"] for item in validation_results
        ),
        "results": validation_results,
    }

    return report


def _build_executive_summary(
    incidents: list[dict],
    alerts: list[dict],
    events: list,
) -> str:

    if not alerts:
        return (
            f"Analysis completed across {len(events)} normalized events. "
            "No configured detection rules generated alerts. "
            "This does not establish that the environment is benign."
        )

    highest_risk = max(
        incidents,
        key=lambda item: item.get("risk_score", 0),
        default=None,
    )

    if highest_risk:
        return (
            f"Analysis identified {len(alerts)} alert(s) across "
            f"{len(incidents)} incident(s). The highest incident risk "
            f"score was {highest_risk['risk_score']}/100, classified "
            f"as {highest_risk['severity']}. "
            f"The investigation used {len(events)} normalized events."
        )

    return (
        f"Analysis identified {len(alerts)} alert(s) across "
        f"{len(events)} normalized events. No correlated incidents "
        "were produced."
    )


def _build_claims(
    alerts: list[dict],
    incidents: list[dict],
    available_event_ids: set[str],
) -> list[dict]:

    claims = []

    for alert in alerts:
        evidence_ids = _resolve_event_ids(
            alert.get("event_ids", []),
            available_event_ids,
        )

        if not evidence_ids:
            continue

        claims.append({
            "type": "detection_finding",
            "title": alert.get("title", "Security finding"),
            "statement": alert.get("description", ""),
            "severity": alert.get("severity", "unknown"),
            "confidence": alert.get("confidence", {}),
            "mitre_attack": alert.get("mitre_attack", []),
            "event_ids": evidence_ids,
        })

    for incident in incidents:
        evidence_ids = _resolve_event_ids(
            incident.get("event_ids", []),
            available_event_ids,
        )

        if not evidence_ids:
            continue

        claims.append({
            "type": "incident_assessment",
            "title": "Correlated incident assessment",
            "statement": (
                f"Incident contains {incident.get('alert_count', 0)} "
                f"alert(s), with a heuristic risk score of "
                f"{incident.get('risk_score', 0)}/100 and severity "
                f"{incident.get('severity', 'unknown')}."
            ),
            "severity": incident.get("severity", "unknown"),
            "risk_score": incident.get("risk_score", 0),
            "event_ids": evidence_ids,
        })

    return claims


def _build_recommendations(
    alerts: list[dict],
    coverage: dict,
) -> list[dict]:

    recommendations = []

    rule_ids = {
        alert.get("rule_id")
        for alert in alerts
    }

    if "DET-001" in rule_ids or "DET-002" in rule_ids:
        recommendations.append({
            "priority": "high",
            "action": (
                "Review authentication logs and verify the affected "
                "account with the account owner."
            ),
            "execution": "analyst_approval_required",
        })

    if "DET-003" in rule_ids:
        recommendations.append({
            "priority": "medium",
            "action": (
                "Review web server access logs and confirm whether "
                "the denied resource requests were expected."
            ),
            "execution": "manual_investigation",
        })

    missing = coverage.get("dimensions_missing", [])

    if missing:
        recommendations.append({
            "priority": "medium",
            "action": (
                "Improve telemetry collection for these missing "
                f"dimensions: {', '.join(missing)}."
            ),
            "execution": "configuration_review",
        })

    if not recommendations:
        recommendations.append({
            "priority": "low",
            "action": (
                "Continue monitoring and retain relevant security logs "
                "for future investigation."
            ),
            "execution": "manual_review",
        })

    return recommendations


def generate_investigation_report(
    events: list,
    alerts: list[dict],
    incidents: list[dict],
    telemetry_coverage: dict,
) -> dict:
    """
    Generate a deterministic, evidence-linked investigation report.

    No LLM is required. All claims originate from the existing
    detection and correlation pipeline.
    """

    available_event_ids = {
        event.event_id for event in events
    }

    claims = _build_claims(
        alerts,
        incidents,
        available_event_ids,
    )

    report = {
        "report_id": (
            "report_" + datetime.now(timezone.utc).strftime(
                "%Y%m%dT%H%M%S%f"
            )
        ),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generated_by": "template_fallback",
        "report_status": "completed",
        "executive_summary": _build_executive_summary(
            incidents,
            alerts,
            events,
        ),
        "dataset_summary": {
            "event_count": len(events),
            "alert_count": len(alerts),
            "incident_count": len(incidents),
        },
        "highest_risk_score": max(
            (
                incident.get("risk_score", 0)
                for incident in incidents
            ),
            default=0,
        ),
        "claims": claims,
        "telemetry_coverage": telemetry_coverage,
        "missing_telemetry": telemetry_coverage.get(
            "dimensions_missing", []
        ),
        "alerts": alerts,
        "incidents": incidents,
        "recommendations": _build_recommendations(
            alerts,
            telemetry_coverage,
        ),
        "containment": {
            "dry_run": True,
            "executed": False,
            "message": (
                "No containment actions were executed. "
                "Any response action requires analyst approval."
            ),
        },
    }

    return validate_report_citations(
        report,
        available_event_ids,
    )
