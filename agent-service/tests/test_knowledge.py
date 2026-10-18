"""The knowledge index: deterministic chunk ids, idempotent writes, pruning on reindex, scrubbed content."""

from __future__ import annotations

from agent_service.contract import IndexItem
from agent_service.knowledge.chunker import chunk_markdown

from .support import make_services


def test_chunks_cut_at_headings_with_stable_ids():
    para = ("alpha and beta and gamma words that fill a section so it stands on its own. " * 12).strip()
    body = f"# One\n{para}\n## Two\n{para.replace('alpha', 'delta')}"
    chunks = chunk_markdown("doc", "p1", "A page", body)
    assert [c.chunk_id for c in chunks] == [f"doc:p1:{i}" for i in range(len(chunks))]
    assert len(chunks) >= 2, "two long sections must be two chunks"
    again = chunk_markdown("doc", "p1", "A page", body)
    assert [c.text for c in again] == [c.text for c in chunks], "the same text must chunk the same way"


async def test_indexing_the_same_item_twice_changes_nothing():
    services = make_services()
    item = IndexItem(kind="doc", id="p1", title="Policy", body="# Policy\nalpha beta gamma")
    first = await services.knowledge.index(item)
    second = await services.knowledge.index(item)
    assert first == second and first >= 1
    assert len(await services.knowledge.chunks_of("doc", "p1")) == first


async def test_reindex_replace_all_prunes_what_is_gone():
    services = make_services()
    await services.knowledge.index(IndexItem(kind="doc", id="p1", title="A", body="# A\nalpha"))
    await services.knowledge.index(IndexItem(kind="doc", id="p2", title="B", body="# B\nbeta"))
    indexed = await services.knowledge.reindex([IndexItem(kind="doc", id="p1", title="A", body="# A\nalpha", updatedAt=2)], replace_all=True)
    assert indexed == 1
    assert await services.knowledge.chunks_of("doc", "p2") == []
    assert await services.knowledge.chunks_of("doc", "p1")


async def test_a_credential_in_a_document_never_reaches_the_index():
    services = make_services()
    key = "AIza" + "x" * 35
    await services.knowledge.index(IndexItem(kind="doc", id="p1", title="Keys", body=f"# Keys\nalpha {key} is the key"))
    chunks = await services.knowledge.chunks_of("doc", "p1")
    assert all(key not in c.text for c in chunks)
