from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Protocol

import numpy as np

from .types import Chunk, Passage, StoredChunk


class KnowledgeStore(Protocol):
    """Where chunks and their vectors live. Two kinds: Firestore (with `find_nearest`) and memory (numpy cosine)."""

    label: str

    async def item_hash(self, kind: str, item_id: str) -> str | None: ...

    async def replace_item(self, kind: str, item_id: str, chunks: Sequence[StoredChunk]) -> None:
        """Writes the item's chunks under their deterministic ids and removes any older chunk of it that is no longer there."""
        ...

    async def delete_item(self, kind: str, item_id: str) -> int: ...

    async def search(self, vector: Sequence[float], k: int, kinds: Sequence[str] | None = None) -> list[Passage]: ...

    async def chunks_of(self, kind: str, item_id: str) -> list[Passage]: ...

    async def item_keys(self) -> set[tuple[str, str]]: ...

    async def count(self) -> int: ...


class MemoryStore:
    label = "memory"

    def __init__(self) -> None:
        self._rows: dict[str, StoredChunk] = {}
        self._lock = asyncio.Lock()

    async def item_hash(self, kind: str, item_id: str) -> str | None:
        row = self._rows.get(f"{kind}:{item_id}:0")
        return row.content_hash if row else None

    async def replace_item(self, kind: str, item_id: str, chunks: Sequence[StoredChunk]) -> None:
        async with self._lock:
            keep = {c.chunk.chunk_id for c in chunks}
            for key in [k for k, r in self._rows.items() if r.chunk.kind == kind and r.chunk.item_id == item_id and k not in keep]:
                del self._rows[key]
            for c in chunks:
                self._rows[c.chunk.chunk_id] = c

    async def delete_item(self, kind: str, item_id: str) -> int:
        async with self._lock:
            gone = [k for k, r in self._rows.items() if r.chunk.kind == kind and r.chunk.item_id == item_id]
            for k in gone:
                del self._rows[k]
            return len(gone)

    @staticmethod
    def _passage(row: StoredChunk, score: float = 0.0) -> Passage:
        c = row.chunk
        return Passage(c.kind, c.item_id, c.n, c.title, c.text, score, c.heading, row.updated_at)

    async def search(self, vector: Sequence[float], k: int, kinds: Sequence[str] | None = None) -> list[Passage]:
        rows = [r for r in self._rows.values() if not kinds or r.chunk.kind in kinds]
        if not rows:
            return []
        q = np.asarray(vector, dtype=np.float64)
        m = np.asarray([r.embedding for r in rows], dtype=np.float64)
        # Vectors are unit length, so the dot product is the cosine similarity.
        scores = m @ q
        order = np.argsort(-scores, kind="stable")[:k]
        return [self._passage(rows[i], float(scores[i])) for i in order]

    async def chunks_of(self, kind: str, item_id: str) -> list[Passage]:
        rows = sorted((r for r in self._rows.values() if r.chunk.kind == kind and r.chunk.item_id == item_id), key=lambda r: r.chunk.n)
        return [self._passage(r) for r in rows]

    async def item_keys(self) -> set[tuple[str, str]]:
        return {(r.chunk.kind, r.chunk.item_id) for r in self._rows.values()}

    async def count(self) -> int:
        return len(self._rows)
