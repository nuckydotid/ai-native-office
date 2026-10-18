"""The Librarian: finds what the team wrote down, answers only from it with citations, and has a verifier check every claim.

    retriever (tools) -> ensure_evidence -> answerer (structured claims) -> check_draft
        -> verifier (fast model) -> gate -> [revise -> verifier -> gate] (at most two passes) -> finalize

An answer is a list of claims, each naming the passages it rests on. The verifier judges each claim against those passages only. What
it cannot confirm is rewritten once, checked again, and removed if it still does not hold. If nothing is left, the answer is the
refusal, never a guess.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from google.adk import Agent, Context, Event, Workflow
from google.adk.workflow import START

from ..grounding import compose, refusal_text, support_ratio
from ..prompt import board_block, docs_block, evidence_block, history_block, quote, user_message
from ..runtime import RunCtx
from ..schemas import Claim, Draft, Verdict
from ..tools.toolset import build_retrieval_tools
from .common import Result, announce, first_prompt, feed, gen_config, instruction_of, run_workflow

MAX_PASSES = 2
MAX_CLAIMS = 8

RETRIEVER_TASK = """\
Your job in this step is only to FIND what the team has written down that answers the question. You do not answer it.
- Call search_knowledge first, with a focused query: rewrite the question into the words the documents would use. If the results look
  off-topic, search again with different words (at most three searches).
- A question that names a ticket (#12) or asks about a ticket's state: call get_ticket for that number first, before searching.
  Use list_tickets for questions about work in progress, status, assignees or pull requests, and recent_messages only when the
  question is about what was said in this room. Use get_document to read a page in full when a hit looks right but incomplete.
- Make at most six tool calls. When you have enough, or when nothing relevant exists, reply with one short line saying what you found."""

ANSWER_TASK = """\
Your job in this step: answer the question using ONLY the passages you were given.
- Write the answer as claims. Each claim is one self-contained sentence that states one fact, and lists the labels of the passages that
  say it (for example ["P1", "P3"]) and a short quote, word for word, from the first of them.
- Never state anything the passages do not say, and never fill a gap with general knowledge. If the passages disagree, say so in a claim
  and cite both. If the passages do not answer the question, set can_answer to false and return no claims.
- Only claims that answer the question; at most 8. Plain English, no preamble."""

VERIFY_TASK = """\
Your job in this step: act as a strict fact checker. For each numbered claim, decide whether the passages it cites say it.
- supported is true only if a cited passage states it. If the claim adds a number, name, date or condition the passage does not contain,
  changes what the passage says, or goes beyond it, supported is false. Give a few words of reason either way.
- Judge against the passages only, never against what you know. Return one verdict for every claim."""

REVISE_TASK = """\
Your job in this step: fix a draft answer that a fact checker partly rejected.
- Keep every supported claim as it is. For each rejected claim, rewrite it so that it says only what its cited passages say, or drop it.
- Never add a new fact. Never use anything outside the passages. If nothing supported is left, set can_answer to false."""


def _numbered(claims: list[Claim]) -> str:
    return "\n".join(f"{i}. {c.text}  (cites: {', '.join(c.evidence) or 'none'})" for i, c in enumerate(claims, 1))


def build_librarian(rc: RunCtx) -> tuple[Workflow, Callable[[], str]]:
    main, fast = rc.llm("main"), rc.llm("fast")
    req = rc.req

    # ── prompts ──
    def first() -> str:
        return first_prompt(rc, [history_block(req.history, rc.nonce), board_block(req.context.board, rc.nonce), docs_block(req.context.docs, rc.nonce)])

    def answer_prompt() -> str:
        return user_message(req, rc.nonce, blocks=[history_block(req.history, rc.nonce), evidence_block(rc.evidence.all(), rc.nonce)])

    def verify_prompt() -> str:
        draft: Draft = rc.scratch["draft"]
        return user_message(
            req,
            rc.nonce,
            blocks=[
                evidence_block(rc.evidence.all(), rc.nonce),
                quote("The draft answer's claims", _numbered(draft.claims), rc.nonce),
            ],
            closing=f"The question was: {req.question.strip() or '(none)'}\nCheck every numbered claim against the passages it cites.",
        )

    def revise_prompt() -> str:
        draft: Draft = rc.scratch["draft"]
        flagged: dict[int, str] = rc.scratch.get("flagged", {})
        notes = "\n".join(f"{i}. rejected: {why or 'not supported'}" for i, why in sorted(flagged.items()))
        return user_message(
            req,
            rc.nonce,
            blocks=[
                evidence_block(rc.evidence.all(), rc.nonce),
                quote("The draft answer's claims", _numbered(draft.claims), rc.nonce),
                quote("What the fact checker rejected", notes, rc.nonce),
            ],
            closing=f"The question was: {req.question.strip() or '(none)'}\nReturn the corrected draft.",
        )

    # ── agents ──
    retriever = Agent(
        name="retriever",
        model=main,
        instruction=instruction_of(rc, role="retriever", task=RETRIEVER_TASK),
        tools=build_retrieval_tools(rc),
        generate_content_config=gen_config(rc),
        before_model_callback=announce(rc, "searching"),
    )
    answerer = Agent(
        name="answerer",
        model=main,
        instruction=instruction_of(rc, role="answerer", task=ANSWER_TASK),
        output_schema=Draft,
        generate_content_config=gen_config(rc, temperature=0.1),
        before_model_callback=feed(rc, answer_prompt, "writing"),
    )
    verifier = Agent(
        name="verifier",
        model=fast,
        instruction=instruction_of(rc, role="verifier", task=VERIFY_TASK),
        output_schema=Verdict,
        generate_content_config=gen_config(rc, temperature=0.0),
        before_model_callback=feed(rc, verify_prompt, "verifying"),
    )
    reviser = Agent(
        name="reviser",
        model=main,
        instruction=instruction_of(rc, role="reviser", task=REVISE_TASK),
        output_schema=Draft,
        generate_content_config=gen_config(rc, temperature=0.1),
        before_model_callback=feed(rc, revise_prompt, "writing"),
    )

    # ── function nodes ──
    async def ensure_evidence(ctx: Context, node_input: Any):
        """If the retriever read nothing, search once with the question itself, so a lazy retriever cannot cause a false refusal."""
        if len(rc.evidence) == 0 and req.question.strip():
            rc.status("searching")
            hits = await rc.knowledge.search(req.question, k=6)
            rc.step("search_knowledge", f"Searched the knowledge base for the question itself → {len(hits)} passage{'s' if len(hits) != 1 else ''}")
            rc.add_passages(hits)
        yield Event(output={"passages": len(rc.evidence)}, route="answer" if len(rc.evidence) else "refuse")

    async def check_draft(ctx: Context, node_input: dict):
        draft = Draft.model_validate(node_input)
        draft.claims = [c for c in draft.claims if c.text.strip()][:MAX_CLAIMS]
        rc.scratch["draft"] = draft
        usable = draft.can_answer and bool(draft.claims)
        rc.step("answer", f"Drafted {len(draft.claims)} claim{'s' if len(draft.claims) != 1 else ''} from {len(rc.evidence)} passage{'s' if len(rc.evidence) != 1 else ''}" if usable else "The passages do not answer the question")
        yield Event(output={"claims": len(draft.claims)}, route="verify" if usable else "refuse")

    async def gate(ctx: Context, node_input: dict):
        verdict = Verdict.model_validate(node_input)
        draft: Draft = rc.scratch["draft"]
        rc.scratch["passes"] = rc.scratch.get("passes", 0) + 1
        n = len(draft.claims)
        judged: set[int] = set()
        flagged: dict[int, str] = {}
        for v in verdict.verdicts:
            if 1 <= v.index <= n:
                judged.add(v.index)
                if not v.supported:
                    flagged[v.index] = v.reason
        for i in range(1, n + 1):
            if i not in judged:
                flagged[i] = "the fact checker did not confirm it"  # fail closed
        for i, c in enumerate(draft.claims, 1):
            cited = [p for lab in c.evidence if (p := rc.evidence.get(lab)) is not None]
            if not cited:
                flagged.setdefault(i, "it cites no passage that was read")
            elif support_ratio(c.text, cited) < 0.2:
                flagged.setdefault(i, "its words are not in the cited passages")
        if not flagged:
            rc.step("verify", f"Verified {n} claim{'s' if n != 1 else ''} against their sources")
            yield Event(output={"ok": True}, route="done")
        elif rc.scratch["passes"] < MAX_PASSES:
            rc.scratch["flagged"] = flagged
            rc.step("verify", f"Verifier flagged {len(flagged)} of {n} claims; asking for a corrected draft")
            yield Event(output={"flagged": len(flagged)}, route="revise")
        else:
            removed = [draft.claims[i - 1].text for i in sorted(flagged)]
            draft.claims = [c for i, c in enumerate(draft.claims, 1) if i not in flagged]
            rc.scratch["removed"] = rc.scratch.get("removed", 0) + len(removed)
            rc.scratch.setdefault("removed_claims", []).extend(removed)
            rc.step("verify", f"Removed {len(removed)} claim{'s' if len(removed) != 1 else ''} the sources do not support")
            yield Event(output={"removed": len(removed)}, route="done")

    async def apply_revision(ctx: Context, node_input: dict):
        draft = Draft.model_validate(node_input)
        draft.claims = [c for c in draft.claims if c.text.strip()][:MAX_CLAIMS]
        rc.scratch["draft"] = draft
        yield Event(output={"claims": len(draft.claims)}, route="verify" if draft.can_answer and draft.claims else "refuse")

    async def finalize(ctx: Context, node_input: Any):
        draft: Draft | None = rc.scratch.get("draft")
        claims = draft.claims if draft and draft.can_answer else []
        if not claims:
            rc.scratch["result"] = Result(text=refusal_text(len(rc.evidence), draft.missing if draft else ""))
        else:
            g = compose(claims, rc.evidence, removed=rc.scratch.get("removed", 0))
            rc.scratch["result"] = Result(text=g.text, citations=g.citations)
        yield Event(output={"final": True})

    return Workflow(
        name="librarian",
        edges=[
            (START, retriever, ensure_evidence),
            (ensure_evidence, {"answer": answerer, "refuse": finalize}),
            (answerer, check_draft),
            (check_draft, {"verify": verifier, "refuse": finalize}),
            (verifier, gate),
            (gate, {"revise": reviser, "done": finalize}),
            (reviser, apply_revision),
            (apply_revision, {"verify": verifier, "refuse": finalize}),
        ],
    ), first


async def run_librarian(rc: RunCtx) -> Result:
    workflow, first = build_librarian(rc)
    await run_workflow(rc, workflow, first())
    result = rc.scratch.get("result")
    if result is None:
        raise RuntimeError("the librarian ended without an answer")
    return result
