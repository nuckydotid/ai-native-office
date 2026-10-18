"""The Scribe: turns a room's conversation into minutes and proposed tickets.

    extractor (structured MeetingExtract) -> linker (matches action items against the board) -> writer (MinutesDoc) -> finalize

Nothing is created: the finalize step puts the minutes and every action item into one `proposal` card, where the task items that
already match a board ticket carry that ticket's number. A person accepts what they agree with, and the team server creates it as
that person (`ai.apply`).
"""

from __future__ import annotations

from collections.abc import Callable

from google.adk import Agent, Context, Event, Workflow
from google.adk.workflow import START

from ..cards import make_proposal
from ..contract import ProposalItem
from ..prompt import board_block, history_block, quote, user_message
from ..runtime import RunCtx
from ..schemas import ActionLinks, MeetingExtract, MinutesDoc
from ..textutil import clamp, one_line
from .common import Result, feed, first_prompt, gen_config, instruction_of, run_workflow

EXTRACT_TASK = """\
Your job in this step: read the meeting (the recent chat of this room) and write down what it contains. You do not write minutes yet.
- decisions: what the people settled on, one line each, with who decided when that is clear.
- action_items: an imperative title for each thing someone must do (under 80 characters), the owner's name when it was said, a short
  body with the context and how "done" is judged, labels when they are obvious ("bug", "frontend", "api", "infra", "docs"), and the
  story points (1, 2, 3, 5 or 8; 0 when unknown). An action item that only restates an existing board ticket is still written down.
- risks and open_questions: as they were said; do not invent any.
- Write everything in the language of the meeting, keep numbers and names exactly as said, and never add facts the chat does not contain."""

LINK_TASK = """\
Your job in this step: compare each numbered action item with the board and say which ones an existing ticket already covers.
- For each action item, put the board ticket number in duplicateOf when the ticket is clearly the same work (same deliverable, not
  merely a related area); otherwise 0. A ticket in review or done still counts as covering the work.
- Return one entry for every action item, in order. When the board is empty, return every duplicateOf as 0."""

WRITE_TASK = """\
Your job in this step: write the minutes of the meeting as Markdown, using the extract and the board matching you were given.
- Start with one short paragraph: what the meeting was about and the outcome. Then `## Decisions`, `## Action items` (a checklist,
  each with its owner and, when it matches a board ticket, that ticket by number), `## Risks` and `## Open questions`, skipping a
  section that has nothing in it.
- Keep every figure, name and ticket number exactly as given. Do not add anything the extract does not contain."""


def build_scribe(rc: RunCtx) -> tuple[Workflow, Callable[[], str]]:
    req = rc.req
    main, fast, pro = rc.llm("main"), rc.llm("fast"), rc.llm("pro")

    def first() -> str:
        return first_prompt(rc, [history_block(req.history, rc.nonce), board_block(req.context.board, rc.nonce)])

    def link_prompt() -> str:
        extract: MeetingExtract = rc.scratch["extract"]
        items = "\n".join(f"{i}. {a.title} — {one_line(a.body, 160)}" for i, a in enumerate(extract.action_items, 1)) or "(no action items)"
        return user_message(
            req,
            rc.nonce,
            blocks=[board_block(req.context.board, rc.nonce), quote("The action items to match", items, rc.nonce)],
            closing="The meeting was: " + (extract.topic.strip() or "(topic unclear)") + "\nMatch every numbered action item against the board.",
        )

    def write_prompt() -> str:
        extract: MeetingExtract = rc.scratch["extract"]
        links: ActionLinks = rc.scratch.get("links", ActionLinks())
        match_lines = "\n".join(
            f"{a.index}. {extract.action_items[a.index - 1].title}: "
            + (f"already tracked as #{a.duplicateOf}" if a.duplicateOf else "new work, not on the board")
            for a in links.links
            if 1 <= a.index <= len(extract.action_items)
        ) or "(nothing matched)"
        return user_message(
            req,
            rc.nonce,
            blocks=[
                quote("The extractor's reading of the meeting", extract.model_dump_json(indent=1), rc.nonce),
                quote("How the action items match the board", match_lines, rc.nonce),
            ],
        )

    extractor = Agent(
        name="extractor",
        model=main,
        instruction=instruction_of(rc, role="extractor", task=EXTRACT_TASK),
        output_schema=MeetingExtract,
        generate_content_config=gen_config(rc, temperature=0.1),
        before_model_callback=feed(rc, first, "thinking"),
    )
    linker = Agent(
        name="linker",
        model=fast,
        instruction=instruction_of(rc, role="linker", task=LINK_TASK),
        output_schema=ActionLinks,
        generate_content_config=gen_config(rc, temperature=0.0),
        before_model_callback=feed(rc, link_prompt, "thinking"),
    )
    writer = Agent(
        name="minutes_writer",
        model=pro,
        instruction=instruction_of(rc, role="minutes", task=WRITE_TASK),
        output_schema=MinutesDoc,
        generate_content_config=gen_config(rc, temperature=0.2),
        before_model_callback=feed(rc, write_prompt, "writing"),
    )

    async def keep_extract(ctx: Context, node_input: dict):
        extract = MeetingExtract.model_validate(node_input)
        extract.action_items = [a for a in extract.action_items if a.title.strip()][:10]
        extract.decisions = [d for d in extract.decisions if d.text.strip()][:8]
        rc.scratch["extract"] = extract
        rc.step(
            "extract",
            f"Read {len(req.history)} message{'s' if len(req.history) != 1 else ''}: {len(extract.decisions)} decision{'s' if len(extract.decisions) != 1 else ''}, {len(extract.action_items)} action item{'s' if len(extract.action_items) != 1 else ''}",
        )
        yield Event(output={"actions": len(extract.action_items)})

    async def keep_links(ctx: Context, node_input: dict):
        links = ActionLinks.model_validate(node_input)
        rc.scratch["links"] = links
        matched = sum(1 for a in links.links if a.duplicateOf)
        if matched:
            rc.step("link", f"{matched} action item{'s' if matched != 1 else ''} already tracked on the board")
        yield Event(output={"matched": matched})

    async def finalize_minutes(ctx: Context, node_input: dict):
        extract: MeetingExtract = rc.scratch["extract"]
        links: ActionLinks = rc.scratch.get("links", ActionLinks())
        doc = MinutesDoc.model_validate(node_input)
        board_keys = {t.key for t in req.context.board}
        by_index = {a.index: a.duplicateOf for a in links.links}
        items: list[ProposalItem] = []
        for i, a in enumerate(extract.action_items, 1):
            dup = by_index.get(i, 0)
            items.append(
                ProposalItem(
                    id=f"item-{i}",
                    type="ticket",
                    title=a.title.strip(),
                    body=a.body.strip(),
                    labels=a.labels or None,
                    points=a.points if a.points in (1, 2, 3, 5, 8) else None,
                    duplicateOf=dup if dup in board_keys else None,
                )
            )
        if doc.markdown.strip():
            items.append(ProposalItem(id="item-minutes", type="doc", title=doc.title.strip() or "Meeting minutes", body=clamp(doc.markdown, 1900)))
        card = make_proposal(req.runId, "Minutes and proposed tickets", items)

        lines = [f"**{doc.title.strip() or 'Meeting minutes'}**", "", extract.summary.strip()]
        if extract.decisions:
            lines += ["", "Decisions:"] + [f"- {one_line(d.text, 160)}" + (f" ({one_line(d.by, 40)})" if d.by.strip() else "") for d in extract.decisions[:6]]
        if extract.risks:
            lines += ["", "Risks:"] + [f"- {one_line(r, 160)}" for r in extract.risks[:3]]
        if extract.open_questions:
            lines += ["", "Open:"] + [f"- {one_line(q, 160)}" for q in extract.open_questions[:3]]
        lines += ["", "The minutes and the proposed tickets are below — accept what you agree with, and nothing is created until you do."]
        rc.scratch["result"] = Result(text="\n".join(lines), cards=[card] if card else [])
        rc.step("minutes", f"Wrote {len(doc.markdown)} characters of minutes and {len(items)} proposed item{'s' if len(items) != 1 else ''}")
        yield Event(output={"final": True})

    workflow = Workflow(
        name="scribe",
        edges=[
            (START, extractor, keep_extract),
            (keep_extract, linker, keep_links),
            (keep_links, writer, finalize_minutes),
        ],
    )
    return workflow, first


async def run_scribe(rc: RunCtx) -> Result:
    workflow, first = build_scribe(rc)
    await run_workflow(rc, workflow, first())
    result = rc.scratch.get("result")
    if result is None:
        raise RuntimeError("the scribe ended without minutes")
    return result
