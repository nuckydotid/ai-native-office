"""Shared pieces for the tests: a settings object that stays offline, and a way to run one request and collect its events."""

from __future__ import annotations

import base64
from typing import Any

from agent_service.config import Settings
from agent_service.contract import IndexItem, RunRequest
from agent_service.run import execute_run
from agent_service.services import Services, build_services


def fake_settings(**over: Any) -> Settings:
    """Fake model, in-memory index, no auth: the whole service runs with no Google Cloud at all."""
    base: dict[str, Any] = {
        "model_backend": "fake",
        "knowledge_backend": "memory",
        "auth_mode": "none",
        "model": "fake-gemini",
        "model_fast": "fake-gemini",
        "model_pro": "fake-gemini",
    }
    base.update(over)
    return Settings(**base)


def make_services(**over: Any) -> Services:
    return build_services(fake_settings(**over))


def run_request(**over: Any) -> RunRequest:
    base: dict[str, Any] = {
        "runId": "t1",
        "kind": "mention",
        "agent": {"handle": "librarian", "displayName": "Librarian", "role": "Knowledge librarian", "persona": "", "skills": []},
        "asker": {"uid": "u1", "name": "Ada"},
        "room": "lobby",
        "question": "",
        "history": [],
        "context": {"board": [], "docs": []},
        "attachments": [],
    }
    base.update(over)
    return RunRequest(**base)


async def collect(req: RunRequest, services: Services | None = None, web: Any = None) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []

    def emit(ev: str, data: dict) -> None:
        events.append((ev, data))

    await execute_run(req, services or make_services(), emit, web=web)
    return events


def final_of(events: list[tuple[str, dict]]) -> dict | None:
    return next((data for ev, data in events if ev == "final"), None)


def error_of(events: list[tuple[str, dict]]) -> dict | None:
    return next((data for ev, data in events if ev == "error"), None)


def steps_of(events: list[tuple[str, dict]]) -> list[dict]:
    return [data for ev, data in events if ev == "step"]


async def index_page(services: Services, page_id: str, title: str, body: str) -> int:
    return await services.knowledge.index(IndexItem(kind="doc", id=page_id, title=title, body=body, updatedAt=1))


def pdf_base64(text: str = "Vendor quote Q-2026-0417 total 5,397.30 USD") -> str:
    raw = f"%PDF-1.4\n1 0 obj\n<<>>\nstream\n{text}\nendstream\nendobj\n%%EOF\n".encode()
    return base64.b64encode(raw).decode()
