
from fastapi.testclient import TestClient

from main import app


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
