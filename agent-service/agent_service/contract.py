"""The wire contract with the Bun team server (see src/shared/ai/types.ts). Field names are the contract: do not rename them."""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

RunKind = Literal[
    "mention",
    "plan",
    "minutes",
    "review",
    "import",
    # The delivery pipeline: one run kind per stage button.
    "spec",
    "design",
    "implement",
    "tests",
    "release_pack",
    "rollout_review",
]
Phase = Literal["queued", "thinking", "searching", "writing", "verifying"]
ErrorCode = Literal["budget", "model_unavailable", "invalid", "internal"]
ArtifactKind = Literal["spec", "design", "change_set", "test_report", "release_pack", "rollout_report", "exploration_report"]

# What the server accepts and cleans (src/shared/workspace/protocol.ts: LIMITS, CARD) and what we promise to stay under.
ANSWER_MAX_CHARS = 5000
HISTORY_MAX = 40
CITATIONS_MAX = 8
QUOTE_MAX = 240
CARD_LIMITS = {
    "text": 300,
    "option": 80,
    "hint": 120,
    "options": 8,
    "steps": 8,
    "step": 200,
    "agents": 6,
    "why": 200,
    "risks": 5,
    "summary": 600,
    "body": 2000,
    "items": 12,
    "item_title": 200,
    "item_body": 800,
    "labels": 8,
    "label": 40,
}


class _Wire(BaseModel):
    # An older or newer team server may send fields we do not know: ignore them rather than refuse the run.
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class Skill(_Wire):
    name: str
    body: str = ""


class AgentInfo(_Wire):
    handle: str
    displayName: str = ""
    role: str = ""
    persona: str = ""
    skills: list[Skill] = Field(default_factory=list)


class Asker(_Wire):
    uid: str = ""
    name: str = "Someone"


class HistoryLine(_Wire):
    id: str = ""
    # `from` is a Python keyword; the wire name is kept through the alias.
    from_: str = Field(default="", alias="from")
    name: str = ""
    text: str = ""
    at: float = 0
    kind: Literal["human", "agent", "system"] = "human"


class BoardLine(_Wire):
    key: int
    title: str = ""
    status: Literal["todo", "in_progress", "review", "done"] = "todo"
    assignee: str | None = None
    pr: str | None = None


class DocLine(_Wire):
    id: str
    title: str = ""
    parent: str | None = None


class RunContext(_Wire):
    board: list[BoardLine] = Field(default_factory=list)
    docs: list[DocLine] = Field(default_factory=list)


class Attachment(_Wire):
    name: str = "file"
    mime: str = "application/octet-stream"
    dataBase64: str = ""


class RunTicket(_Wire):
    id: str = ""
    key: int = 0
    title: str = ""
    body: str = ""
    stage: str = "plan"


class RunArtifactLine(_Wire):
    id: str = ""
    kind: str = "spec"
    state: str = "draft"
    version: int = 1
    title: str = ""


class RunRequest(_Wire):
    runId: str
    kind: RunKind = "mention"
    agent: AgentInfo
    asker: Asker = Field(default_factory=Asker)
    room: str = "lobby"
    question: str = ""
    history: list[HistoryLine] = Field(default_factory=list)
    context: RunContext = Field(default_factory=RunContext)
    attachments: list[Attachment] = Field(default_factory=list)
    # Set for a pipeline run: the ticket and what the pipeline already holds for it (the bodies are read through the tools).
    ticket: RunTicket | None = None
    artifacts: list[RunArtifactLine] = Field(default_factory=list)
    webBase: str = ""

    @field_validator("history")
    @classmethod
    def _latest_history(cls, v: list[HistoryLine]) -> list[HistoryLine]:
        # The contract says at most 40, oldest first. If more arrive, keep the newest 40 rather than refuse the run.
        return v[-HISTORY_MAX:]


class IndexItem(_Wire):
    kind: Literal["doc", "ticket"]
    id: str
    title: str = ""
    body: str = ""
    updatedAt: float = 0
    deleted: bool = False


class ReindexRequest(_Wire):
    items: list[IndexItem] = Field(default_factory=list)
    replaceAll: bool = False


# ───────────────────────────── Output ─────────────────────────────


class Citation(BaseModel):
    kind: Literal["doc", "ticket", "chat"]
    id: str
    title: str
    quote: str | None = None


class AskOption(BaseModel):
    id: str
    label: str
    hint: str | None = None


class AskCard(BaseModel):
    kind: Literal["ask"] = "ask"
    id: str
    mode: Literal["choice", "multi", "text"]
    prompt: str
    options: list[AskOption] = Field(default_factory=list)


class PlanAgent(BaseModel):
    handle: str
    why: str = ""
    effort: Literal["low", "medium", "high"] | None = None


class PlanBody(BaseModel):
    summary: str
    steps: list[str]
    agents: list[PlanAgent] = Field(default_factory=list)
    # `{link: "12"}` or `{create: {title, body}}` or null, exactly as the web app's PlanCard has it.
    ticket: dict[str, Any] | None = None
    risks: list[str] = Field(default_factory=list)


class PlanCardOut(BaseModel):
    kind: Literal["plan"] = "plan"
    plan: PlanBody


class ResultCard(BaseModel):
    kind: Literal["result"] = "result"
    summary: str
    status: Literal["done", "blocked"]
    branch: str | None = None
    ticket: str | None = None


class ProposalItem(BaseModel):
    id: str
    type: Literal["ticket", "doc"]
    title: str
    body: str = ""
    labels: list[str] | None = None
    points: int | None = None
    duplicateOf: int | None = None


class ProposalCard(BaseModel):
    kind: Literal["proposal"] = "proposal"
    id: str
    title: str
    items: list[ProposalItem]


ChatCard = Annotated[AskCard | PlanCardOut | ResultCard | ProposalCard, Field(discriminator="kind")]


class ArtifactFile(BaseModel):
    """One file of a change set, exactly as `src/shared/pipeline/types.ts` has it."""

    path: str = ""
    op: Literal["write", "delete"] = "write"
    role: Literal["src", "unit_test", "e2e_test"] = "src"
    content: str = ""
    baseSha: str | None = None


class ArtifactDraftOut(BaseModel):
    """What a pipeline agent hands back. The team server gives it an id, a version and a digest, and a person accepts it."""

    kind: ArtifactKind
    title: str = ""
    body: str = ""
    files: list[ArtifactFile] = Field(default_factory=list)
    meta: dict[str, Any] | None = None


class Usage(BaseModel):
    model: str
    inputTokens: int = 0
    outputTokens: int = 0
    seconds: float = 0.0


class Final(BaseModel):
    text: str
    citations: list[Citation] = Field(default_factory=list)
    cards: list[ChatCard] = Field(default_factory=list)
    artifacts: list[ArtifactDraftOut] = Field(default_factory=list)
    usage: Usage


def dump(model: BaseModel) -> dict[str, Any]:
    """JSON-ready, without the optional fields that were never set (the web side treats `undefined` and absent alike)."""
    return model.model_dump(mode="json", exclude_none=True)


def sse(event: str, data: dict[str, Any]) -> str:
    """One server-sent event. `data` is a single JSON line, so no line of it can be taken for a field."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"
