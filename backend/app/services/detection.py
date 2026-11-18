
from collections import defaultdict
from hashlib import sha256
from datetime import timedelta

from app.models.events import SecurityEvent


# Detection thresholds
BRUTE_FORCE_THRESHOLD = 5
BRUTE_FORCE_WINDOW = timedelta(minutes=10)

SUCCESS_AFTER_FAILURE_THRESHOLD = 3
SUCCESS_AFTER_FAILURE_WINDOW = timedelta(minutes=15)

SUSPICIOUS_ACCESS_THRESHOLD = 5
SUSPICIOUS_ACCESS_WINDOW = timedelta(minutes=10)


def create_alert(
    rule_id: str,
    title: str,
    severity: str,
    description: str,
    events: list[SecurityEvent],
    evidence: dict
) -> dict:
    """Create a consistent, traceable alert."""

    event_ids = sorted({event.event_id for event in events})

    fingerprint = f"{rule_id}:{','.join(event_ids)}"
    alert_hash = sha256(fingerprint.encode()).hexdigest()[:16]

    return {
        "alert_id": f"alert_{alert_hash}",
        "rule_id": rule_id,
        "title": title,
        "severity": severity,
        "description": description,
        "event_ids": event_ids,
        "evidence": evidence
    }


def detect_brute_force(events: list[SecurityEvent]) -> list[dict]:
    """
    Detect repeated failed authentication attempts
    from the same IP against the same username.
    """

    groups = defaultdict(list)

    for event in events:
        if (
            event.event_type == "authentication_failure"
            and event.source_ip
            and event.username
        ):
            groups[(event.source_ip, event.username)].append(event)

    alerts = []

    for (source_ip, username), group in groups.items():
        group.sort(key=lambda event: event.timestamp)

        for index, event in enumerate(group):
            window_events = [
                candidate
                for candidate in group[index:]
                if candidate.timestamp <= event.timestamp + BRUTE_FORCE_WINDOW
            ]

            if len(window_events) >= BRUTE_FORCE_THRESHOLD:
                matched = window_events[:BRUTE_FORCE_THRESHOLD]

                alerts.append(create_alert(
                    rule_id="DET-001",
                    title="Possible Brute-Force Attack",
                    severity="high",
                    description=(
                        f"{len(matched)} failed login attempts were detected "
                        f"from {source_ip} against user {username} "
                        f"within 10 minutes."
                    ),
                    events=matched,
                    evidence={
                        "source_ip": source_ip,
                        "username": username,
                        "failed_attempts": len(matched),
                        "window_minutes": 10
                    }
                ))
                break

    return alerts


def detect_success_after_failures(
    events: list[SecurityEvent]
) -> list[dict]:
    """
    Detect a successful login after multiple failed attempts
    from the same IP against the same username.
    """

    groups = defaultdict(list)

    for event in events:
        if (
            event.event_type in {
                "authentication_failure",
                "authentication_success"
            }
            and event.source_ip
            and event.username
        ):
            groups[(event.source_ip, event.username)].append(event)

    alerts = []

    for (source_ip, username), group in groups.items():
        group.sort(key=lambda event: event.timestamp)

        for index, event in enumerate(group):
            if event.event_type != "authentication_success":
                continue

            previous_events = [
                candidate
                for candidate in group[:index]
                if (
                    candidate.event_type == "authentication_failure"
                    and event.timestamp - SUCCESS_AFTER_FAILURE_WINDOW
                    <= candidate.timestamp
                    < event.timestamp
                )
            ]

            if len(previous_events) >= SUCCESS_AFTER_FAILURE_THRESHOLD:
                matched = previous_events[-SUCCESS_AFTER_FAILURE_THRESHOLD:] + [
                    event
                ]

                alerts.append(create_alert(
                    rule_id="DET-002",
                    title="Successful Login After Repeated Failures",
                    severity="critical",
                    description=(
                        f"A successful login for {username} from {source_ip} "
                        f"followed at least 3 failed login attempts "
                        f"within 15 minutes."
                    ),
                    events=matched,
                    evidence={
                        "source_ip": source_ip,
                        "username": username,
                        "failed_attempts_before_success": len(previous_events),
                        "window_minutes": 15,
                        "successful_event_id": event.event_id
                    }
                ))

    return alerts


def detect_suspicious_access(
    events: list[SecurityEvent]
) -> list[dict]:
    """
    Detect repeated denied web-access attempts from the same IP
    against the same resource.
    """

    groups = defaultdict(list)

    for event in events:
        if (
            event.event_type == "web_access"
            and event.outcome == "failure"
            and event.source_ip
            and event.resource
        ):
            groups[(event.source_ip, event.resource)].append(event)

    alerts = []

    for (source_ip, resource), group in groups.items():
        group.sort(key=lambda event: event.timestamp)

        for index, event in enumerate(group):
            window_events = [
                candidate
                for candidate in group[index:]
                if candidate.timestamp <= event.timestamp + SUSPICIOUS_ACCESS_WINDOW
            ]

            if len(window_events) >= SUSPICIOUS_ACCESS_THRESHOLD:
                matched = window_events[:SUSPICIOUS_ACCESS_THRESHOLD]

                alerts.append(create_alert(
                    rule_id="DET-003",
                    title="Repeated Denied Resource Access",
                    severity="medium",
                    description=(
                        f"{len(matched)} denied access attempts were detected "
                        f"from {source_ip} against {resource} within 10 minutes."
                    ),
                    events=matched,
                    evidence={
                        "source_ip": source_ip,
                        "resource": resource,
                        "denied_attempts": len(matched),
                        "window_minutes": 10
                    }
                ))
                break

    return alerts


def run_detection(events: list[SecurityEvent]) -> list[dict]:
    """Run all enabled deterministic detection rules."""

    alerts = []

    alerts.extend(detect_brute_force(events))
    alerts.extend(detect_success_after_failures(events))
    alerts.extend(detect_suspicious_access(events))

    return alerts
