
import csv
import json

from pathlib import Path
from typing import Any

from app.models.events import SecurityEvent
from app.services.normalization import normalize_record


MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_RECORDS = 10000


def read_csv(file_path: Path) -> list[tuple[int, dict[str, Any]]]:
    """Reads CSV records as dictionaries."""

    with file_path.open(
        "r",
        encoding="utf-8-sig",
        newline=""
    ) as file:

        reader = csv.DictReader(file)

        if not reader.fieldnames:
            raise ValueError("CSV file has no header")

        return [
            (row_number, dict(row))
            for row_number, row in enumerate(reader, start=2)
        ]


def read_json(file_path: Path) -> list[tuple[int, Any]]:
    """Reads a JSON array or an object containing a records array."""

    with file_path.open("r", encoding="utf-8-sig") as file:
        data = json.load(file)

    if isinstance(data, dict):
        data = data.get("records")

    if not isinstance(data, list):
        raise ValueError(
            "JSON must contain an array of records "
            "or an object with a 'records' array"
        )

    return [
        (index + 1, record)
        for index, record in enumerate(data)
    ]


def read_file(file_path: Path) -> list[tuple[int, Any]]:
    """Selects the appropriate reader based on file extension."""

    extension = file_path.suffix.lower()

    if extension == ".csv":
        return read_csv(file_path)

    if extension == ".json":
        return read_json(file_path)

    raise ValueError("Unsupported file format. Use CSV or JSON.")


def ingest_file(
    file_path: str | Path,
    source_name: str | None = None
) -> dict:
    """
    Reads a complete log file, normalizes valid records,
    and quarantines invalid records.
    """

    file_path = Path(file_path)

    if not file_path.exists():
        raise FileNotFoundError("Log file does not exist")

    if not file_path.is_file():
        raise ValueError("Provided path is not a file")

    if file_path.stat().st_size > MAX_FILE_SIZE:
        raise ValueError("File exceeds the 10 MB size limit")

    records = read_file(file_path)

    if len(records) > MAX_RECORDS:
        raise ValueError("File exceeds the 10,000 record limit")

    valid_events = []
    quarantined_records = []

    source = source_name or file_path.name

    for row_number, record in records:

        try:
            event = normalize_record(
                record=record,
                source=source,
                row_index=row_number
            )

            valid_events.append(event)

        except Exception as error:
            quarantined_records.append({
                "row_number": row_number,
                "reason": str(error),
                "raw_record": record
            })

    return {
        "dataset": source,
        "total_records": len(records),
        "valid_count": len(valid_events),
        "quarantined_count": len(quarantined_records),
        "events": valid_events,
        "quarantined_records": quarantined_records
    }
