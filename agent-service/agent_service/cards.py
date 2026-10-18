"""Builds the chat cards (ask, plan, proposal) within the limits the team server enforces, so a card is never dropped for being too big."""

from __future__ import annotations

import hashlib
import re

from .contract import (
    CARD_LIMITS as L,
    AskCard,
    AskOption,
    PlanAgent,
    PlanBody,
    PlanCardOut,
    ProposalCard,
    ProposalItem,
)
from .schemas import PlannerOut
from .textutil import clip_at_sentence, one_line, sanitize_text

# The colleagues a plan may name (the demo's roster minus the planner, who writes the plan; a name outside it would not resolve to anyone).
ROSTER = ("librarian", "scribe", "reviewer", "importer", "designer", "developer", "qa", "release")


def _line(text: str, max_chars: int) -> str:
    return one_line(sanitize_text(text, max_chars * 2), max_chars)


def _slug(text: str, fallback: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (s or fallback)[:30]


def card_id(prefix: str, seed: str) -> str:
    """A short id that fits `^[A-Za-z0-9_-]{1,40}$` and is the same for the same seed."""
    return f"{prefix}-{hashlib.sha1(seed.encode()).hexdigest()[:10]}"


def make_ask(run_id: str, out: PlannerOut) -> AskCard | None:
    prompt = _line(out.ask_prompt, L["text"])
    if not prompt:
        return None
    mode = out.ask_mode if out.ask_mode in ("choice", "multi", "text") else "text"
    options: list[AskOption] = []
    seen: set[str] = set()
    for i, o in enumerate(out.ask_options[: L["options"]]):
        label = _line(o.label, L["option"])
        if not label:
            continue
        oid = _slug(o.id or label, f"o{i + 1}")
        if oid in seen:
            oid = f"{oid}-{i + 1}"
        seen.add(oid)
        hint = _line(o.hint, L["hint"]) if o.hint else ""
        options.append(AskOption(id=oid, label=label, hint=hint or None))
    if mode != "text" and len(options) < 2:
        mode, options = "text", []
    return AskCard(id=card_id("ask", f"{run_id}:{prompt}"), mode=mode, prompt=prompt, options=options)


def make_plan(out: PlannerOut, board_keys: set[int]) -> PlanCardOut | None:
    summary = _line(out.summary, L["summary"])
    if not summary:
        return None
    steps = [s for s in (_line(x, L["step"]) for x in out.steps) if s][: L["steps"]]
    agents: list[PlanAgent] = []
    for a in out.agents:
        handle = a.handle.strip().lstrip("@").lower()
        if handle in ROSTER and handle not in {x.handle for x in agents} and len(agents) < L["agents"]:
            effort = a.effort if a.effort in ("low", "medium", "high") else None
            agents.append(PlanAgent(handle=handle, why=_line(a.why, L["why"]), effort=effort))
    risks = [r for r in (_line(x, L["step"]) for x in out.risks) if r][: L["risks"]]
    ticket: dict | None = None
    link = out.ticket_link.strip().lstrip("#")
    if link.isdigit() and int(link) in board_keys:
        ticket = {"link": link}
    elif _line(out.ticket_title, 200):
        body = clip_at_sentence(sanitize_text(out.ticket_body, L["body"] + 50), L["body"])
        ticket = {"create": {"title": _line(out.ticket_title, 200), "body": body}}
    return PlanCardOut(plan=PlanBody(summary=summary, steps=steps, agents=agents, ticket=ticket, risks=risks))


def make_proposal(seed: str, title: str, items: list[ProposalItem]) -> ProposalCard | None:
    """Items are cleaned to the server's sizes; ids are `item-1`, `item-2`... which the server's handle-shaped check accepts."""
    clean: list[ProposalItem] = []
    for it in items[: L["items"]]:
        t = _line(it.title, L["item_title"])
        if not t:
            continue
        labels = [x for x in (_line(lab, L["label"]) for lab in (it.labels or [])) if x][: L["labels"]] or None
        points = it.points if it.points is not None and 0 <= it.points <= 100 else None
        dup = it.duplicateOf if it.duplicateOf and it.duplicateOf >= 1 else None
        clean.append(
            ProposalItem(
                id=f"item-{len(clean) + 1}",
                type=it.type,
                title=t,
                body=clip_at_sentence(sanitize_text(it.body, L["item_body"] + 50), L["item_body"]),
                labels=labels,
                points=points or None,
                duplicateOf=dup,
            )
        )
    if not clean:
        return None
    return ProposalCard(id=card_id("prop", seed), title=_line(title, L["text"]) or "Proposal", items=clean)
