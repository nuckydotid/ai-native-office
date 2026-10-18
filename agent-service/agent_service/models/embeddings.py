"""Embedders: Gemini on Vertex AI for real, and a deterministic lexical one so everything runs offline."""

from __future__ import annotations

import asyncio
import logging
import math
import re
import zlib
from typing import Protocol

import numpy as np

from ..config import Settings
from ..errors import ModelUnavailable
from .resilient import error_code, is_retryable

log = logging.getLogger("agent_service.embeddings")

# A socket that never answers must not hang a reindex (or a run) forever: cap each embedding call and retry.
EMBED_TIMEOUT_SECONDS = 30.0


class Embedder(Protocol):
    dimensions: int
    name: str

    async def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    async def embed_query(self, text: str) -> list[float]: ...


def normalize(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v if n == 0 else v / n


_STOP = frozenset(
    "a an the and or of to in on for with is are was were be been being it its this that these those as at by from "
    "do does did can could should would will shall may might must we our us you your i me my they their them he she his her "
    "what which who whom whose when where why how not no yes if then than so such there here about into over under up down "
    "have has had any all some more most other also just very".split()
)
_WORD = re.compile(r"[a-z0-9]+")


def stem(word: str) -> str:
    """A very small suffix stripper: enough to make 'approved' and 'approval' meet, never meant to be linguistics."""
    for suffix in ("ations", "ation", "ingly", "ings", "ing", "edly", "ed", "ies", "es", "s", "ly"):
        if len(word) > len(suffix) + 3 and word.endswith(suffix):
            return word[: -len(suffix)] + ("y" if suffix == "ies" else "")
    return word


def tokens(text: str) -> list[str]:
    return [stem(w) for w in _WORD.findall(text.lower()) if w not in _STOP and len(w) > 1]


class FakeEmbedder:
    """Feature hashing of stemmed words and word pairs into `dimensions` buckets. Deterministic, offline, and good enough that texts
    sharing words land close together, which is all the offline tests and the fixtures-based eval need from an embedder."""

    name = "fake-hash-embedding"

    def __init__(self, dimensions: int = 768) -> None:
        self.dimensions = dimensions

    def _vec(self, text: str) -> list[float]:
        v = np.zeros(self.dimensions, dtype=np.float64)
        words = tokens(text)
        counts: dict[str, int] = {}
        for w in words:
            counts[w] = counts.get(w, 0) + 1
        for w, c in counts.items():
            h = zlib.crc32(w.encode())
            v[h % self.dimensions] += (1.0 + math.log(c)) * (1.0 if (h >> 16) & 1 else -1.0) * 1.0
        for a, b in zip(words, words[1:], strict=False):
            h = zlib.crc32(f"{a} {b}".encode())
            v[h % self.dimensions] += 0.5 * (1.0 if (h >> 16) & 1 else -1.0)
        return normalize(v).tolist()

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    async def embed_query(self, text: str) -> list[float]:
        return self._vec(text)


class GeminiEmbedder:
    """`gemini-embedding-001` on Vertex AI at 768 dimensions (Firestore vectors go up to 2048). One input per request, a few at a time:
    the model takes a single text per call on Vertex. Vectors are normalised here because truncated embeddings are not unit length."""

    def __init__(self, settings: Settings, client: object | None = None, concurrency: int = 12) -> None:
        from google import genai

        self.name = settings.embed_model
        self.dimensions = settings.embed_dimensions
        self._attempts = settings.retry_attempts
        self._base = settings.retry_base_seconds
        self._sem = asyncio.Semaphore(concurrency)
        self._client = client or genai.Client(
            vertexai=settings.use_vertex, project=settings.project or None, location=settings.location or None
        )

    async def _one(self, text: str, task_type: str) -> list[float]:
        from google.genai import types

        cfg = types.EmbedContentConfig(task_type=task_type, output_dimensionality=self.dimensions)
        last: BaseException | None = None
        async with self._sem:
            for attempt in range(self._attempts):
                try:
                    # A socket that never answers must not hang a reindex (or a run) forever: cap each call and retry.
                    async with asyncio.timeout(EMBED_TIMEOUT_SECONDS):
                        res = await self._client.aio.models.embed_content(model=self.name, contents=text, config=cfg)  # type: ignore[attr-defined]
                    values = res.embeddings[0].values
                    return normalize(np.asarray(values, dtype=np.float64)).tolist()
                except Exception as exc:  # noqa: BLE001
                    last = exc
                    if not is_retryable(exc) or attempt + 1 == self._attempts:
                        break
                    await asyncio.sleep(self._base * (2**attempt))
        log.warning("embedding failed (%s)", error_code(last) if last else "?")
        raise ModelUnavailable("The embedding model is not available right now.") from last

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return list(await asyncio.gather(*(self._one(t, "RETRIEVAL_DOCUMENT") for t in texts)))

    async def embed_query(self, text: str) -> list[float]:
        return await self._one(text, "RETRIEVAL_QUERY")


def build_embedder(settings: Settings) -> Embedder:
    if settings.fake_model:
        return FakeEmbedder(settings.embed_dimensions)
    return GeminiEmbedder(settings)
