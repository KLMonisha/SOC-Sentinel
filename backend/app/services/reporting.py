
from datetime import datetime, timezone


def _valid_citations(
    citations: list[str],
    available_event_ids: set[str],
) -> tuple[list[str], bool]:
    if not isinstance(citations, list) or not citations:
        return [], False

    valid_citations = []
    seen = set()
    has_invalid = False
    has_duplicate = False

    for event_id in citations:
        if not isinstance(event_id, str) or event_id not in available_event_ids:
            has_invalid = True
            continue

        if event_id in seen:
            has_duplicate = True
            continue

        seen.add(event_id)
        valid_citations.append(event_id)

    is_valid = (
        bool(valid_citations)
        and not has_invalid
        and not has_duplicate
    )

    return valid_citations, is_valid


def validate_report_citations(
    report: dict,
    available_event_ids: set[str],
) -> dict:
    verified_count = 0
    rejected_count = 0
    total_count = 0

    for claim in report.get("claims", []):
        total_count += 1

        original_citations = claim.get("citations", [])

        citations, valid = _valid_citations(
            original_citations,
            available_event_ids,
        )

        claim["citations"] = citations
        claim["verified"] = valid

        if valid:
            claim["verification_note"] = (
                "All cited event IDs resolve to events in this case."
            )
            verified_count += 1
        else:
            claim["verification_note"] = (
                "Claim could not be verified because citations are "
                "missing, duplicated, or do not resolve to events "
                "in this case."
            )
            rejected_count += 1

    report["citation_counts"] = {
        "total": total_count,
        "verified": verified_count,
        "rejected": rejected_count,
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
            f"{len(incidents)} case(s). The highest case risk score "
            f"was {highest_risk['risk_score']}/100, classified as "
            f"{highest_risk.get('severity', 'unknown')}. "
            f"The investigation used {len(events)} normalized events."
        )

    return (
        f"Analysis identified {len(alerts)} alert(s) across "
        f"{len(events)} normalized events. No correlated cases were produced."
    )


def _build_claims(
    alerts: list[dict],
    incidents: list[dict],
    available_event_ids: set[str],
) -> list[dict]:
    claims = []

    for alert in alerts:
        # Keep original citations here.
        # validate_report_citations() will verify and filter them.
        citations = alert.get("event_ids", [])

        claims.append({
            "type": "detection_finding",
            "title": alert.get("title", "Security finding"),
            "text": alert.get("description", ""),
            "severity": alert.get("severity", "unknown"),
            "stance": alert.get("stance", "supporting"),
            "weight": alert.get("weight", 0),
            "citations": citations,
            "verified": False,
            "verification_note": None,
        })

    for incident in incidents:
        # Keep original citations for validation.
        citations = incident.get("event_ids", [])

        claims.append({
            "type": "case_assessment",
            "title": "Correlated case assessment",
            "text": (
                f"Case contains {incident.get('alert_count', 0)} alert(s), "
                f"with a heuristic risk score of "
                f"{incident.get('risk_score', 0)}/100 and severity "
                f"{incident.get('severity', 'unknown')}."
            ),
            "severity": incident.get("severity", "unknown"),
            "risk_score": incident.get("risk_score", 0),
            "citations": citations,
            "verified": False,
            "verification_note": None,
        })

    return claims


def _build_recommendations(
    alerts: list[dict],
    coverage: dict,
) -> list[dict]:
    recommendations = []

    rule_ids = {
        alert.get("rule_id") for alert in alerts
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

    missing = coverage.get(
        "coverage_missing",
        coverage.get("dimensions_missing", []),
    )

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
    available_event_ids = {
        event.event_id for event in events
    }

    claims = _build_claims(
        alerts,
        incidents,
        available_event_ids,
    )

    generated_at = datetime.now(timezone.utc)

    report = {
        "report_id": (
            "report_"
            + generated_at.strftime("%Y%m%dT%H%M%S%f")
        ),
        "generated_at": generated_at.isoformat(),
        "generated_by": "template_fallback",
        "fallback_reason": "Deterministic evidence-linked report generation.",
        "report_status": "completed",
        "executive_summary": _build_executive_summary(
            incidents,
            alerts,
            events,
        ),
        "dataset_summary": {
            "event_count": len(events),
            "alert_count": len(alerts),
            "case_count": len(incidents),
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
        "coverage_missing": telemetry_coverage.get(
            "coverage_missing",
            telemetry_coverage.get("dimensions_missing", []),
        ),
        "alerts": alerts,
        "cases": incidents,
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
