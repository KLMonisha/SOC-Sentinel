
import json
import hashlib

from datetime import datetime, timezone
from typing import Any

from app.models.events import SecurityEvent


SEP = "\x1f"


FIELD_ALIASES = {
    "timestamp": ["timestamp", "time", "@timestamp"],
    "username": ["username", "user", "user_name"],
    "source_ip": ["source_ip", "ip", "client_ip", "src_ip"],
    "destination_ip": ["destination_ip", "dest_ip", "dst_ip"],
    "host": ["host", "hostname", "server"],
    "resource": ["resource", "path", "url", "endpoint"],
    "event_type": ["event_type", "event", "action"],
}


EVENT_MAPPING = {
    "failed_login": ("authentication_failure", "failure"),
    "login_failed": ("authentication_failure", "failure"),
    "failure": ("authentication_failure", "failure"),
    "success_login": ("authentication_success", "success"),
    "successful_login": ("authentication_success", "success"),
    "login_success": ("authentication_success", "success"),
    "access_denied": ("web_access", "failure"),
    "web_access_denied": ("web_access", "failure"),
    "web_request": ("web_access", "unknown"),
}


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def derive_dataset_id(file_sha256: str) -> str:
    return "ds_" + file_sha256[:16]


def derive_event_id(
    dataset_id: str,
    source_file: str,
    line_number: int,
    raw_sha256: str
) -> str:
    identity = SEP.join([
        dataset_id,
        source_file,
        str(line_number),
        raw_sha256
    ])
    return "evt_" + sha256_hex(identity)[:16]


def derive_case_id(
    dataset_id: str,
    correlation_key: str,
    anchor_event_id: str
) -> str:
    identity = SEP.join([
        dataset_id,
        correlation_key,
        anchor_event_id
    ])
    return "case_" + sha256_hex(identity)[:16]


def get_field(record: dict, standard_name: str):
    for alias in FIELD_ALIASES.get(standard_name, []):
        if alias in record and record[alias] not in (None, ""):
            return record[alias]
    return None


def parse_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        timestamp = value
    elif isinstance(value, str):
        timestamp = datetime.fromisoformat(
            value.strip().replace("Z", "+00:00")
        )
    else:
        raise ValueError("Invalid timestamp format")

    if timestamp.tzinfo is None:
        raise ValueError("Timestamp must include timezone information")

    return timestamp.astimezone(timezone.utc)


def normalize_event_type(record: dict):
    raw_event = get_field(record, "event_type")

    raw_outcome = record.get("outcome")
    explicit_outcome = None

    if raw_outcome is not None and str(raw_outcome).strip():
        explicit_outcome = str(raw_outcome).strip().lower()

        if explicit_outcome not in {"success", "failure", "unknown"}:
            raise ValueError(f"Invalid outcome: {explicit_outcome}")

    if raw_event:
        event_name = str(raw_event).strip().lower()

        if event_name in EVENT_MAPPING:
            event_type, inferred_outcome = EVENT_MAPPING[event_name]
        else:
            event_type = event_name
            inferred_outcome = "unknown"

        return event_type, explicit_outcome or inferred_outcome

    status = record.get("status")

    if status is not None:
        try:
            status = int(status)
        except (ValueError, TypeError):
            raise ValueError("Invalid HTTP status code")

        if not 100 <= status <= 599:
            raise ValueError("HTTP status must be between 100 and 599")

        inferred_outcome = "failure" if status >= 400 else "success"
        return "web_access", explicit_outcome or inferred_outcome

    raise ValueError("Could not determine event type")


def generate_hash(record: dict) -> str:
    """Legacy canonical JSON hash, retained for transition checks."""
    canonical_record = json.dumps(
        record,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False
    )
    return sha256_hex(canonical_record)


def normalize_record(
    record: dict,
    source: str,
    row_index: int,
    dataset_id: str,
    raw_text: str
) -> SecurityEvent:
    """Normalize a record while preserving its provenance."""

    if not isinstance(record, dict):
        raise ValueError("Each log record must be an object")

    if not isinstance(raw_text, str) or not raw_text:
        raise ValueError("Raw record text must not be empty")

    timestamp_value = get_field(record, "timestamp")

    if timestamp_value is None:
        raise ValueError("Missing timestamp")

    timestamp = parse_timestamp(timestamp_value)
    event_type, outcome = normalize_event_type(record)

    # Integrity hash: exact record text, not normalized JSON.
    raw_sha256 = sha256_hex(raw_text)

    # Retain the previous hash separately for transition/debugging.
    canonical_json_sha256 = generate_hash(record)

    event_id = derive_event_id(
        dataset_id,
        source,
        row_index,
        raw_sha256
    )

    return SecurityEvent(
        event_id=event_id,
        dataset_id=dataset_id,
        timestamp=timestamp,
        event_type=event_type,
        username=get_field(record, "username"),
        source_ip=get_field(record, "source_ip"),
        destination_ip=get_field(record, "destination_ip"),
        host=get_field(record, "host"),
        resource=get_field(record, "resource"),
        outcome=outcome,
        source=source,
        line_number=row_index,
        raw_text=raw_text,
        raw_hash=raw_sha256,
        canonical_json_sha256=canonical_json_sha256,
        raw_record=record
    )
