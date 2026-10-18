"""The Planner Agent: turns an idea into the `ask` or `plan` card the Plan Room already knows.

    (researcher over the knowledge base || estimator over the board) -> join -> synthesizer (structured output) -> finalize

The synthesizer's answer is a Gemini `response_schema` (`PlannerOut`), which replaces the JSON-schema flag the old CLI flow used.
It either asks one question (the request is too vague to plan) or returns a plan: at most 8 steps, the colleagues who do them, the
ticket it belongs to, and the risks. Nothing is created: the owner presses Proceed.
"""

from __future__ import annotations

from collections.abc import Callable

from google.adk import Agent, Context, Event, Workflow
from google.adk.workflow import START, JoinNode

from ..cards import ROSTER, make_ask, make_plan
from ..grounding import best_sentence
from ..contract import Citation, QUOTE_MAX
from ..prompt import board_block, docs_block, evidence_block, history_block, quote, user_message
from ..runtime import RunCtx
from ..schemas import PlannerOut
from ..textutil import clamp, one_line
from ..tools.toolset import build_retrieval_tools
from .common import Result, announce, capture, feed, first_prompt, gen_config, instruction_of, run_workflow

RESEARCH_TASK = """\
Your job in this step is only to find PRIOR ART for the goal in the team's own knowledge: decisions already made, policies and
constraints, similar past work, and tickets that already cover part of it. You do not write the plan.
- Use search_knowledge (two or three focused searches), list_tickets for related work on the board, and get_document when a hit is
  relevant but incomplete. At most five tool calls.
- Finish with a few short bullet notes: what exists, what constrains the plan, what is already being done."""

ESTIMATE_TASK = """\
Your job in this step is only to ESTIMATE the goal. You have no tools: use the board and the chat you were given.
- List the main parts of the work, give each low, medium or high effort, and say which could run at the same time.
- Note any ticket on the board that already covers a part, by number. Four to eight short bullet lines."""

SYNTH_TASK = f"""\
Your job in this step: write the plan card for the goal, using the prior-art passages and the notes you were given.
- If the request is too vague to plan (you cannot tell what is wanted), set decision to "ask" and ask ONE short question with two to
  four options. Otherwise set decision to "plan".
- A plan has: a summary of two or three sentences, at most 8 steps (one short action each), the colleagues who do them in order, the
  ticket it belongs to, and at most 5 risks or dependencies. Use what the team already decided: respect its constraints and do not
  repeat work that exists.
- Colleagues you may name, by handle: {", ".join(ROSTER)}. Name only those whose work the plan needs.
- If a ticket on the board already covers the goal, put its number in ticket_link. Otherwise give ticket_title and ticket_body for a new one.
- sources: the labels of the prior-art passages the plan rests on. The message is one or two sentences that introduce the card."""


def build_planner(rc: RunCtx) -> tuple[Workflow, Callable[[], str]]:
    req = rc.req
    main, fast, pro = rc.llm("main"), rc.llm("fast"), rc.llm("pro")

    def first() -> str:
        return first_prompt(rc, [history_block(req.history, rc.nonce), board_block(req.context.board, rc.nonce), docs_block(req.context.docs, rc.nonce)])

    def estimate_prompt() -> str:
        return user_message(req, rc.nonce, blocks=[history_block(req.history, rc.nonce), board_block(req.context.board, rc.nonce)])

    def synth_prompt() -> str:
        blocks = [
            history_block(req.history, rc.nonce),
            board_block(req.context.board, rc.nonce),
            evidence_block(rc.evidence.all(), rc.nonce, "Prior-art passages from the team's knowledge"),
            quote("Notes from the researcher", rc.scratch.get("research", "(none)"), rc.nonce),
            quote("Notes from the estimator", rc.scratch.get("estimate", "(none)"), rc.nonce),
        ]
        return user_message(req, rc.nonce, blocks=blocks)

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
        instruction=instruction_of(rc, role="synthesizer", task=SYNTH_TASK),
        output_schema=PlannerOut,
        generate_content_config=gen_config(rc, temperature=0.3),
        before_model_callback=feed(rc, synth_prompt, "writing"),
    )
    join = JoinNode(name="join_notes")

    async def finalize_plan(ctx: Context, node_input: dict):
        out = PlannerOut.model_validate(node_input)
        board_keys = {t.key for t in req.context.board}
        message = clamp(one_line(out.message, 600), 600) or "Here is a plan."
        cards = []
        citations: list[Citation] = []
        if (out.decision or "").strip().lower() == "ask" and (card := make_ask(req.runId, out)):
            cards.append(card)
        elif card := make_plan(out, board_keys):
            cards.append(card)
            rc.step("plan", f"Drafted a plan with {len(card.plan.steps)} step{'s' if len(card.plan.steps) != 1 else ''}")
            seen: set[tuple[str, str]] = set()
            for label in out.sources:
                p = rc.evidence.get(label)
                if p is not None and (p.kind, p.item_id) not in seen and len(citations) < 4:
                    seen.add((p.kind, p.item_id))
                    q = clamp(one_line(best_sentence(p.text, out.summary + " " + " ".join(out.steps)), QUOTE_MAX), QUOTE_MAX)
                    citations.append(Citation(kind=p.kind, id=p.item_id, title=p.title, quote=q or None))  # type: ignore[arg-type]
        if citations:
            message += "\n\nPrior art: " + " · ".join(f"[{i + 1}] {c.title}" for i, c in enumerate(citations))
        rc.scratch["result"] = Result(text=message, citations=citations, cards=cards)
        yield Event(output={"final": True})

    workflow = Workflow(
        name="planner",
        edges=[
            (START, (researcher, estimator), join),
            (join, synthesizer, finalize_plan),
        ],
    )
    return workflow, first


async def run_planner(rc: RunCtx) -> Result:
    workflow, first = build_planner(rc)
    await run_workflow(rc, workflow, first())
    result = rc.scratch.get("result")
    if result is None:
        raise RuntimeError("the planner ended without a plan")
    return result
