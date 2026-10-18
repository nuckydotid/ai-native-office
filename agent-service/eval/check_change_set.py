#!/usr/bin/env python3
"""The executable check: the Developer Agent's change set must really apply to the sample app and pass its tests.

Runs the agent on the fake model, copies the sample app to a temp folder, writes the change set's files, and runs typecheck and vitest.
This is the check the plan calls for before a change-set prompt or schema change is trusted.

    cd agent-service && python eval/check_change_set.py
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agent-service"))

os.environ.setdefault("MODEL_BACKEND", "fake")
os.environ.setdefault("KNOWLEDGE_BACKEND", "memory")
os.environ.setdefault("AUTH_MODE", "none")

from agent_service.config import Settings  # noqa: E402
from agent_service.contract import RunRequest  # noqa: E402
from agent_service.run import execute_run  # noqa: E402
from agent_service.services import build_services  # noqa: E402

TICKET = {"id": "t-check", "key": 7, "title": "Show what is in stock", "body": "The order list should say what is on hand.", "stage": "build"}


async def produce_change_set() -> dict:
    req = RunRequest(
        runId="check-change-set",
        kind="implement",
        agent={"handle": "developer", "displayName": "Developer Agent", "role": "Developer", "persona": "", "skills": []},
        asker={"uid": "u1", "name": "Ada"},
        room="lobby",
        question="implement ticket #7",
        ticket=TICKET,
    )
    events: list[tuple[str, dict]] = []
    settings = Settings(model_backend="fake", knowledge_backend="memory", auth_mode="none", model="fake-gemini", model_fast="fake-gemini", model_pro="fake-gemini")
    await execute_run(req, build_services(settings), lambda ev, data: events.append((ev, data)))
    error = next((data for ev, data in events if ev == "error"), None)
    if error:
        raise SystemExit(f"the run failed: {error}")
    final = next(data for ev, data in events if ev == "final")
    artifacts = final.get("artifacts") or []
    if not artifacts or artifacts[0].get("kind") != "change_set":
        raise SystemExit(f"the run produced no change set: {json.dumps(final)[:400]}")
    return artifacts[0]


def main() -> int:
    artifact = asyncio.run(produce_change_set())
    files = artifact.get("files") or []
    if not files:
        raise SystemExit("the change set has no files")

    workdir = Path(tempfile.mkdtemp(prefix="northwind-check-"))
    app = workdir / "sample-app"
    shutil.copytree(
        ROOT / "sample-app",
        app,
        ignore=shutil.ignore_patterns("node_modules", "dist", "coverage", "test-results", "playwright-report", "*.log"),
    )
    os.symlink(ROOT / "sample-app" / "node_modules", app / "node_modules")
    try:
        for file in files:
            path = str(file["path"])
            if not path.startswith("sample-app/"):
                raise SystemExit(f"a change set may only write inside sample-app/: {path}")
            target = app / path[len("sample-app/") :]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(str(file.get("content", "")))
        for command in (["npm", "run", "typecheck"], ["npx", "vitest", "run"]):
            result = subprocess.run(command, cwd=app, capture_output=True, text=True, timeout=300)
            if result.returncode != 0:
                print(result.stdout[-2000:])
                print(result.stderr[-2000:], file=sys.stderr)
                raise SystemExit(f"the change set failed: {' '.join(command)}")
        print(json.dumps({"ok": True, "files": [f["path"] for f in files]}))
        return 0
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
