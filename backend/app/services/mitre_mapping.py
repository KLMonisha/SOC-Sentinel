
from copy import deepcopy


ATTACK_TECHNIQUES = {
    "T1110": {
        "technique_id": "T1110",
        "technique_name": "Brute Force",
        "tactic": "Credential Access",
        "url": "https://attack.mitre.org/techniques/T1110/"
    }
}


# Map only what the current detection evidence supports.
RULE_MAPPINGS = {
    "DET-001": {
        "techniques": ["T1110"],
        "confidence": "high",
        "justification": (
            "Repeated failed authentication attempts against the same "
            "username from the same source IP within a short time window."
        )
    },
    "DET-002": {
        "techniques": ["T1110"],
        "confidence": "moderate",
        "justification": (
            "Repeated authentication failures followed by a successful "
            "login from the same source IP and username. This is consistent "
            "with brute-force activity, but does not prove account compromise."
        )
    },
    "DET-003": {
        "techniques": [],
        "confidence": "unmapped",
        "justification": (
            "Repeated denied resource requests are suspicious, but the "
            "available evidence does not establish a specific ATT&CK technique."
        )
    }
}


def map_alert_to_attack(alert: dict) -> dict:
    """Return an alert copy enriched with conservative ATT&CK mapping."""

    enriched = deepcopy(alert)
    rule_id = alert.get("rule_id")
    mapping = RULE_MAPPINGS.get(rule_id)

    if mapping is None:
        enriched["mitre_attack"] = []
        enriched["mitre_mapping_confidence"] = "unmapped"
        enriched["mitre_mapping_reason"] = (
            "No ATT&CK mapping is configured for this detection rule."
        )
        return enriched

    enriched["mitre_attack"] = [
        deepcopy(ATTACK_TECHNIQUES[technique_id])
        for technique_id in mapping["techniques"]
    ]

    enriched["mitre_mapping_confidence"] = mapping["confidence"]
    enriched["mitre_mapping_reason"] = mapping["justification"]

    return enriched


def enrich_alerts_with_attack(alerts: list[dict]) -> list[dict]:
    """Enrich all alerts without modifying the original alert objects."""

    return [
        map_alert_to_attack(alert)
        for alert in alerts
    ]
