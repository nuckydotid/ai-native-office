"""Indexing and search on top of a store and an embedder. Idempotent: chunk ids are `<kind>:<id>:<n>`, and an item whose text has
not changed since it was last indexed is not embedded again."""

from __future__ import annotations

import asyncio
import hashlib
import logging

from ..contract import IndexItem
from ..models.embeddings import Embedder
from ..scrub import scrub
from .chunker import chunk_markdown, embedding_text
from .store import KnowledgeStore
from .types import Passage, StoredChunk

log = logging.getLogger("agent_service.knowledge")

# How many items are indexed at once during a reindex (each item embeds its own chunks in parallel too).
IMPORT_CONCURRENCY = 4


def content_hash(title: str, body: str) -> str:
    return hashlib.sha256(f"{title}\n{body}".encode()).hexdigest()[:20]


class KnowledgeService:
    def __init__(self, store: KnowledgeStore, embedder: Embedder, min_score: float = 0.0) -> None:
        self.store = store
        self.embedder = embedder
        self.min_score = min_score
        self._write = asyncio.Lock()

    @property
    def label(self) -> str:
        return self.store.label

    async def index(self, item: IndexItem) -> int:
        """Indexes one doc or ticket. Returns how many chunks it now has (0 when it was deleted)."""
        async with self._write:
            return await self._index(item)

    async def _index(self, item: IndexItem) -> int:
        if item.deleted:
            await self.store.delete_item(item.kind, item.id)
            return 0
        # Documents are team text. Credentials that look like credentials are never put into the index, so no answer can quote one.
        title, body = scrub(item.title), scrub(item.body)
        digest = content_hash(title, body)
        chunks = chunk_markdown(item.kind, item.id, title, body)
        if await self.store.item_hash(item.kind, item.id) == digest and len(await self.store.chunks_of(item.kind, item.id)) == len(chunks):
            return len(chunks)
        vectors = await self.embedder.embed_documents([embedding_text(c) for c in chunks])
        await self.store.replace_item(
            item.kind,
            item.id,
            [StoredChunk(c, v, item.updatedAt, digest) for c, v in zip(chunks, vectors, strict=True)],
        )
        return len(chunks)

    async def reindex(self, items: list[IndexItem], replace_all: bool = False) -> int:
        """Indexes many items in parallel (a few at a time), so a full reindex is not one embedding round-trip per item.
        With `replace_all`, anything indexed that is not in the list is removed. Returns the items indexed."""
        async with self._write:
            seen: set[tuple[str, str]] = set()
            for item in items:
                if not item.deleted:
                    seen.add((item.kind, item.id))
            sem = asyncio.Semaphore(IMPORT_CONCURRENCY)

            async def one(item: IndexItem) -> None:
                async with sem:
                    await self._index(item)
                    done[0] += 1
                    if done[0] % 10 == 0:
                        log.info("indexed %d/%d items", done[0], len(items))

            done = [0]
            await asyncio.gather(*(one(item) for item in items))
            if replace_all:
                for kind, item_id in await self.store.item_keys() - seen:
                    await self.store.delete_item(kind, item_id)
            return len([i for i in items if not i.deleted])

    async def search(self, query: str, k: int = 6, kinds: list[str] | None = None) -> list[Passage]:
        vector = await self.embedder.embed_query(query)
        hits = await self.store.search(vector, k, kinds)
        return [p for p in hits if p.score >= self.min_score]

    async def chunks_of(self, kind: str, item_id: str) -> list[Passage]:
        return await self.store.chunks_of(kind, item_id)
