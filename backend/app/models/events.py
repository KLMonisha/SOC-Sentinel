
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SecurityEvent(BaseModel):

    model_config = ConfigDict(extra="forbid")

    event_id: str = Field(min_length=1)

    timestamp: datetime

    event_type: str = Field(min_length=1)

    username: Optional[str] = None

    source_ip: Optional[str] = None

    destination_ip: Optional[str] = None

    host: Optional[str] = None

    resource: Optional[str] = None

    outcome: str = "unknown"

    source: str = Field(min_length=1)

    raw_hash: str = Field(min_length=64, max_length=64)

    raw_record: dict[str, Any] = Field(default_factory=dict)

    @field_validator("timestamp")
    @classmethod
    def ensure_utc(cls, value: datetime):
        if value.tzinfo is None:
            raise ValueError("Timestamp must include timezone information")

        return value.astimezone(timezone.utc)

    @field_validator("outcome")
    @classmethod
    def validate_outcome(cls, value: str):
        allowed = {"success", "failure", "unknown"}

        if value not in allowed:
            raise ValueError("Invalid event outcome")

        return value
