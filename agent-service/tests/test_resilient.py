"""A model call survives 429/503 with backoff and falls over to the next model; a dead chain is ModelUnavailable."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from agent_service.errors import ModelUnavailable
from agent_service.models.budget import RunBudget
from agent_service.models.resilient import ResilientLlm


class Boom(Exception):
    def __init__(self, code: int = 503) -> None:
        super().__init__(f"boom {code}")
        self.code = code


class ScriptedLlm(BaseLlm):
    model: str = "scripted"
    fails: int = 0
    code: int = 503
    text: str = "hello from the model"
    calls: int = 0

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        self.calls += 1
        if self.calls <= self.fails:
            raise Boom(self.code)
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=self.text)]))


def request_with(tokens: int | None = None) -> LlmRequest:
    contents = [types.Content(role="user", parts=[types.Part(text="hi")])]
    if tokens is None:
        return LlmRequest(model="scripted", contents=contents)
    return LlmRequest(model="scripted", contents=contents, config=types.GenerateContentConfig(max_output_tokens=tokens))


async def call(llm: ResilientLlm, req: LlmRequest) -> list[LlmResponse]:
    return [r async for r in llm.generate_content_async(req)]


async def no_sleep(_seconds: float) -> None:
    return None


async def test_a_503_is_retried_and_then_succeeds():
    inner = ScriptedLlm(fails=2)
    llm = ResilientLlm(chain=[inner], budget=RunBudget(1000, 100), attempts=3, base_delay=0.0, sleep=no_sleep)
    out = await call(llm, request_with())
    assert out and out[0].content.parts[0].text.startswith("hello")
    assert inner.calls == 3
    assert llm.tries == 3
    assert llm.last_model == "scripted"


async def test_a_missing_model_is_skipped_without_waiting_for_the_next():
    gone = ScriptedLlm(model="gone", fails=99, code=404)
    good = ScriptedLlm(model="good")
    llm = ResilientLlm(chain=[gone, good], budget=RunBudget(1000, 100), attempts=3, base_delay=0.0, sleep=no_sleep)
    out = await call(llm, request_with())
    assert out and llm.last_model == "good"
    assert gone.calls == 1, "a 404 is not retried"


async def test_a_chain_that_never_answers_is_model_unavailable():
    llm = ResilientLlm(chain=[ScriptedLlm(fails=99, code=503)], budget=RunBudget(1000, 100), attempts=2, base_delay=0.0, sleep=no_sleep)
    with pytest.raises(ModelUnavailable):
        await call(llm, request_with())


async def test_the_wrapper_stamps_the_inner_models_name_on_the_request():
    """ADK sends the request with the wrapper's own name; the inner client must see the real model id, never "resilient"."""
    req = LlmRequest(model="resilient", contents=[types.Content(role="user", parts=[types.Part(text="hi")])])
    llm = ResilientLlm(chain=[ScriptedLlm(model="good")], budget=RunBudget(1000, 100), attempts=1, base_delay=0.0, sleep=no_sleep)
    out = await call(llm, req)
    assert out and req.model == "good"


async def test_a_call_may_never_ask_for_more_than_the_budget_allows():
    req = request_with(tokens=10_000)
    llm = ResilientLlm(chain=[ScriptedLlm()], budget=RunBudget(50, 40), attempts=1, base_delay=0.0, sleep=no_sleep)
    await call(llm, req)
    assert req.config.max_output_tokens == 40, "the per-call ask is clamped to what the run has left"
