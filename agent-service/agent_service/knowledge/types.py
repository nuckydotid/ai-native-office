from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Chunk:
    """One piece of an item, ready to embed. The id is deterministic, so indexing the same item twice writes the same keys."""

    kind: str  # doc | ticket
    item_id: str
    n: int
    title: str
    text: str
    heading: str = ""

    @property
    def chunk_id(self) -> str:
        return f"{self.kind}:{self.item_id}:{self.n}"


@dataclass(frozen=True)
class Passage:
    """A piece of the team's knowledge an agent has read, and may cite."""

    kind: str  # doc | ticket | chat
    item_id: str
    n: int
    title: str
    text: str
    score: float = 0.0
    heading: str = ""
    updated_at: float = 0

    @property
    def key(self) -> str:
        return f"{self.kind}:{self.item_id}:{self.n}"


@dataclass
class StoredChunk:
    chunk: Chunk
    embedding: list[float]
    updated_at: float
    content_hash: str = ""
    extra: dict = field(default_factory=dict)
