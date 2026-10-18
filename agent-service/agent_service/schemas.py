"""Structured outputs the agents hand to each other (Gemini `response_schema`). Kept flat and simple: models follow flat schemas well.

Every field carries a default and every layer is normalized in the pipeline that consumes it. A model that phrases a status
differently, omits a line or writes a criterion as a plain string must never end a run: the run degrades to "unclear" or an empty
answer, and the person still gets a reply.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator

from typing import Literal

from .contract import ArtifactFile

# ───────────────────────── Librarian ─────────────────────────


class Claim(BaseModel):
    text: str = Field(default="", description="One self-contained sentence that states one fact taken from the passages.")
    evidence: list[str] = Field(default_factory=list, description='Labels of the passages that support it, for example ["P1", "P3"].')
    quote: str = Field(default="", description="A short exact quote, word for word, from the first cited passage.")

    @field_validator("evidence", mode="before")
    @classmethod
    def _evidence(cls, v: Any) -> list[str]:
        if isinstance(v, str):
            return [x.strip() for x in v.replace(";", ",").split(",") if x.strip()]
        return [str(x) for x in v] if isinstance(v, list) else []


class Draft(BaseModel):
    can_answer: bool = Field(default=False, description="False when the passages do not answer the question.")
    claims: list[Claim] = Field(default_factory=list, description="At most 8 claims.")
    missing: str = Field(default="", description="What the question asks that the passages do not cover, in a few words.")

    @field_validator("claims", mode="before")
    @classmethod
    def _claims(cls, v: Any) -> list[Any]:
        # A model may write a claim as a bare sentence: keep the run alive.
        return [{"text": x} if isinstance(x, str) else x for x in v] if isinstance(v, list) else []


class ClaimVerdict(BaseModel):
    index: int = Field(default=0, description="The claim's number, starting at 1.")
    supported: bool = Field(default=False, description="True only if the cited passages say this, without adding or changing details.")
    reason: str = Field(default="", description="A few words: what is missing or wrong, or where it is said.")


class Verdict(BaseModel):
    verdicts: list[ClaimVerdict] = Field(default_factory=list)

    @field_validator("verdicts", mode="before")
    @classmethod
    def _verdicts(cls, v: Any) -> list[Any]:
        # Strings cannot be judged and are dropped; the gate fails closed for the claims it never saw.
        return [x for x in v if not isinstance(x, str)] if isinstance(v, list) else []


# ───────────────────────── Planner Agent ─────────────────────────


class PlannerAgent(BaseModel):
    handle: str = Field(default="", description="A colleague's handle from the roster.")
    why: str = Field(default="", description="One sentence: what this colleague does in the plan.")
    effort: str = Field(default="medium", description='One of "low", "medium" or "high".')


class AskOptionOut(BaseModel):
    id: str = Field(default="", description="Short lowercase id such as a, b, c.")
    label: str = ""
    hint: str = ""

    @field_validator("id", mode="before")
    @classmethod
    def _id(cls, v: Any) -> str:
        return str(v) if v is not None else ""


class PlannerOut(BaseModel):
    decision: str = Field(default="plan", description='"ask" only when the request is too vague to plan; otherwise "plan".')
    message: str = Field(default="", description="The chat message that introduces the card, one or two sentences.")
    ask_prompt: str = ""
    ask_mode: str = Field(default="choice", description='One of "choice", "multi" or "text".')
    ask_options: list[AskOptionOut] = Field(default_factory=list)
    summary: str = Field(default="", description="The plan in two or three sentences.")
    steps: list[str] = Field(default_factory=list, description="At most 8 steps, each one short action.")
    agents: list[PlannerAgent] = Field(default_factory=list, description="At most 6 colleagues, in the order they work.")
    ticket_link: str = Field(default="", description="The number of an existing ticket this work belongs to, or empty.")
    ticket_title: str = Field(default="", description="A title for a new ticket when no existing one fits, or empty.")
    ticket_body: str = ""
    risks: list[str] = Field(default_factory=list, description="At most 5 risks or dependencies.")
    sources: list[str] = Field(default_factory=list, description="Labels of the passages (prior art) the plan rests on.")

    @field_validator("agents", mode="before")
    @classmethod
    def _agent_rows(cls, v: Any) -> list[Any]:
        # A model may write a colleague as a bare handle: keep the run alive.
        return [{"handle": x} if isinstance(x, str) else x for x in v] if isinstance(v, list) else []

    @field_validator("ask_options", mode="before")
    @classmethod
    def _option_rows(cls, v: Any) -> list[Any]:
        # A model may write an option as a bare label: keep the run alive.
        return [{"label": x} if isinstance(x, str) else x for x in v] if isinstance(v, list) else []

    @field_validator("steps", "risks", "sources", mode="before")
    @classmethod
    def _strings(cls, v: Any) -> list[str]:
        return [str(x) for x in v] if isinstance(v, list) else []


# ───────────────────────── Delivery pipeline ─────────────────────────


class SpecOut(BaseModel):
    message: str = Field(default="", description="One or two sentences that introduce the spec.")
    title: str = Field(default="", description="A short title for the spec.")
    story: str = Field(default="", description="The user story: who wants what, and why, in one or two sentences.")
    criteria: list[str] = Field(default_factory=list, description="At most 8 acceptance criteria, each a short checkable sentence.")
    estimate: str = Field(default="", description="One line: the size, and which parts are uncertain.")
    risks: list[str] = Field(default_factory=list, description="At most 5 risks or dependencies.")
    definition_of_done: list[str] = Field(default_factory=list, description="At most 5 lines: what must be true for this to be done.")
    sources: list[str] = Field(default_factory=list, description="Labels of the prior-art passages the spec rests on.")

    @field_validator("criteria", "risks", "definition_of_done", "sources", mode="before")
    @classmethod
    def _lines(cls, v: Any) -> list[str]:
        return [str(x) for x in v] if isinstance(v, list) else []


class DesignOut(BaseModel):
    message: str = Field(default="", description="One or two sentences that introduce the design.")
    title: str = Field(default="", description="A short title for the design.")
    flow: list[str] = Field(default_factory=list, description="The screens or steps, in order, at most 6.")
    prototype_html: str = Field(default="", description="One self-contained HTML fragment for the main screen. No scripts, no external assets, inline styles or a style block only.")
    tokens: list[str] = Field(default_factory=list, description="The colors, spacing and type it uses, at most 8 lines.")
    a11y: list[str] = Field(default_factory=list, description="The accessibility checks it meets, at most 8 lines.")

    @field_validator("flow", "tokens", "a11y", mode="before")
    @classmethod
    def _lines(cls, v: Any) -> list[str]:
        return [str(x) for x in v] if isinstance(v, list) else []


class DraftFile(BaseModel):
    """One file as a model writes it: its text as an array of lines. Long files as one escaped JSON string let a model run away into blank lines;
    an array keeps each line separate. The role and `baseSha` are not the model's to say: the agent fills them in from the repo listing."""

    path: str = Field(default="", description="The repository path, for example `sample-app/src/components/OrderList.tsx`.")
    op: Literal["write", "delete"] = "write"
    lines: list[str] = Field(default_factory=list, description="The whole file, one array item per line, without line endings. Empty for a delete. No runs of blank lines.")


class ChangeSetOut(BaseModel):
    message: str = Field(default="", description="One or two sentences that introduce the change set.")
    title: str = Field(default="", description="A short title for the change set.")
    body: str = Field(default="", description="A short note: what changed and why, and which files are new.")
    files: list[DraftFile] = Field(default_factory=list, description="Whole files: source and its unit tests. At most 8.")


class TestReportOut(BaseModel):
    message: str = Field(default="", description="One or two sentences that introduce the report.")
    title: str = Field(default="", description="A short title for the report.")
    summary: str = Field(default="", description="Two or three sentences: what passed, what did not, and what to look at.")
    passed: int = Field(default=0, description="How many checks passed, from the jobs.")
    failed: int = Field(default=0, description="How many checks failed, from the jobs.")
    coverage_pct: float = Field(default=0, description="Line coverage the unit run reported, in percent.")
    regression: list[str] = Field(default_factory=list, description="The existing tests or areas this change could break, at most 6.")
    e2e_files: list[DraftFile] = Field(default_factory=list, description="Optional new end-to-end test files. Leave empty unless the ticket truly needs them.")

    @field_validator("regression", mode="before")
    @classmethod
    def _lines(cls, v: Any) -> list[str]:
        return [str(x) for x in v] if isinstance(v, list) else []


class ScoreLine(BaseModel):
    name: str = Field(default="", description='One of "tests", "coverage", "scan", "changes", "rollback".')
    ok: bool = Field(default=False, description="True only when the job or fact it names says so.")
    detail: str = Field(default="", description="A few words from the facts.")


class ReleaseOut(BaseModel):
    message: str = Field(default="", description="One or two sentences that introduce the release pack.")
    title: str = Field(default="", description="A short title, for example the ticket and the version.")
    notes: list[str] = Field(default_factory=list, description="The release notes: what a person will notice, at most 6 lines.")
    risk: str = Field(default="", description='One of "low", "medium" or "high", and one sentence why.')
    scorecard: list[ScoreLine] = Field(default_factory=list, description="The readiness lines, computed from the jobs and artifacts.")

    @field_validator("notes", mode="before")
    @classmethod
    def _lines(cls, v: Any) -> list[str]:
        return [str(x) for x in v] if isinstance(v, list) else []


class RolloutOut(BaseModel):
    message: str = Field(default="", description="One or two sentences that introduce the rollout report.")
    title: str = Field(default="", description="A short title for the report.")
    summary: str = Field(default="", description="Two or three sentences: what was measured at each traffic step.")
    steps: list[str] = Field(default_factory=list, description="One line per traffic step: the percentage, the error rate and the p95.")
    outcome: str = Field(default="", description='One of "complete", "rolled_back" or "in progress", and one sentence why.')

    @field_validator("steps", mode="before")
    @classmethod
    def _lines(cls, v: Any) -> list[str]:
        return [str(x) for x in v] if isinstance(v, list) else []


# ───────────────────────── Scribe ─────────────────────────


class Decision(BaseModel):
    text: str = ""
    by: str = ""


class ActionItem(BaseModel):
    title: str = Field(default="", description="An imperative ticket title, under 80 characters.")
    body: str = Field(default="", description="Context and acceptance criteria in a few lines.")
    owner: str = ""
    points: int = Field(default=0, description="Story points 1, 2, 3, 5 or 8; 0 when unknown.")
    labels: list[str] = Field(default_factory=list)


class MeetingExtract(BaseModel):
    topic: str = Field(default="", description="What the meeting was about, in a few words.")
    summary: str = Field(default="", description="Two or three sentences.")
    attendees: list[str] = Field(default_factory=list)
    decisions: list[Decision] = Field(default_factory=list)
    action_items: list[ActionItem] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)

    @field_validator("decisions", mode="before")
    @classmethod
    def _decisions(cls, v: Any) -> list[Any]:
        # A model may write a decision as a bare string: keep the run alive.
        return [{"text": x} if isinstance(x, str) else x for x in v] if isinstance(v, list) else []

    @field_validator("action_items", mode="before")
    @classmethod
    def _actions(cls, v: Any) -> list[Any]:
        # A model may write an action item as a bare title: keep the run alive.
        return [{"title": x} if isinstance(x, str) else x for x in v] if isinstance(v, list) else []


class MinutesDoc(BaseModel):
    title: str = Field(default="", description="Meeting minutes title, with the date.")
    markdown: str = Field(default="", description="The minutes as Markdown.")


class ActionLink(BaseModel):
    index: int = Field(default=0, description="The action item's number, starting at 1.")
    duplicateOf: int = Field(default=0, description="The board ticket number this action item already matches, or 0 for a new ticket.")


class ActionLinks(BaseModel):
    links: list[ActionLink] = Field(default_factory=list)


# ───────────────────────── Reviewer ─────────────────────────


class Criterion(BaseModel):
    text: str = Field(default="", description="One acceptance criterion, as written in the ticket.")
    # Plain string, normalized in the pipeline: one odd word from a model must never end a run.
    status: str = Field(default="unclear", description='One of "met", "partial", "missing" or "unclear".')
    evidence: list[str] = Field(default_factory=list, description="Labels of the passages that show it.")
    note: str = Field(default="", description="One short line: why this status.")

    @field_validator("evidence", mode="before")
    @classmethod
    def _evidence(cls, v: Any) -> list[str]:
        if isinstance(v, str):
            return [x.strip() for x in v.replace(";", ",").split(",") if x.strip()]
        return [str(x) for x in v] if isinstance(v, list) else []


class ReviewOut(BaseModel):
    criteria: list[Criterion] = Field(default_factory=list)
    recommendation: str = Field(default="unclear", description='One of "approve", "changes" or "unclear".')
    summary: str = Field(default="", description="Two sentences for the reviewer: the overall picture and what to check first.")

    @field_validator("criteria", mode="before")
    @classmethod
    def _criteria(cls, v: Any) -> list[Any]:
        if not isinstance(v, list):
            return []
        return [{"text": x} if isinstance(x, str) else x for x in v]


# ───────────────────────── Importer ─────────────────────────


class ImportOut(BaseModel):
    title: str = ""
    summary: str = Field(default="", description="One or two sentences about what the document is.")
    markdown: str = Field(default="", description="The whole document as structured Markdown. Keep every figure exactly as printed.")
    labels: list[str] = Field(default_factory=list)


# ───────────────────────── Chief of staff ─────────────────────────


class Route(BaseModel):
    # Plain string, normalized in the caller: one odd word from a model must never end a run.
    target: str = Field(
        default="self",
        description='One of "librarian", "planner", "scribe", "reviewer", "designer", "developer", "qa", "release" or "self".',
    )
    reason: str = Field(default="", description="A few words.")
    question: str = Field(default="", description="The request rewritten for that colleague, or empty to keep it as asked.")
