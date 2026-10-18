"""Which models a run uses: Gemini on Vertex AI, or the deterministic fake. Names come from settings, never from code."""

from __future__ import annotations

import functools
import logging
from typing import TYPE_CHECKING

from google.adk.models.base_llm import BaseLlm

from ..config import Settings
from .fake import FakeLlm

if TYPE_CHECKING:
    from ..runtime import RunCtx

log = logging.getLogger("agent_service.models")


def tier_model(settings: Settings, tier: str) -> str:
    return {"main": settings.model, "fast": settings.model_fast, "pro": settings.model_pro}.get(tier, settings.model)


@functools.lru_cache(maxsize=4)
def _client(project: str, location: str, vertex: bool):
    from google import genai

    return genai.Client(vertexai=vertex, project=project or None, location=location or None)


def build_chain(rc: RunCtx, tier: str) -> list[BaseLlm]:
    """The primary model of the tier, then the fallbacks, in the order a failing call tries them."""
    s = rc.settings
    if s.fake_model:
        return [FakeLlm(model=f"fake-gemini-{tier}", tier=tier)]
    from google.adk.models.google_llm import Gemini

    client = _client(s.project, s.location, s.use_vertex)
    # Retries are ours (ResilientLlm: backoff, then the next model), so the client's own are off.
    return [Gemini(model=name, client=client) for name in s.model_chain(tier_model(s, tier))]
