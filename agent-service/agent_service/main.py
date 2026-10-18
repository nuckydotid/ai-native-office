"""FastAPI app: POST /v1/run (SSE), POST /v1/index, POST /v1/reindex, GET /health."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.responses import StreamingResponse

from .auth import require_caller
from .config import Settings
from .contract import IndexItem, ReindexRequest, RunRequest, sse
from .corpus import load_corpus
from .run import execute_run
from .services import Services, build_services

log = logging.getLogger("agent_service")
HEARTBEAT_SECONDS = 15


def setup_telemetry(settings: Settings) -> None:
    """ADK emits OpenTelemetry spans for every agent, model call and tool. With TRACE_TO_CLOUD=true they go to Cloud Trace."""
    if not settings.trace_to_cloud:
        return
    from google.adk.telemetry.google_cloud import get_gcp_exporters
    from google.adk.telemetry.setup import maybe_set_otel_providers

    maybe_set_otel_providers([get_gcp_exporters(enable_cloud_tracing=True)])


def create_app(settings: Settings | None = None, services: Services | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    services = services or build_services(settings)
    setup_telemetry(settings)
    app = FastAPI(title="Worktrees Studio agent service", version="0.1.0")
    auth = Depends(require_caller(settings))

    @app.on_event("startup")
    async def seed() -> None:
        import os

        folder = os.environ.get("SEED_DIR")
        if folder and settings.knowledge_backend == "memory":
            await services.knowledge.reindex(load_corpus(folder), replace_all=True)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "model": settings.model, "knowledge": settings.knowledge_label}

    @app.post("/v1/index", dependencies=[auth])
    async def index(item: IndexItem) -> dict[str, int]:
        return {"chunks": await services.knowledge.index(item)}

    @app.post("/v1/reindex", dependencies=[auth])
    async def reindex(body: ReindexRequest) -> dict[str, int]:
        return {"indexed": await services.knowledge.reindex(body.items, body.replaceAll)}

    @app.post("/v1/run", dependencies=[auth], response_model=None)
    async def run(req: RunRequest, request: Request) -> StreamingResponse:
        queue: asyncio.Queue[tuple[str, dict[str, Any]] | None] = asyncio.Queue()

        def emit(event: str, data: dict[str, Any]) -> None:
            queue.put_nowait((event, data))

        async def work() -> None:
            try:
                await execute_run(req, services, emit)
            finally:
                queue.put_nowait(None)

        task = asyncio.create_task(work())

        async def stream() -> AsyncIterator[str]:
            try:
                while True:
                    try:
                        item = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                    except TimeoutError:
                        yield ": keep-alive\n\n"
                        if await request.is_disconnected():
                            break
                        continue
                    if item is None:
                        break
                    yield sse(*item)
            finally:
                if not task.done():
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return app


def app_factory() -> FastAPI:
    return create_app()
