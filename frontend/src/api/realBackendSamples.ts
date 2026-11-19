/**
 * REAL responses recorded from Member 1's backend (origin/backend-dev @ d74a66c) on 2026-11-19, using the demo
 * dataset of 8 rows (6 failed logins, a success, one unrelated login). Kept verbatim (counterfactual alerts
 * trimmed to one each) so contract tests can detect when the backend adopts the agreed shapes.
 * These are NOT development fixtures: they came from the real backend. See INTEGRATION_STATUS.md.
 */
export const realAnalyzeResponse = {
  "status": "success",
  "dataset": "brute.csv",
  "summary": {
    "total_records": 8,
    "valid_events": 8,
    "quarantined_records": 0,
    "alerts_generated": 2,
    "incidents_created": 1
  },
  "alerts": [
    {
      "alert_id": "alert_3ffbc02a82637cc5",
      "rule_id": "DET-001",
      "title": "Possible Brute-Force Attack",
      "severity": "high",
      "description": "5 failed login attempts were detected from 203.0.113.45 against user alice within 10 minutes.",
      "event_ids": [
        "evt_03cc0d991bd4025a",
        "evt_733b2f3931f7fbe2",
        "evt_7407af3cf609ab0f",
        "evt_c8e1711f6fbe6012",
        "evt_da5c3d0be28d843d"
      ],
      "evidence": {
        "source_ip": "203.0.113.45",
        "username": "alice",
        "failed_attempts": 5,
        "window_minutes": 10
      }
    },
    {
      "alert_id": "alert_857b4db1a3d83b6a",
      "rule_id": "DET-002",
      "title": "Successful Login After Repeated Failures",
      "severity": "critical",
      "description": "A successful login for alice from 203.0.113.45 followed at least 3 failed login attempts within 15 minutes.",
      "event_ids": [
        "evt_733b2f3931f7fbe2",
        "evt_c9546fafb941c33e",
        "evt_da5c3d0be28d843d",
        "evt_ede478609b2a7901"
      ],
      "evidence": {
        "source_ip": "203.0.113.45",
        "username": "alice",
        "failed_attempts_before_success": 6,
        "window_minutes": 15,
        "successful_event_id": "evt_c9546fafb941c33e"
      }
    }
  ],
  "incidents": [
    {
      "incident_id": "inc_6184bffb6bd4d070",
      "correlation_key": "203.0.113.45",
      "alert_ids": [
        "alert_3ffbc02a82637cc5",
        "alert_857b4db1a3d83b6a"
      ],
      "event_ids": [
        "evt_03cc0d991bd4025a",
        "evt_733b2f3931f7fbe2",
        "evt_7407af3cf609ab0f",
        "evt_c8e1711f6fbe6012",
        "evt_c9546fafb941c33e",
        "evt_da5c3d0be28d843d",
        "evt_ede478609b2a7901"
      ],
      "alert_count": 2,
      "risk_score": 100,
      "severity": "critical",
      "risk_reasoning": [
        "Highest contributing alert severity: critical.",
        "2 distinct detection rule(s) contributed.",
        "7 distinct event(s) support the incident.",
        "Risk score: 80 base + 8 rule bonus + 12 evidence bonus."
      ],
      "status": "open"
    }
  ],
  "quarantined_records": []
} as const;

export const realCounterfactualResponse = {
  "status": "success",
  "dataset": "brute.csv",
  "summary": {
    "total_records": 8,
    "valid_events": 8,
    "quarantined_records": 0
  },
  "counterfactual": {
    "simulation_type": "event_exclusion",
    "reason": "drop two failures",
    "excluded_event_ids": [
      "evt_03cc0d991bd4025a",
      "evt_733b2f3931f7fbe2"
    ],
    "original": {
      "event_count": 8,
      "alerts": [
        {
          "alert_id": "alert_3ffbc02a82637cc5",
          "rule_id": "DET-001",
          "title": "Possible Brute-Force Attack",
          "severity": "high",
          "description": "5 failed login attempts were detected from 203.0.113.45 against user alice within 10 minutes.",
          "event_ids": [
            "evt_03cc0d991bd4025a",
            "evt_733b2f3931f7fbe2",
            "evt_7407af3cf609ab0f",
            "evt_c8e1711f6fbe6012",
            "evt_da5c3d0be28d843d"
          ],
          "evidence": {
            "source_ip": "203.0.113.45",
            "username": "alice",
            "failed_attempts": 5,
            "window_minutes": 10
          }
        }
      ],
      "incidents": [
        {
          "incident_id": "inc_6184bffb6bd4d070",
          "correlation_key": "203.0.113.45",
          "alert_ids": [
            "alert_3ffbc02a82637cc5",
            "alert_857b4db1a3d83b6a"
          ],
          "event_ids": [
            "evt_03cc0d991bd4025a",
            "evt_733b2f3931f7fbe2",
            "evt_7407af3cf609ab0f",
            "evt_c8e1711f6fbe6012",
            "evt_c9546fafb941c33e",
            "evt_da5c3d0be28d843d",
            "evt_ede478609b2a7901"
          ],
          "alert_count": 2,
          "risk_score": 100,
          "severity": "critical",
          "risk_reasoning": [
            "Highest contributing alert severity: critical.",
            "2 distinct detection rule(s) contributed.",
            "7 distinct event(s) support the incident.",
            "Risk score: 80 base + 8 rule bonus + 12 evidence bonus."
          ],
          "status": "open"
        }
      ]
    },
    "hypothetical": {
      "event_count": 6,
      "alerts": [
        {
          "alert_id": "alert_95f4912e449b19c4",
          "rule_id": "DET-002",
          "title": "Successful Login After Repeated Failures",
          "severity": "critical",
          "description": "A successful login for alice from 203.0.113.45 followed at least 3 failed login attempts within 15 minutes.",
          "event_ids": [
            "evt_c8e1711f6fbe6012",
            "evt_c9546fafb941c33e",
            "evt_da5c3d0be28d843d",
            "evt_ede478609b2a7901"
          ],
          "evidence": {
            "source_ip": "203.0.113.45",
            "username": "alice",
            "failed_attempts_before_success": 4,
            "window_minutes": 15,
            "successful_event_id": "evt_c9546fafb941c33e"
          }
        }
      ],
      "incidents": [
        {
          "incident_id": "inc_b7b85319e96af634",
          "correlation_key": "203.0.113.45",
          "alert_ids": [
            "alert_95f4912e449b19c4"
          ],
          "event_ids": [
            "evt_c8e1711f6fbe6012",
            "evt_c9546fafb941c33e",
            "evt_da5c3d0be28d843d",
            "evt_ede478609b2a7901"
          ],
          "alert_count": 1,
          "risk_score": 88,
          "severity": "critical",
          "risk_reasoning": [
            "Highest contributing alert severity: critical.",
            "1 distinct detection rule(s) contributed.",
            "4 distinct event(s) support the incident.",
            "Risk score: 80 base + 0 rule bonus + 8 evidence bonus."
          ],
          "status": "open"
        }
      ]
    },
    "comparison": {
      "alerts_added": [
        {
          "alert_id": "alert_95f4912e449b19c4",
          "rule_id": "DET-002",
          "title": "Successful Login After Repeated Failures",
          "severity": "critical",
          "description": "A successful login for alice from 203.0.113.45 followed at least 3 failed login attempts within 15 minutes.",
          "event_ids": [
            "evt_c8e1711f6fbe6012",
            "evt_c9546fafb941c33e",
            "evt_da5c3d0be28d843d",
            "evt_ede478609b2a7901"
          ],
          "evidence": {
            "source_ip": "203.0.113.45",
            "username": "alice",
            "failed_attempts_before_success": 4,
            "window_minutes": 15,
            "successful_event_id": "evt_c9546fafb941c33e"
          }
        }
      ],
      "alerts_removed": [
        {
          "alert_id": "alert_3ffbc02a82637cc5",
          "rule_id": "DET-001",
          "title": "Possible Brute-Force Attack",
          "severity": "high",
          "description": "5 failed login attempts were detected from 203.0.113.45 against user alice within 10 minutes.",
          "event_ids": [
            "evt_03cc0d991bd4025a",
            "evt_733b2f3931f7fbe2",
            "evt_7407af3cf609ab0f",
            "evt_c8e1711f6fbe6012",
            "evt_da5c3d0be28d843d"
          ],
          "evidence": {
            "source_ip": "203.0.113.45",
            "username": "alice",
            "failed_attempts": 5,
            "window_minutes": 10
          }
        },
        {
          "alert_id": "alert_857b4db1a3d83b6a",
          "rule_id": "DET-002",
          "title": "Successful Login After Repeated Failures",
          "severity": "critical",
          "description": "A successful login for alice from 203.0.113.45 followed at least 3 failed login attempts within 15 minutes.",
          "event_ids": [
            "evt_733b2f3931f7fbe2",
            "evt_c9546fafb941c33e",
            "evt_da5c3d0be28d843d",
            "evt_ede478609b2a7901"
          ],
          "evidence": {
            "source_ip": "203.0.113.45",
            "username": "alice",
            "failed_attempts_before_success": 6,
            "window_minutes": 15,
            "successful_event_id": "evt_c9546fafb941c33e"
          }
        }
      ],
      "alerts_unchanged": [],
      "incidents_added": [
        "inc_b7b85319e96af634"
      ],
      "incidents_removed": [
        "inc_6184bffb6bd4d070"
      ],
      "incidents_unchanged": [],
      "original_max_risk_score": 100,
      "hypothetical_max_risk_score": 88,
      "risk_score_change": -12,
      "original_highest_severity": "critical",
      "hypothetical_highest_severity": "critical",
      "per_incident_changes": [
        {
          "incident_id": "inc_6184bffb6bd4d070",
          "correlation_key": "203.0.113.45",
          "change_type": "removed",
          "original_risk_score": 100,
          "hypothetical_risk_score": 0,
          "risk_score_change": -100,
          "original_severity": "critical",
          "hypothetical_severity": null
        },
        {
          "incident_id": "inc_b7b85319e96af634",
          "correlation_key": "203.0.113.45",
          "change_type": "added",
          "original_risk_score": 0,
          "hypothetical_risk_score": 88,
          "risk_score_change": 88,
          "original_severity": null,
          "hypothetical_severity": "critical"
        }
      ]
    },
    "original_data_modified": false
  }
} as const;

export const realErrorResponse = { detail: "Unknown event IDs: ['evt_nope']" } as const;
