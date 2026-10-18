"""Settings, read once from the environment. Models are configuration, never code."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field, replace

DEFAULT_MODEL = "gemini-3.8-flash"
DEFAULT_EMBED_MODEL = "gemini-embedding-001"
EMBED_DIMENSIONS = 768


def _flag(value: str | None, default: bool) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(value: str | None, default: int) -> int:
    try:
        return int(value) if value not in (None, "") else default
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    project: str = ""
    location: str = "global"
    use_vertex: bool = True

    model: str = DEFAULT_MODEL
    model_fast: str = DEFAULT_MODEL
    model_pro: str = DEFAULT_MODEL
    model_fallback: str = ""
    embed_model: str = DEFAULT_EMBED_MODEL
    embed_dimensions: int = EMBED_DIMENSIONS

    model_backend: str = "vertex"  # vertex | fake
    knowledge_backend: str = "firestore"  # firestore | memory
    auth_mode: str = "google"  # google | none
    allowed_caller: str = ""
    # The address Cloud Run gave this service: the audience an incoming ID token must carry.
    service_url: str = ""

    # The most output tokens one run may spend over all its model calls, and the most one call may ask for.
    max_output_tokens: int = 40_000
    max_call_tokens: int = 16_384
    run_timeout_seconds: float = 240.0
    tool_timeout_seconds: float = 20.0

    firestore_collection: str = "knowledge"
    trace_to_cloud: bool = False
    # "low" | "medium" | "high" for Gemini 3 thinking models; empty leaves the model's own default.
    thinking_level: str = ""
    # The lowest cosine similarity a retrieved passage may have. Offline embeddings are lexical and score lower than Gemini's.
    min_score: float = -1.0
    # Retry policy for a model call: attempts per model, then the next model in the chain.
    retry_attempts: int = 3
    retry_base_seconds: float = 0.8

    extra: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        e = os.environ if env is None else env
        model = e.get("GEMINI_MODEL") or DEFAULT_MODEL
        return cls(
            project=e.get("GOOGLE_CLOUD_PROJECT", ""),
            location=e.get("GOOGLE_CLOUD_LOCATION") or "global",
            use_vertex=_flag(e.get("GOOGLE_GENAI_USE_VERTEXAI"), True),
            model=model,
            model_fast=e.get("GEMINI_MODEL_FAST") or model,
            model_pro=e.get("GEMINI_MODEL_PRO") or model,
            model_fallback=e.get("GEMINI_MODEL_FALLBACK", ""),
            embed_model=e.get("EMBED_MODEL") or DEFAULT_EMBED_MODEL,
            model_backend=(e.get("MODEL_BACKEND") or "vertex").lower(),
            knowledge_backend=(e.get("KNOWLEDGE_BACKEND") or "firestore").lower(),
            auth_mode=(e.get("AUTH_MODE") or "google").lower(),
            allowed_caller=(e.get("ALLOWED_CALLER") or "").strip().lower(),
            service_url=(e.get("SERVICE_URL") or "").rstrip("/"),
            max_output_tokens=_int(e.get("MAX_OUTPUT_TOKENS"), 40_000),
            max_call_tokens=_int(e.get("MAX_CALL_TOKENS"), 16_384),
            run_timeout_seconds=float(_int(e.get("RUN_TIMEOUT_SECONDS"), 240)),
            trace_to_cloud=_flag(e.get("TRACE_TO_CLOUD"), False),
            retry_attempts=max(1, _int(e.get("MODEL_RETRY_ATTEMPTS"), 3)),
            firestore_collection=e.get("KNOWLEDGE_COLLECTION") or "knowledge",
            thinking_level=(e.get("THINKING_LEVEL") or "").lower(),
            min_score=float(e["MIN_SCORE"]) if e.get("MIN_SCORE") else -1.0,
            extra={"ALLOWED_WEB_BASES": e.get("ALLOWED_WEB_BASES", "")},
        )

    @property
    def fake_model(self) -> bool:
        return self.model_backend == "fake"

    @property
    def knowledge_label(self) -> str:
        return "firestore" if self.knowledge_backend == "firestore" else "memory"

    @property
    def retrieval_min_score(self) -> float:
        """The similarity floor for retrieved passages: explicit if set, else a backend default."""
        if self.min_score >= 0:
            return self.min_score
        return 0.12 if self.fake_model else 0.3

    def with_(self, **changes: object) -> Settings:
        return replace(self, **changes)  # type: ignore[arg-type]

    def model_chain(self, primary: str) -> list[str]:
        """The primary model, then the fallbacks, without repeats: the order a failing call walks."""
        chain = [primary]
        for m in (self.model_fallback, self.model, self.model_fast):
            if m and m not in chain:
                chain.append(m)
        return chain
