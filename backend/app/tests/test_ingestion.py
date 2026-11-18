
import json

import pytest

from app.services.ingestion import ingest_file


def test_csv_ingestion(tmp_path):

    csv_content = (
        "timestamp,username,ip,event\n"
        "2026-11-18T10:00:00Z,alice,192.0.2.10,failed_login\n"
        "2026-11-18T10:01:00Z,bob,192.0.2.20,success_login\n"
    )

    file_path = tmp_path / "auth.csv"
    file_path.write_text(csv_content, encoding="utf-8")

    result = ingest_file(file_path)

    assert result["total_records"] == 2
    assert result["valid_count"] == 2
    assert result["quarantined_count"] == 0


def test_json_ingestion(tmp_path):

    records = [
        {
            "time": "2026-11-18T10:00:00Z",
            "user": "alice",
            "source_ip": "192.0.2.10",
            "path": "/admin",
            "status": 403
        }
    ]

    file_path = tmp_path / "web.json"

    file_path.write_text(
        json.dumps(records),
        encoding="utf-8"
    )

    result = ingest_file(file_path)

    assert result["valid_count"] == 1
    assert result["events"][0].resource == "/admin"


def test_invalid_record_quarantined(tmp_path):

    records = [
        {
            "timestamp": "2026-11-18T10:00:00Z",
            "username": "alice",
            "event": "failed_login"
        },
        {
            "timestamp": "invalid_timestamp",
            "username": "bob",
            "event": "failed_login"
        }
    ]

    file_path = tmp_path / "auth.json"

    file_path.write_text(
        json.dumps(records),
        encoding="utf-8"
    )

    result = ingest_file(file_path)

    assert result["valid_count"] == 1
    assert result["quarantined_count"] == 1
    assert result["quarantined_records"][0]["row_number"] == 2


def test_missing_file():

    with pytest.raises(FileNotFoundError):
        ingest_file("missing.csv")


def test_unsupported_format(tmp_path):

    file_path = tmp_path / "logs.txt"
    file_path.write_text("test", encoding="utf-8")

    with pytest.raises(ValueError):
        ingest_file(file_path)


def test_file_size_limit(tmp_path):

    file_path = tmp_path / "large.csv"
    file_path.write_bytes(b"x" * (10 * 1024 * 1024 + 1))

    with pytest.raises(ValueError, match="10 MB"):
        ingest_file(file_path)


def test_empty_csv(tmp_path):

    file_path = tmp_path / "empty.csv"
    file_path.write_text("", encoding="utf-8")

    with pytest.raises(ValueError, match="header"):
        ingest_file(file_path)


def test_json_object_with_records(tmp_path):

    data = {
        "records": [
            {
                "timestamp": "2026-11-18T10:00:00Z",
                "username": "alice",
                "event": "failed_login"
            }
        ]
    }

    file_path = tmp_path / "wrapped.json"

    file_path.write_text(
        json.dumps(data),
        encoding="utf-8"
    )

    result = ingest_file(file_path)

    assert result["valid_count"] == 1
    assert result["quarantined_count"] == 0
