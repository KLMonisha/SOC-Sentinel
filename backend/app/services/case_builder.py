"""Turns the backend pipeline output into the assessment fields the database stores.

Only restates what the pipeline computed (risk, per-alert confidence, coverage, ATT&CK, alerts).
The verdict is a transparent mapping from the backend risk band and confidence, and is labelled as such.
"""
from collections import Counter

from app.services.assessment import SUPPORTED_TELEMETRY

_CONF_RANK = {"low": 0, "medium": 1, "high": 2}
_SEV_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}


def _lowest_confidence(alerts: list[dict]) -> tuple[str, str]:
    levels = [(a.get("confidence") or {}) for a in alerts]
    levels = [c for c in levels if c.get("level") in _CONF_RANK]
    if not levels:
        return "low", "No per-alert confidence assessment was available."
    lowest = min(levels, key=lambda c: _CONF_RANK[c["level"]])["level"]
    seen: list[str] = []
    for c in levels:
        for line in c.get("rationale") or []:
            if line not in seen:
                seen.append(line)
    return lowest, " ".join(seen)[:4000] or "Confidence derived from detection evidence completeness."


def derive_verdict(risk_band: str, confidence_level: str, risk_value: int) -> tuple[str, str]:
    if risk_band == "high" and confidence_level != "low":
        verdict = "likely_malicious"
    elif risk_band in ("high", "investigate"):
        verdict = "needs_investigation"
    else:
        verdict = "insufficient_evidence"
    rationale = (
        f"Derived from the backend risk band '{risk_band}' (score {risk_value}/100) and the lowest alert "
        f"confidence '{confidence_level}'. This is a rule-based mapping; no analyst or language-model judgment was applied."
    )
    return verdict, rationale


def _entities(events: list) -> list[str]:
    counts: Counter = Counter()
    for e in events:
        if e.username:
            counts[e.username] += 1
        if e.source_ip:
            counts[e.source_ip] += 1
    return [name for name, _ in counts.most_common(6)]


def _graph(events: list) -> dict:
    nodes: dict[str, dict] = {}
    edges: dict[tuple, dict] = {}

    def node(nid: str, kind: str, label: str):
        nodes.setdefault(nid, {"id": nid, "kind": kind, "label": label, "state": "observed"})

    def edge(a: str, b: str, relation: str, event_id: str):
        e = edges.setdefault((a, b, relation), {"id": f"edge_{len(edges) + 1}", "source": a, "target": b,
                                                 "relation": relation, "state": "observed", "event_ids": []})
        e["event_ids"].append(event_id)

    for ev in events:
        ip = f"ip:{ev.source_ip}" if ev.source_ip else None
        user = f"user:{ev.username}" if ev.username else None
        host = f"host:{ev.host}" if ev.host else None
        if ip:
            node(ip, "ip", ev.source_ip)
        if user:
            node(user, "user", ev.username)
        if host:
            node(host, "host", ev.host)
        if ip and user:
            edge(ip, user, ev.event_type, ev.event_id)
        if user and host:
            edge(user, host, "activity_on", ev.event_id)
        elif ip and host:
            edge(ip, host, "activity_on", ev.event_id)
    return {"nodes": list(nodes.values()), "edges": list(edges.values())}


def build_case(case: dict, alerts_by_id: dict, events_by_id: dict, coverage: dict) -> dict:
    """Return everything the repository stores for one case (revision 1)."""
    alerts = [alerts_by_id[a] for a in case["alert_ids"] if a in alerts_by_id]
    events = [events_by_id[e] for e in case["event_ids"]]
    top = max(alerts, key=lambda a: _SEV_RANK.get(a.get("severity", "low"), 0))
    conf_level, conf_rationale = _lowest_confidence(alerts)
    verdict, verdict_rationale = derive_verdict(case["risk_band"], conf_level, case["risk_score"])

    attack: dict[str, dict] = {}
    for a in alerts:
        for t in a.get("mitre_attack") or []:
            m = attack.setdefault(t["technique_id"], {"technique_id": t["technique_id"], "name": t["technique_name"],
                                                       "tactic": t["tactic"], "event_ids": set()})
            m["event_ids"].update(a["event_ids"])

    missing = [
        {"missing_id": f"missing_{dim}", "telemetry": SUPPORTED_TELEMETRY.get(dim, dim),
         "why_it_matters": f"No '{SUPPORTED_TELEMETRY.get(dim, dim)}' data was present in this dataset, "
                           "so conclusions that depend on it cannot be confirmed."}
        for dim in coverage.get("dimensions_missing", [])
    ]
    return {
        "case_id": case["case_id"], "correlation_key": case["correlation_key"],
        "anchor_event_id": case["anchor_event_id"],
        "title": f"{top['title']} ({case['correlation_key']})"[:2000],
        "event_ids": list(case["event_ids"]),
        "assessment": {
            "verdict": verdict, "verdict_rationale": verdict_rationale, "severity": case["severity"],
            "risk_value": case["risk_score"], "risk_band": case["risk_band"], "risk_reasoning": case["risk_reasoning"],
            "confidence_level": conf_level, "confidence_rationale": conf_rationale,
            "coverage_ratio": coverage.get("coverage_ratio", 0),
            "coverage_present": coverage.get("dimensions_present", []),
            "coverage_missing": coverage.get("dimensions_missing", []),
            "primary_entities": _entities(events), "graph": _graph(events),
        },
        "findings": [{"finding_id": a["alert_id"], "rule_id": a["rule_id"], "title": a["title"],
                      "description": a["description"], "severity": a["severity"], "stance": a["stance"],
                      "weight": a["weight"], "evidence": a.get("evidence"), "event_ids": list(a["event_ids"])}
                     for a in alerts],
        "attack_mappings": [{**m, "event_ids": sorted(m["event_ids"])} for m in attack.values()],
        "missing_evidence": missing,
    }
