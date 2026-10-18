"""The HTTP surface: health, indexing, reindexing, and one run streamed as server-sent events."""

from __future__ import annotations

import httpx

from agent_service.main import create_app

from .support import make_services, run_request


def app_and_services():
    services = make_services()
    return create_app(settings=services.settings, services=services), services


PAGE = {"kind": "doc", "id": "remote-work", "title": "Remote work", "body": "# Remote work\nCore hours are 10:00 to 14:00 Singapore time.", "updatedAt": 1}


async def test_health_index_and_a_streamed_run():
    app, _ = app_and_services()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        health = await client.get("/health")
        assert health.status_code == 200
        assert health.json()["ok"] is True

        indexed = await client.post("/v1/index", json=PAGE)
        assert indexed.status_code == 200
        assert indexed.json()["chunks"] >= 1

        body = run_request(question="@librarian What are our core working hours?").model_dump(by_alias=True, mode="json")
        res = await client.post("/v1/run", json=body)
        assert res.status_code == 200
        assert "event: status" in res.text
        assert "event: final" in res.text
        assert "10:00" in res.text
        assert "event: error" not in res.text


async def test_reindex_replace_all_removes_what_is_gone():
    app, services = app_and_services()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/v1/index", json=PAGE)
        gone = dict(PAGE, id="old", title="Old")
        await client.post("/v1/index", json=gone)
        res = await client.post("/v1/reindex", json={"items": [PAGE], "replaceAll": True})
        assert res.status_code == 200
        assert res.json()["indexed"] == 1
    assert await services.knowledge.chunks_of("doc", "old") == []
    assert await services.knowledge.chunks_of("doc", "remote-work")
