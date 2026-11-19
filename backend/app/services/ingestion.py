
import csv
import hashlib
import io
import json
import unicodedata

from pathlib import Path
from typing import Any

from app.models.events import SecurityEvent
from app.services.normalization import (
    derive_dataset_id,
    normalize_record,
)


MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_RECORDS = 10000


def read_csv(file_path: Path) -> list[tuple[int, dict[str, Any]]]:
    """Reads CSV records as dictionaries. Preserves the existing interface."""

    with file_path.open("r", encoding="utf-8-sig", newline="") as file:
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


def _canonical_source_name(source_name: str) -> str:
    """Produces a safe canonical basename for event provenance."""

    normalized = str(source_name).replace("\\", "/")
    name = normalized.split("/")[-1]

    name = "".join(
        char for char in name
        if unicodedata.category(char) != "Cc"
    )

    name = name[:255].strip()

    if not name:
        raise ValueError("Source filename is empty or invalid")

    return name


def _remove_one_line_ending(value: str) -> str:
    """Removes exactly one terminal physical line ending."""

    if value.endswith("\r\n"):
        return value[:-2]

    if value.endswith("\n") or value.endswith("\r"):
        return value[:-1]

    return value


def _read_csv_with_provenance(
    text: str,
) -> list[tuple[int, dict[str, Any], str]]:
    """
    Reads CSV records while preserving their original physical text
    and 1-based physical starting line number.
    """

    physical_lines = text.splitlines(keepends=True)
    reader = csv.reader(io.StringIO(text, newline=""))

    try:
        headers = next(reader)
    except StopIteration:
        raise ValueError("CSV file has no header")

    if not headers:
        raise ValueError("CSV file has no header")

    previous_end_line = reader.line_num
    records = []

    while True:
        start_line = previous_end_line + 1

        try:
            row = next(reader)
        except StopIteration:
            break

        end_line = reader.line_num
        previous_end_line = end_line

        # Match DictReader's behavior of ignoring blank rows.
        if not row:
            continue

        record = {}

        for index, header in enumerate(headers):
            record[header] = row[index] if index < len(row) else None

        # Preserve extra CSV columns in the same way DictReader does.
        if len(row) > len(headers):
            record[None] = row[len(headers):]

        raw_text = "".join(
            physical_lines[start_line - 1:end_line]
        )
        raw_text = _remove_one_line_ending(raw_text)

        records.append((start_line, record, raw_text))

    return records


def _read_json_with_provenance(
    text: str,
) -> list[tuple[int, Any, str]]:
    """
    Reads JSON records and creates compact, key-order-preserving
    representations for provenance hashing.
    """

    data = json.loads(text)

    if isinstance(data, dict):
        data = data.get("records")

    if not isinstance(data, list):
        raise ValueError(
            "JSON must contain an array of records "
            "or an object with a 'records' array"
        )

    return [
        (
            index + 1,
            record,
            json.dumps(
                record,
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        for index, record in enumerate(data)
    ]


def _read_records_with_provenance(
    file_path: Path,
    text: str,
) -> list[tuple[int, Any, str]]:
    extension = file_path.suffix.lower()

    if extension == ".csv":
        return _read_csv_with_provenance(text)

    if extension == ".json":
        return _read_json_with_provenance(text)

    raise ValueError("Unsupported file format. Use CSV or JSON.")


def ingest_file(
    file_path: str | Path,
    source_name: str | None = None,
) -> dict:
    """
    Reads a complete log file, normalizes valid records,
    and quarantines invalid records with provenance.
    """

    file_path = Path(file_path)

    if not file_path.exists():
        raise FileNotFoundError("Log file does not exist")

    if not file_path.is_file():
        raise ValueError("Provided path is not a file")

    file_bytes = file_path.read_bytes()

    if len(file_bytes) > MAX_FILE_SIZE:
        raise ValueError("File exceeds the 10 MB size limit")

    file_sha256 = hashlib.sha256(file_bytes).hexdigest()
    dataset_id = derive_dataset_id(file_sha256)

    # utf-8-sig removes a UTF-8 BOM, if present.
    text = file_bytes.decode("utf-8-sig")

    source = _canonical_source_name(source_name or file_path.name)

    records = _read_records_with_provenance(file_path, text)

    if len(records) > MAX_RECORDS:
        raise ValueError("File exceeds the 10,000 record limit")

    valid_events: list[SecurityEvent] = []
    quarantined_records = []

    for row_number, record, raw_text in records:
        try:
            event = normalize_record(
                record=record,
                source=source,
                row_index=row_number,
                dataset_id=dataset_id,
                raw_text=raw_text,
            )

            valid_events.append(event)

        except Exception as error:
            quarantined_records.append({
                "row_number": row_number,
                "reason": str(error)[:20000],
                "raw_record": record,
                "raw_text": raw_text,
            })

    return {
        "dataset": source,
        "dataset_id": dataset_id,
        "file_sha256": file_sha256,
        "source_file": source,
        "total_records": len(records),
        "valid_count": len(valid_events),
        "quarantined_count": len(quarantined_records),
        "events": valid_events,
        "quarantined_records": quarantined_records,
    }
