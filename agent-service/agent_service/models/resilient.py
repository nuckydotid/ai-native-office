"""A model that does not give up at the first 429 or 503.

`ResilientLlm` wraps an ordered list of real models (the primary, then the fallbacks). A call is retried with exponential backoff
and jitter on rate limits and overloads, then handed to the next model in the chain. It also holds the run's token budget: no call
may ask for more than what is left of it, and every answer's usage is charged to it.
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import AsyncGenerator, Awaitable, Callable

from google.adk.models._capabilities import LlmCapabilities
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from pydantic import ConfigDict

from ..errors import ModelUnavailable
from .budget import RunBudget

log = logging.getLogger("agent_service.models")

RETRYABLE_CODES = {408, 429, 500, 502, 503, 504}
# A model that does not exist for this project (or is not allowed) is skipped without waiting: the next one may be fine.
SKIP_MODEL_CODES = {403, 404}
# A hung model call must not eat a run's whole wall-clock budget: cap each call, then retry it like a timeout.
CALL_TIMEOUT_SECONDS = 120.0


def error_code(exc: BaseException) -> int | None:
    """The HTTP status of an error from the Google client libraries, if it has one."""
    code = getattr(exc, "code", None)
    if isinstance(code, int):
        return code
    status = getattr(exc, "status_code", None)
    return status if isinstance(status, int) else None


def is_retryable(exc: BaseException) -> bool:
    code = error_code(exc)
    if code is not None:
        return code in RETRYABLE_CODES
    text = f"{type(exc).__name__} {exc}".lower()
    return isinstance(exc, (asyncio.TimeoutError, ConnectionError, TimeoutError)) or any(
        w in text for w in ("resource_exhausted", "unavailable", "overloaded", "timeout", "temporarily", "connection")
    )


def should_skip_model(exc: BaseException) -> bool:
    return error_code(exc) in SKIP_MODEL_CODES


class ResilientLlm(BaseLlm):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    model: str = "resilient"
    chain: list[BaseLlm]
    budget: RunBudget
    attempts: int = 3
    base_delay: float = 0.8
    max_delay: float = 8.0
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    # Read after a run: which model of the chain finally answered, and how many tries it took in all.
    last_model: str = ""
    tries: int = 0

    @property
    def capabilities(self) -> LlmCapabilities:
        # Every agent of ours keeps tools and a response schema in separate steps, so this never needs both together.
        return LlmCapabilities(output_schema_and_tools=False)

    @classmethod
    def supported_models(cls) -> list[str]:
        return []

    def _delay(self, attempt: int) -> float:
        return min(self.max_delay, self.base_delay * (2**attempt)) * (0.5 + random.random() / 2)

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        allowed = self.budget.before_call()
        cfg = llm_request.config
        if cfg is not None:
            asked = cfg.max_output_tokens or allowed
            cfg.max_output_tokens = min(asked, allowed)

        last: BaseException | None = None
        for inner in self.chain:
            # The request arrives carrying this wrapper's own name ("resilient"): the inner client would look that model up.
            inner_model = getattr(inner, "model", None)
            if inner_model:
                llm_request.model = inner_model
            for attempt in range(self.attempts):
                self.tries += 1
                try:
                    responses: list[LlmResponse] = []
                    async with asyncio.timeout(CALL_TIMEOUT_SECONDS):
                        async for r in inner.generate_content_async(llm_request, stream=False):
                            responses.append(r)
                    if not responses or not any(_has_content(r) for r in responses):
                        raise _EmptyAnswer(f"{inner.model} returned no content")
                except Exception as exc:  # noqa: BLE001 - any model failure decides retry or fallback below
                    last = exc
                    if should_skip_model(exc):
                        log.warning("model %s is not usable (%s); trying the next one", inner.model, error_code(exc))
                        break
                    if not (is_retryable(exc) or isinstance(exc, _EmptyAnswer)):
                        raise
                    wait = self._delay(attempt)
                    log.warning("model %s failed (%s); attempt %d/%d", inner.model, _short(exc), attempt + 1, self.attempts)
                    if attempt + 1 < self.attempts:
                        await self.sleep(wait)
                    continue
                self.last_model = inner.model
                self._charge(inner.model, responses)
                for r in responses:
                    yield r
                return
            log.warning("model %s gave up; falling back", inner.model)
        raise ModelUnavailable() from last

    def _charge(self, model: str, responses: list[LlmResponse]) -> None:
        usage = next((r.usage_metadata for r in reversed(responses) if r.usage_metadata), None)
        if usage is None:
            self.budget.charge(model, 0, 0)
            return
        out = (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0)
        self.budget.charge(model, usage.prompt_token_count or 0, out)


class _EmptyAnswer(Exception):
    pass


def _has_content(r: LlmResponse) -> bool:
    c = r.content
    return bool(c and c.parts and any(p.text or p.function_call or p.inline_data or p.function_response for p in c.parts))


def _short(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {str(exc)[:120]}"
