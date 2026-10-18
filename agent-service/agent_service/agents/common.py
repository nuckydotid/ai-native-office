"""Small helpers every pipeline uses: how a step gets its prompt, its generation config, and how a workflow is run."""

from __future__ import annotations

import base64
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from google.adk import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from ..contract import ArtifactDraftOut, ChatCard, Citation, Phase
from ..prompt import system_instruction, user_message
from ..runtime import RunCtx

log = logging.getLogger("agent_service.agents")

APP_NAME = "studio-agents"
# Sessions live only for the length of a run; the service keeps nothing between runs.
_sessions = InMemorySessionService()


@dataclass
class Result:
    """What a pipeline hands back: the chat message, what it rests on, and any cards. The caller cleans and sends it."""

    text: str
    citations: list[Citation] = field(default_factory=list)
    cards: list[Any] = field(default_factory=list)  # ChatCard models
    artifacts: list[ArtifactDraftOut] = field(default_factory=list)  # pipeline drafts, validated before they go out


def gen_config(rc: RunCtx, *, temperature: float = 0.2, thinking: bool = True) -> types.GenerateContentConfig:
    kwargs: dict[str, Any] = {"temperature": temperature}
    if thinking and rc.settings.thinking_level in ("low", "medium", "high", "minimal"):
        kwargs["thinking_config"] = types.ThinkingConfig(thinking_level=rc.settings.thinking_level)
    return types.GenerateContentConfig(**kwargs)


def instruction_of(rc: RunCtx, *, role: str, task: str) -> Callable[[Any], str]:
    """An ADK instruction provider. A function, not a string: ADK reads `{curly}` words in a string as state variables."""
    text = system_instruction(rc.req, role=role, task=task)
    return lambda _ctx: text


def feed(rc: RunCtx, build: Callable[[], str], phase: Phase | None = None, extra_parts: Callable[[], list[types.Part]] | None = None):
    """A `before_model_callback` that replaces the step's whole input with the prompt we built (quoted data first, the question last).
    Used by steps that read what earlier steps wrote; ADK's own transcript of those steps is never sent."""

    def callback(callback_context: Any, llm_request: Any) -> None:
        if phase:
            rc.status(phase)
        parts = [types.Part(text=build()), *(extra_parts() if extra_parts else [])]
        llm_request.contents = [types.Content(role="user", parts=parts)]
        return None

    return callback


def announce(rc: RunCtx, phase: Phase):
    """A `before_model_callback` for steps whose input ADK manages (the retriever's tool turns): only says what phase it is."""

    def callback(callback_context: Any, llm_request: Any) -> None:
        rc.status(phase)
        return None

    return callback


def capture(rc: RunCtx, key: str):
    """An `after_model_callback` that keeps a step's last plain-text answer in `rc.scratch[key]` for later steps to quote."""

    def callback(callback_context: Any, llm_response: Any) -> None:
        content = getattr(llm_response, "content", None)
        parts = getattr(content, "parts", None) or []
        if parts and not any(p.function_call for p in parts):
            text = "".join(p.text or "" for p in parts if not getattr(p, "thought", False)).strip()
            if text:
                rc.scratch[key] = text
        return None

    return callback


def attachment_parts(rc: RunCtx) -> list[types.Part]:
    parts: list[types.Part] = []
    for a in rc.req.attachments:
        try:
            data = base64.b64decode(a.dataBase64, validate=False)
        except Exception:  # noqa: BLE001
            continue
        if data:
            parts.append(types.Part.from_bytes(data=data, mime_type=a.mime))
    return parts


def first_prompt(rc: RunCtx, blocks: list[str]) -> str:
    return user_message(rc.req, rc.nonce, blocks=blocks)


async def run_workflow(rc: RunCtx, node: Any, text: str, parts: list[types.Part] | None = None) -> None:
    """Runs an ADK workflow to its end. What a pipeline produces is left in `rc.scratch`; events are only for tracing and errors."""
    session_id = f"{rc.req.runId}-{uuid.uuid4().hex[:8]}"
    user_id = rc.req.asker.uid or "anonymous"
    runner = Runner(app_name=APP_NAME, node=node, session_service=_sessions, auto_create_session=True)
    message = types.Content(role="user", parts=[types.Part(text=text), *(parts or [])])
    try:
        async for _event in runner.run_async(user_id=user_id, session_id=session_id, new_message=message):
            pass
    finally:
        try:
            await _sessions.delete_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
        except Exception:  # noqa: BLE001 - cleanup only
            log.debug("could not delete session %s", session_id)
