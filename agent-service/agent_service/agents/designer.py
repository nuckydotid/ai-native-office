"""The Designer Agent: turns a ticket and its spec into the `design` artifact.

    (researcher over the knowledge base || constraints from the accepted spec) -> join -> synthesizer (structured output) -> finalize

The body is one self-contained HTML page: the prototype, the flow, the tokens and the accessibility checklist. It is shown in a
sandboxed frame that removes scripts, forms and external loads, so the design is read, never run.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from google.adk import Agent, Context, Event, Workflow
from google.adk.workflow import START, JoinNode

from ..contract import ArtifactDraftOut
from ..prompt import artifact_lines_block, board_block, docs_block, evidence_block, history_block, quote, ticket_block, user_message
from ..runtime import RunCtx
from ..schemas import DesignOut
from ..textutil import clamp, one_line
from ..tools.toolset import build_retrieval_tools
from .common import Result, announce, capture, feed, first_prompt, gen_config, instruction_of, run_workflow

RESEARCH_TASK = """\
Your job in this step is only to find PRIOR ART: the team's design decisions, its tokens and any earlier screens this work must fit.
- Use search_knowledge (two or three focused searches) and get_document when a hit is relevant. At most four tool calls.
- Finish with a few short bullet notes: what the design must respect."""

CONSTRAINTS_TASK = """\
Your job in this step is only to read the ticket and the pipeline's artifact list, and write down the UI constraints.
- Which screens does the ticket touch? What must stay the same? What is the smallest change that satisfies the acceptance criteria?
- Three to six short bullet lines. If the ticket changes no screen, say exactly that."""

SYNTH_TASK = """\
Your job in this step: design the screens for this ticket, using the prior art and the constraints you were given.
- flow: the screens or steps in order, at most 6 short lines.
- prototype_html: ONE self-contained HTML fragment for the main screen. Inline styles or a <style> block only. No <script>, no <form>,
  no external links, images or fonts, no iframes. It must be readable on its own, with real labels and sample rows, not lorem ipsum.
- tokens: the colors, spacing and type it uses, at most 8 short lines, as CSS values.
- a11y: the accessibility checks it meets, at most 8 short lines (labels, focus, contrast, keyboard).
- title and message: a short title, and one or two sentences that introduce the draft."""


def _clean_html(html: str) -> str:
    """What a prototype may not contain, removed here as well as in the app's frame."""
    out = re.sub(r"<script\b[\s\S]*?</script\s*>", "", html, flags=re.I)
    out = re.sub(r"<(script|iframe|object|embed|form|link|base)\b[^>]*>", "", out, flags=re.I)
    out = re.sub(r"\son[a-z]+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "", out, flags=re.I)
    return out.strip()


def build_designer(rc: RunCtx) -> tuple[Workflow, Callable[[], str]]:
    req = rc.req
    main, fast, pro = rc.llm("main"), rc.llm("fast"), rc.llm("pro")

    def first() -> str:
        return first_prompt(
            rc,
            [history_block(req.history, rc.nonce), ticket_block(req, rc.nonce), artifact_lines_block(req, rc.nonce), board_block(req.context.board, rc.nonce), docs_block(req.context.docs, rc.nonce)],
        )

    def constraints_prompt() -> str:
        return user_message(req, rc.nonce, blocks=[ticket_block(req, rc.nonce), artifact_lines_block(req, rc.nonce)])

    def synth_prompt() -> str:
        return user_message(
            req,
            rc.nonce,
            blocks=[
                ticket_block(req, rc.nonce),
                artifact_lines_block(req, rc.nonce),
                evidence_block(rc.evidence.all(), rc.nonce, "Prior-art passages from the team's knowledge"),
                quote("Notes from the researcher", rc.scratch.get("research", "(none)"), rc.nonce),
                quote("Notes from the constraints step", rc.scratch.get("constraints", "(none)"), rc.nonce),
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
    constraints = Agent(
        name="constraints",
        model=fast,
        instruction=instruction_of(rc, role="constraints", task=CONSTRAINTS_TASK),
        generate_content_config=gen_config(rc),
        before_model_callback=feed(rc, constraints_prompt, "thinking"),
        after_model_callback=capture(rc, "constraints"),
    )
    synthesizer = Agent(
        name="synthesizer",
        model=pro,
        instruction=instruction_of(rc, role="designer", task=SYNTH_TASK),
        output_schema=DesignOut,
        generate_content_config=gen_config(rc, temperature=0.4),
        before_model_callback=feed(rc, synth_prompt, "writing"),
    )
    join = JoinNode(name="join_notes")

    async def finalize_design(ctx: Context, node_input: dict):
        out = DesignOut.model_validate(node_input)
        ticket = req.ticket
        title = clamp(one_line(out.title, 200), 200) or (f"Design: {ticket.title}" if ticket else "Design")
        message = clamp(one_line(out.message, 600), 600) or "Here is the design."
        flow = [clamp(one_line(f, 200), 200) for f in out.flow if one_line(f, 200)][:6]
        tokens = [clamp(one_line(t, 160), 160) for t in out.tokens if one_line(t, 160)][:8]
        a11y = [clamp(one_line(a, 200), 200) for a in out.a11y if one_line(a, 200)][:8]
        prototype = _clean_html(out.prototype_html) or "<main><h1>No screen drawn yet</h1><p>The design step returned no prototype.</p></main>"
        body = "\n".join(
            [
                "<!doctype html><html><head><meta charset=\"utf-8\"><style>",
                "body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f6f7f9;color:#1d2733}",
                "section{background:#fff;border-radius:12px;padding:18px;margin:0 0 14px;box-shadow:0 1px 3px rgba(16,24,40,.08)}",
                "h1{font-size:22px;margin:0 0 8px}h2{font-size:14px;margin:0 0 8px;color:#5b6b7c;text-transform:uppercase;letter-spacing:.06em}",
                "ul{margin:0;padding-left:18px}li{margin:3px 0}",
                "</style></head><body>",
                f"<section><h2>Prototype</h2>{prototype}</section>",
                "<section><h2>Flow</h2><ul>" + "".join(f"<li>{f}</li>" for f in (flow or ["One screen."])) + "</ul></section>",
                "<section><h2>Tokens</h2><ul>" + "".join(f"<li>{t}</li>" for t in (tokens or ["No tokens written down yet."])) + "</ul></section>",
                "<section><h2>Accessibility</h2><ul>" + "".join(f"<li>{a}</li>" for a in (a11y or ["Labels and keyboard focus checked by hand."])) + "</ul></section>",
                "</body></html>",
            ]
        )
        artifact = ArtifactDraftOut(kind="design", title=title, body=body, meta={"screens": len(flow), "noUi": False})
        rc.scratch["result"] = Result(text=message, artifacts=[artifact])
        yield Event(output={"final": True})

    workflow = Workflow(name="designer", edges=[(START, (researcher, constraints), join), (join, synthesizer, finalize_design)])
    return workflow, first


async def run_designer(rc: RunCtx) -> Result:
    workflow, first = build_designer(rc)
    await run_workflow(rc, workflow, first())
    result = rc.scratch.get("result")
    if result is None:
        raise RuntimeError("the design run ended without a design")
    return result
