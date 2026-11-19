import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


InvestigationTool = Literal[
    "get_related_auth_events",
    "get_post_login_activity",
    "get_ip_context",
]


class InvestigationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: InvestigationTool
    params: dict[str, str] = Field(default_factory=dict)
    idempotency_key: str = Field(min_length=8, max_length=128)
    limit: int = Field(default=10, ge=1, le=50)

    @field_validator("idempotency_key")
    @classmethod
    def validate_idempotency_key(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", value):
            raise ValueError(
                "idempotency_key must contain only letters, numbers, "
                "periods, underscores, colons, or hyphens."
            )
        return value

    @field_validator("params")
    @classmethod
    def validate_params(cls, value: dict[str, str]) -> dict[str, str]:
        if any(not isinstance(k, str) or not isinstance(v, str)
               for k, v in value.items()):
            raise ValueError("Investigation params must be string values.")
        return value


class RetrievedEvidence(BaseModel):
    event_id: str
    relevance_score: int = Field(ge=0)
    match_reason: str


class InvestigationResult(BaseModel):
    tool: InvestigationTool
    retrieved_events: list[dict]
    evidence: list[RetrievedEvidence]
    retrieved_count: int
    budget_remaining: int = Field(ge=0)
    budget_consumed: int = Field(ge=0)
    request_hash: str
    message: str