
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


InvestigationTool = Literal[
    "search_by_entity",
    "search_time_window",
    "expand_related_events"
]

EntityType = Literal[
    "username",
    "source_ip",
    "destination_ip",
    "host",
    "resource"
]


class InvestigationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: InvestigationTool

    # Used by search_by_entity
    entity_type: EntityType | None = None
    entity_value: str | None = None

    # Used by search_time_window (timezone-aware ISO timestamps)
    start_time: str | None = None
    end_time: str | None = None

    # Used by expand_related_events
    seed_event_ids: list[str] = Field(default_factory=list)

    # Maximum number of additional events returned by one call
    limit: int = Field(default=10, ge=1, le=50)


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
    message: str
