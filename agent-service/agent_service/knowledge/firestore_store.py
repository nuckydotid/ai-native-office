"""Firestore knowledge store: one document per chunk in the `knowledge` collection, with a Vector field and `find_nearest`.

Fields: kind, id, title, chunk (the chunk number), text, updatedAt, embedding (Vector), plus heading and hash. The vector index must
exist before the first search (see README: one `gcloud firestore indexes composite create` command, run by a person).
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any

from ..config import Settings
from .types import Chunk, Passage, StoredChunk

log = logging.getLogger("agent_service.firestore")


def doc_key(chunk_id: str) -> str:
    # Document ids cannot contain a slash; everything else of ours (`kind:id:n`) is allowed.
    return chunk_id.replace("/", "%2F")


class FirestoreStore:
    label = "firestore"

    def __init__(self, settings: Settings, client: Any | None = None) -> None:
        from google.cloud import firestore

        self._fs = firestore
        self._client = client or firestore.AsyncClient(project=settings.project or None)
        self._coll = self._client.collection(settings.firestore_collection)

    async def item_hash(self, kind: str, item_id: str) -> str | None:
        snap = await self._coll.document(doc_key(f"{kind}:{item_id}:0")).get()
        return (snap.to_dict() or {}).get("hash") if snap.exists else None

    async def _existing_ids(self, kind: str, item_id: str) -> list[str]:
        from google.cloud.firestore_v1.base_query import FieldFilter

        q = self._coll.where(filter=FieldFilter("kind", "==", kind)).where(filter=FieldFilter("id", "==", item_id))
        return [d.id async for d in q.select([]).stream()]

    async def replace_item(self, kind: str, item_id: str, chunks: Sequence[StoredChunk]) -> None:
        from google.cloud.firestore_v1.vector import Vector

        keep = {doc_key(c.chunk.chunk_id) for c in chunks}
        batch = self._client.batch()
        for c in chunks:
            ch = c.chunk
            batch.set(
                self._coll.document(doc_key(ch.chunk_id)),
                {
                    "kind": ch.kind,
                    "id": ch.item_id,
                    "title": ch.title,
                    "chunk": ch.n,
                    "text": ch.text,
                    "heading": ch.heading,
                    "updatedAt": c.updated_at,
                    "hash": c.content_hash,
                    "embedding": Vector(list(c.embedding)),
                },
            )
        for stale in set(await self._existing_ids(kind, item_id)) - keep:
            batch.delete(self._coll.document(stale))
        await batch.commit()

    async def delete_item(self, kind: str, item_id: str) -> int:
        ids = await self._existing_ids(kind, item_id)
        if ids:
            batch = self._client.batch()
            for i in ids:
                batch.delete(self._coll.document(i))
            await batch.commit()
        return len(ids)

    @staticmethod
    def _passage(d: dict[str, Any], score: float = 0.0) -> Passage:
        return Passage(
            d.get("kind", "doc"),
            str(d.get("id", "")),
            int(d.get("chunk", 0)),
            d.get("title", ""),
            d.get("text", ""),
            score,
            d.get("heading", ""),
            float(d.get("updatedAt", 0) or 0),
        )

    async def search(self, vector: Sequence[float], k: int, kinds: Sequence[str] | None = None) -> list[Passage]:
        from google.cloud.firestore_v1.base_vector_query import DistanceMeasure
        from google.cloud.firestore_v1.vector import Vector

        query = self._coll.find_nearest(
            vector_field="embedding",
            query_vector=Vector(list(vector)),
            distance_measure=DistanceMeasure.COSINE,
            limit=min(1000, k * 2 if kinds else k),
            distance_result_field="distance",
        )
        out: list[Passage] = []
        async for snap in query.stream():
            d = snap.to_dict() or {}
            if kinds and d.get("kind") not in kinds:
                continue
            # Cosine distance is 1 - cosine similarity.
            out.append(self._passage(d, 1.0 - float(d.get("distance", 1.0))))
            if len(out) >= k:
                break
        return out

    async def chunks_of(self, kind: str, item_id: str) -> list[Passage]:
        from google.cloud.firestore_v1.base_query import FieldFilter

        q = self._coll.where(filter=FieldFilter("kind", "==", kind)).where(filter=FieldFilter("id", "==", item_id))
        rows = [(s.to_dict() or {}) async for s in q.stream()]
        return [self._passage(d) for d in sorted(rows, key=lambda d: d.get("chunk", 0))]

    async def item_keys(self) -> set[tuple[str, str]]:
        keys: set[tuple[str, str]] = set()
        async for snap in self._coll.select(["kind", "id"]).stream():
            d = snap.to_dict() or {}
            keys.add((str(d.get("kind")), str(d.get("id"))))
        return keys

    async def count(self) -> int:
        agg = await self._coll.count().get()
        return int(agg[0][0].value)


def build_store(settings: Settings) -> Any:
    from .store import MemoryStore

    if settings.knowledge_backend == "memory":
        return MemoryStore()
    return FirestoreStore(settings)


__all__ = ["FirestoreStore", "Chunk", "build_store", "doc_key"]
