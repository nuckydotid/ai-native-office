"""One run, from request to `final` or `error`: budget, wall-clock cap, the right pipeline, and the last cleaning of what goes out."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any

from .agents.common import Result
from .auth import check_web_base
from .contract import ANSWER_MAX_CHARS, CITATIONS_MAX, QUOTE_MAX, RunRequest, Usage, dump
from .errors import InvalidRun, ModelUnavailable, RunError, RunTimeout
from .models.budget import RunBudget
from .pipeline import validate_artifacts
from .runtime import Emit, RunCtx
from .scrub import scrub, scrub_deep, scrub_secrets
from .services import Services
from .textutil import clamp, clip_at_sentence, sanitize_text
from .tools.web import WebClient

log = logging.getLogger("agent_service.run")

SHORTENED = "\n\n(shortened)"


def finish_answer(text: str, max_chars: int = ANSWER_MAX_CHARS) -> str:
    """Port of `finishAnswer` (src/agents/answer.ts): clean like the server does, redact credentials, then cut at a sentence end
    with an open code block closed and '(shortened)' to say so. Everything that leaves the service passes through here."""
    out = scrub_secrets(sanitize_text(text, max_chars * 2)).text
    if len(out) > max_chars:
        out = clip_at_sentence(out, max_chars - len(SHORTENED) - 4).rstrip()
        if out.count("```") % 2 == 1:
            out += "\n```"
        out += SHORTENED
    return out


def _unwrap(exc: BaseException) -> BaseException:
    """ADK may wrap an error a node raised; find the RunError (or the timeout) underneath."""
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        if isinstance(cur, RunError):
            return cur
        seen.add(id(cur))
        cur = cur.__cause__ or cur.__context__
    return exc


async def dispatch(rc: RunCtx) -> Result:
    kind = rc.req.kind
    if kind == "mention":
        if rc.req.agent.handle == "studio":
            from .agents.chief import run_chief

            return await run_chief(rc)
        from .agents.librarian import run_librarian

        return await run_librarian(rc)
    if kind == "plan":
        from .agents.planner import run_planner

        return await run_planner(rc)
    if kind == "minutes":
        from .agents.scribe import run_scribe

        return await run_scribe(rc)
    if kind == "review":
        from .agents.reviewer import run_reviewer

        return await run_reviewer(rc)
    if kind == "import":
        from .agents.importer import run_importer

        return await run_importer(rc)
    # The delivery pipeline: each stage button has its own colleague and its own artifact.
    if kind == "spec":
        from .agents.spec import run_spec

        return await run_spec(rc)
    if kind == "design":
        from .agents.designer import run_designer

        return await run_designer(rc)
    if kind == "implement":
        from .agents.developer import run_developer

        return await run_developer(rc)
    if kind == "tests":
        from .agents.qa import run_qa

        return await run_qa(rc)
    if kind in ("release_pack", "rollout_review"):
        from .agents.release import run_release

        return await run_release(rc)
    raise InvalidRun(f"unknown kind {kind!r}")


def final_payload(rc: RunCtx, result: Result) -> dict[str, Any]:
    text = finish_answer(result.text)
    if not text:
        raise RunError("The AI produced an empty answer.")
    citations = []
    for c in result.citations[:CITATIONS_MAX]:
        d = dump(c)
        d["title"] = clamp(scrub(sanitize_text(d["title"], 200)), 200)
        if d.get("quote"):
            d["quote"] = clamp(scrub(sanitize_text(d["quote"], QUOTE_MAX)), QUOTE_MAX)
            if not d["quote"]:
                d.pop("quote")
        citations.append(d)
    cards = [scrub_deep(dump(card)) for card in result.cards[:2]]
    # What a pipeline agent drafted is validated against the same rules the team server will run, scrubbed, and capped.
    kept, problems = validate_artifacts(result.artifacts)
    if problems:
        note = "\n\nNot kept: " + "; ".join(problems[:3])
        if len(text) + len(note) <= ANSWER_MAX_CHARS:
            text += note
    artifacts = [scrub_deep(dump(draft)) for draft in kept]
    usage = Usage(
        model=rc.model_used,
        inputTokens=rc.budget.input_tokens,
        outputTokens=rc.budget.output_tokens,
        seconds=rc.budget.seconds,
    )
    payload: dict[str, Any] = {"text": text, "citations": citations, "cards": cards, "usage": dump(usage)}
    if artifacts:
        payload["artifacts"] = artifacts
    return payload


async def execute_run(
    req: RunRequest,
    services: Services,
    emit: Emit,
    *,
    model_builder: Callable[[RunCtx, str], list] | None = None,
    web: WebClient | None = None,
) -> None:
    """Runs one request and reports through `emit` (`status`, `step`, then exactly one of `final` and `error`)."""
    settings = services.settings
    budget = RunBudget(settings.max_output_tokens, settings.max_call_tokens)
    own_web = False
    rc = RunCtx(
        req=req,
        settings=settings,
        knowledge=services.knowledge,
        embedder=services.embedder,
        budget=budget,
        emit=emit,
        model_builder=model_builder,
    )
    started = time.monotonic()
    try:
        rc.status("queued")
        if web is None and req.webBase:
            try:
                base = check_web_base(req.webBase, settings)
            except ValueError as exc:
                raise InvalidRun(str(exc)) from exc
            web = WebClient(base, tokens=services.tokens, auth=settings.auth_mode != "none", timeout=settings.tool_timeout_seconds)
            own_web = True
        rc.web = web
        rc.status("thinking")
        async with asyncio.timeout(settings.run_timeout_seconds):
            result = await dispatch(rc)
        emit("final", final_payload(rc, result))
        log.info(
            "run %s kind=%s ok seconds=%.1f in=%d out=%d calls=%d",
            req.runId, req.kind, time.monotonic() - started, budget.input_tokens, budget.output_tokens, budget.calls,
        )
    except asyncio.CancelledError:
        raise
    except TimeoutError:
        emit("error", {"code": RunTimeout.code, "message": RunTimeout.default_message})
    except Exception as exc:  # noqa: BLE001 - every ending is reported as an event
        err = _unwrap(exc)
        if isinstance(err, RunError):
            if isinstance(err, ModelUnavailable):
                log.warning("run %s: model unavailable", req.runId)
            emit("error", {"code": err.code, "message": str(err)})
        else:
            log.exception("run %s failed", req.runId)
            emit("error", {"code": "internal", "message": "The AI service hit an unexpected problem."})
    finally:
        if own_web and web is not None:
            await web.aclose()
