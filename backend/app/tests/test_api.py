
from fastapi.testclient import TestClient

from main import app

import json

client = TestClient(app)


def test_health_endpoint():
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


def test_reject_unsupported_file():
    response = client.post(
        "/api/analyze",
        files={
            "file": (
                "logs.txt",
                b"some log data",
                "text/plain"
            )
        }
    )

    assert response.status_code == 400


def test_reject_empty_file():
    response = client.post(
        "/api/analyze",
        files={
            "file": (
                "logs.csv",
                b"",
                "text/csv"
            )
        }
    )

    assert response.status_code == 400


def test_analyze_csv_upload():
    csv_content = (
        "timestamp,event_type,username,source_ip,resource\n"
        "2026-11-18T10:00:00Z,authentication_failure,alice,192.168.1.10,/login\n"
        "2026-11-18T10:01:00Z,authentication_failure,alice,192.168.1.10,/login\n"
        "2026-11-18T10:02:00Z,authentication_failure,alice,192.168.1.10,/login\n"
        "2026-11-18T10:03:00Z,authentication_failure,alice,192.168.1.10,/login\n"
        "2026-11-18T10:04:00Z,authentication_failure,alice,192.168.1.10,/login\n"
    )

    response = client.post(
        "/api/analyze",
        files={
            "file": (
                "brute_force.csv",
                csv_content.encode(),
                "text/csv"
            )
        }
    )

    assert response.status_code == 200

    data = response.json()

    assert data["status"] == "success"
    assert data["dataset"] == "brute_force.csv"
    assert data["summary"]["total_records"] == 5
    assert data["summary"]["valid_events"] == 5
    assert data["summary"]["alerts_generated"] >= 1
    assert data["summary"]["incidents_created"] >= 1


def test_response_does_not_expose_raw_quarantined_records():
    csv_content = (
        "timestamp,event_type,username,source_ip\n"
        "invalid-timestamp,authentication_failure,alice,192.168.1.10\n"
    )

    response = client.post(
        "/api/analyze",
        files={
            "file": (
                "invalid.csv",
                csv_content.encode(),
                "text/csv"
            )
        }
    )

    assert response.status_code == 200

    data = response.json()

    assert data["summary"]["quarantined_records"] == 1
    assert "raw_record" not in data["quarantined_records"][0]

def test_counterfactual_endpoint():
    csv_content = (
        "timestamp,event_type,username,source_ip,resource\n"
        "2026-11-18T10:00:00Z,authentication_failure,alice,192.168.1.10,/login\n"
        "2026-11-18T10:01:00Z,authentication_failure,alice,192.168.1.10,/login\n"
        "2026-11-18T10:02:00Z,authentication_failure,alice,192.168.1.10,/login\n"
        "2026-11-18T10:03:00Z,authentication_failure,alice,192.168.1.10,/login\n"
        "2026-11-18T10:04:00Z,authentication_failure,alice,192.168.1.10,/login\n"
    )

    # First, analyze the original dataset.
    original_response = client.post(
        "/api/analyze",
        files={
            "file": (
                "brute_force.csv",
                csv_content.encode(),
                "text/csv"
            )
        }
    )

    assert original_response.status_code == 200

    original_data = original_response.json()

    assert original_data["summary"]["alerts_generated"] >= 1

    # Select one event from the original alert.
    event_id = original_data["alerts"][0]["event_ids"][0]

    # Now run a hypothetical investigation.
    response = client.post(
        "/api/counterfactual",
        files={
            "file": (
                "brute_force.csv",
                csv_content.encode(),
                "text/csv"
            )
        },
        data={
            "event_ids_to_exclude": json.dumps([event_id]),
            "reason": "Testing whether one failed login changes the finding."
        }
    )

    assert response.status_code == 200

    data = response.json()
    result = data["counterfactual"]

    assert data["status"] == "success"

    assert result["original"]["event_count"] == 5
    assert result["hypothetical"]["event_count"] == 4

    assert len(result["original"]["alerts"]) == 1
    assert len(result["hypothetical"]["alerts"]) == 0

    assert result["comparison"]["original_max_risk_score"] > 0
    assert result["comparison"]["hypothetical_max_risk_score"] == 0

    assert result["original_data_modified"] is False


def test_counterfactual_rejects_invalid_event_ids_format():
    csv_content = (
        "timestamp,event_type,username,source_ip\n"
        "2026-11-18T10:00:00Z,authentication_failure,alice,192.168.1.10\n"
    )

    response = client.post(
        "/api/counterfactual",
        files={
            "file": (
                "logs.csv",
                csv_content.encode(),
                "text/csv"
            )
        },
        data={
            "event_ids_to_exclude": "not-valid-json",
            "reason": "Testing invalid input."
        }
    )

    assert response.status_code == 400


def test_counterfactual_rejects_unknown_event_id():
    csv_content = (
        "timestamp,event_type,username,source_ip\n"
        "2026-11-18T10:00:00Z,authentication_failure,alice,192.168.1.10\n"
    )

    response = client.post(
        "/api/counterfactual",
        files={
            "file": (
                "logs.csv",
                csv_content.encode(),
                "text/csv"
            )
        },
        data={
            "event_ids_to_exclude": json.dumps(["unknown_event"]),
            "reason": "Testing an unknown event."
        }
    )

    assert response.status_code == 400