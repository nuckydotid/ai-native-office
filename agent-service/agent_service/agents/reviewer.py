"""The Reviewer: checks a ticket's notes against its acceptance criteria before it goes to In Review.

    inspector (tools: reads the ticket, its notes and the pages it links) -> reviewer (structured ReviewOut) -> finalize

The checklist is advice, never a gate: a person reads it and decides. Every criterion names the passages that show it, so the
person can check the Reviewer's work.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from google.adk import Agent, Context, Event, Workflow
from google.adk.workflow import START

from ..contract import QUOTE_MAX, Citation
from ..prompt import evidence_block, history_block, quote, user_message
from ..runtime import RunCtx
from ..schemas import ReviewOut
from ..textutil import clamp, one_line
from ..tools.toolset import build_retrieval_tools
from .common import Result, announce, capture, feed, first_prompt, gen_config, instruction_of, run_workflow

INSPECT_TASK = """\
Your job in this step is only to GATHER, not to judge.
- Find the acceptance criteria: they are in the ticket's body under "Acceptance criteria" (or the closest heading). Copy what you
  can see, word for word, one per line; the full ticket text also travels with this run, so the judging step reads the whole list.
- Then read what shows the work: the ticket's own notes in its body, the pull request description when one is linked, and the Docs pages
  or tickets the notes point to. Use search_knowledge and get_document for those.
- Finish with two blocks: the criteria you found (numbered) and what the evidence says about each one (plain lines, with the
  passage labels you read). At most six tool calls."""

REVIEW_TASK = """\
Your job in this step: judge EVERY acceptance criterion of the target ticket, using ONLY what you were given.
- Write the criteria yourself from the passage of kind "ticket": the lines under "Acceptance criteria", in their order and their own
  words. A criterion marked as unchecked ("[ ]") is not met, and so is one the notes say was not tried. The gatherer's numbered list
  is only a hint: it may have seen part of the ticket.
- status: "met" when the evidence shows it plainly; "partial" when some of it is shown; "missing" when nothing shows it; "unclear" when
  the notes cannot settle it either way. Every criterion gets a one-line note saying why.
- evidence: the labels (P1, P2...) of the passages that show the status; empty for missing or unclear.
- recommendation: "approve" when every criterion is met; "changes" when something is missing or partial; "unclear" when the notes do
  not let you tell.
- summary: two sentences for the reviewer — the overall picture, and what to check first. Never soften a "missing": the point of this
  check is to find it before the reviewer does."""


def build_reviewer(rc: RunCtx) -> tuple[Workflow, Callable[[], str]]:
    req = rc.req
    main, fast = rc.llm("main"), rc.llm("fast")

    def first() -> str:
        return first_prompt(rc, [history_block(req.history, rc.nonce)])

    def review_prompt() -> str:
        return user_message(
            req,
            rc.nonce,
            blocks=[evidence_block(rc.evidence.all(), rc.nonce), quote("What the gatherer found", clamp(rc.scratch.get("gathered", "(nothing)"), 8000), rc.nonce)],
            closing="Judge every acceptance criterion of the ticket (take them from the ticket passage) against the gathered notes.",
        )

    inspector = Agent(
        name="inspector",
        model=main,
        instruction=instruction_of(rc, role="inspector", task=INSPECT_TASK),
        tools=build_retrieval_tools(rc),
        generate_content_config=gen_config(rc),
        before_model_callback=announce(rc, "searching"),
        after_model_callback=capture(rc, "gathered"),
    )
    reviewer = Agent(
        name="reviewer",
        model=main,
        instruction=instruction_of(rc, role="reviewer", task=REVIEW_TASK),
        output_schema=ReviewOut,
        generate_content_config=gen_config(rc, temperature=0.1),
        before_model_callback=feed(rc, review_prompt, "verifying"),
    )

    async def finalize_review(ctx: Context, node_input: dict):
        out = ReviewOut.model_validate(node_input)
        m = re.search(r"#(\d+)", req.question)
        title = f"#{m.group(1)}" if m else "the ticket"
        marks = {"met": "met", "partial": "partly met", "missing": "missing", "unclear": "unclear"}

        def normalized_status(raw: str) -> str:
            s = raw.strip().lower()
            if s in marks:
                return s
            if "partial" in s or "partly" in s:
                return "partial"
            if "miss" in s or "unmet" in s or "not met" in s or "fail" in s:
                return "missing"
            if "met" in s or "done" in s or "pass" in s:
                return "met"
            return "unclear"

        def normalized_recommendation(raw: str) -> str:
            s = raw.strip().lower()
            if "approve" in s or s == "ok" or "lgtm" in s:
                return "approve"
            if "change" in s or "reject" in s or "fix" in s:
                return "changes"
            return "unclear"

        recommendation = normalized_recommendation(out.recommendation)
        statuses = [normalized_status(c.status) for c in out.criteria]
        lines = [f"**Review of {title}** — recommendation: **{recommendation}**", "", out.summary.strip()]
        if out.criteria:
            lines += [""]
            for c, st in zip(out.criteria[:8], statuses[:8], strict=False):
                note = f" — {one_line(c.note, 160)}" if c.note.strip() else ""
                lines.append(f"- {marks[st]}: {one_line(c.text, 200)}{note}")
        lines += ["", "This is advice: a person decides what happens to the ticket."]

        citations: list[Citation] = []
        seen: set[tuple[str, str]] = set()
        for c in out.criteria:
            for label in c.evidence:
                p = rc.evidence.get(label)
                if p is None or (p.kind, p.item_id) in seen:
                    continue
                seen.add((p.kind, p.item_id))
                citations.append(Citation(kind=p.kind, id=p.item_id, title=p.title, quote=clamp(one_line(p.text, QUOTE_MAX), QUOTE_MAX) or None))  # type: ignore[arg-type]
        rc.scratch["result"] = Result(text="\n".join(lines), citations=citations[:4])
        met = sum(1 for st in statuses if st == "met")
        rc.step("review", f"Checked {len(out.criteria)} {'criterion' if len(out.criteria) == 1 else 'criteria'}: {met} met, recommendation {recommendation}")
        yield Event(output={"final": True})

    workflow = Workflow(
        name="reviewer",
        edges=[
            (START, inspector, reviewer),
            (reviewer, finalize_review),
        ],
    )
    return workflow, first


async def run_reviewer(rc: RunCtx) -> Result:
    workflow, first = build_reviewer(rc)
    await run_workflow(rc, workflow, first())
    result = rc.scratch.get("result")
    if result is None:
        raise RuntimeError("the reviewer ended without a review")
    return result
