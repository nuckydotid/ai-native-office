"""The Planner Agent's spec run: turns a ticket into the `spec` artifact the Plan gate reads.

    (researcher over the knowledge base || estimator over the board) -> join -> synthesizer (structured output) -> finalize

The body is Markdown with the acceptance criteria as a checklist, because that is what the gate looks for. Nothing is accepted: the
person reads the draft and accepts it.
"""

from __future__ import annotations

from collections.abc import Callable

from google.adk import Agent, Context, Event, Workflow
from google.adk.workflow import START, JoinNode

from ..contract import ArtifactDraftOut, Citation, QUOTE_MAX
from ..grounding import best_sentence
from ..prompt import artifact_lines_block, board_block, docs_block, evidence_block, history_block, quote, ticket_block, user_message
from ..runtime import RunCtx
from ..schemas import SpecOut
from ..textutil import clamp, one_line
from ..tools.toolset import build_retrieval_tools
from .common import Result, announce, capture, feed, first_prompt, gen_config, instruction_of, run_workflow

RESEARCH_TASK = """\
Your job in this step is only to find PRIOR ART for this ticket in the team's own knowledge: decisions already made, constraints,
policies, similar past work. You do not write the spec.
- Use search_knowledge (two or three focused searches), list_tickets for related work, and get_document when a hit is relevant but
  incomplete. At most five tool calls.
- Finish with a few short bullet notes: what exists, what constrains the work, what is already being done."""

ESTIMATE_TASK = """\
Your job in this step is only to ESTIMATE the ticket. You have no tools: use the board and the ticket you were given.
- List the main parts, give each low, medium or high effort, and say which can run at the same time.
- Note any ticket that already covers a part, by number. Four to eight short bullet lines."""

SYNTH_TASK = """\
Your job in this step: write the spec for this ticket.
- A spec has: a user story (who wants what, and why) in one or two sentences, at most 8 acceptance criteria (each a short, checkable
  sentence a person could test), a one-line estimate that names what is uncertain, at most 5 risks or dependencies, and at most 5 lines
  of definition of done.
- Use what the team already decided. Do not repeat work that exists; say which ticket already covers a part if one does.
- sources: the labels of the prior-art passages the spec rests on. message: one or two sentences that introduce the draft."""


def build_spec(rc: RunCtx) -> tuple[Workflow, Callable[[], str]]:
    req = rc.req
    main, fast, pro = rc.llm("main"), rc.llm("fast"), rc.llm("pro")

    def first() -> str:
        return first_prompt(
            rc,
            [history_block(req.history, rc.nonce), ticket_block(req, rc.nonce), artifact_lines_block(req, rc.nonce), board_block(req.context.board, rc.nonce), docs_block(req.context.docs, rc.nonce)],
        )

    def estimate_prompt() -> str:
        return user_message(req, rc.nonce, blocks=[ticket_block(req, rc.nonce), board_block(req.context.board, rc.nonce)])

    def synth_prompt() -> str:
        return user_message(
            req,
            rc.nonce,
            blocks=[
                ticket_block(req, rc.nonce),
                board_block(req.context.board, rc.nonce),
                evidence_block(rc.evidence.all(), rc.nonce, "Prior-art passages from the team's knowledge"),
                quote("Notes from the researcher", rc.scratch.get("research", "(none)"), rc.nonce),
                quote("Notes from the estimator", rc.scratch.get("estimate", "(none)"), rc.nonce),
            ],
        )

    researcher = Agent(
        name="researcher",
        model=main,
        instruction=instruction_of(rc, role="researcher", task=RESEARCH_TASK),
        tools=build_retrieval_tools(rc, include_messages=False),
        generate_content_config=gen_config(rc),
        before_model_callback=announce(rc, "searching"),
        after_model_callback=capture(rc, "research"),
    )
    estimator = Agent(
        name="estimator",
        model=fast,
        instruction=instruction_of(rc, role="estimator", task=ESTIMATE_TASK),
        generate_content_config=gen_config(rc),
        before_model_callback=feed(rc, estimate_prompt, "thinking"),
        after_model_callback=capture(rc, "estimate"),
    )
    synthesizer = Agent(
        name="synthesizer",
        model=pro,
        instruction=instruction_of(rc, role="spec_writer", task=SYNTH_TASK),
        output_schema=SpecOut,
        generate_content_config=gen_config(rc, temperature=0.3),
        before_model_callback=feed(rc, synth_prompt, "writing"),
    )
    join = JoinNode(name="join_notes")

    async def finalize_spec(ctx: Context, node_input: dict):
        out = SpecOut.model_validate(node_input)
        ticket = req.ticket
        message = clamp(one_line(out.message, 600), 600) or "Here is the spec."
        title = clamp(one_line(out.title, 200), 200) or (f"Spec: {ticket.title}" if ticket else "Spec")
        story = clamp(one_line(out.story, 800), 800) or "The ticket's story."
        criteria = [clamp(one_line(c, 240), 240) for c in out.criteria if one_line(c, 240)][:8] or ["The change is shown to work on the portal."]
        risks = [clamp(one_line(r, 240), 240) for r in out.risks if one_line(r, 240)][:5]
        done = [clamp(one_line(d, 240), 240) for d in out.definition_of_done if one_line(d, 240)][:5]
        estimate = clamp(one_line(out.estimate, 300), 300)
        body = "\n".join(
            [
                "## Story",
                story,
                "",
                "## Acceptance criteria",
                *[f"- [ ] {c}" for c in criteria],
                "",
                "## Estimate",
                estimate or "Not estimated yet.",
                "",
                "## Risks",
                *([f"- {r}" for r in risks] or ["- None written down yet."]),
                "",
                "## Definition of done",
                *([f"- {d}" for d in done] or ["- The acceptance criteria pass, and a person has checked the change."]),
            ]
        )
        citations: list[Citation] = []
        seen: set[tuple[str, str]] = set()
        for label in out.sources:
            passage = rc.evidence.get(label)
            if passage is not None and (passage.kind, passage.item_id) not in seen and len(citations) < 4:
                seen.add((passage.kind, passage.item_id))
                q = clamp(one_line(best_sentence(passage.text, out.story + " " + " ".join(criteria)), QUOTE_MAX), QUOTE_MAX)
                citations.append(Citation(kind=passage.kind, id=passage.item_id, title=passage.title, quote=q or None))  # type: ignore[arg-type]
        if citations:
            message += "\n\nPrior art: " + " · ".join(f"[{i + 1}] {c.title}" for i, c in enumerate(citations))
        artifact = ArtifactDraftOut(kind="spec", title=title, body=body, meta={"criteria": len(criteria)})
        rc.scratch["result"] = Result(text=message, citations=citations, artifacts=[artifact])
        yield Event(output={"final": True})

    workflow = Workflow(name="spec", edges=[(START, (researcher, estimator), join), (join, synthesizer, finalize_spec)])
    return workflow, first


async def run_spec(rc: RunCtx) -> Result:
    workflow, first = build_spec(rc)
    await run_workflow(rc, workflow, first())
    result = rc.scratch.get("result")
    if result is None:
        raise RuntimeError("the spec run ended without a spec")
    return result
