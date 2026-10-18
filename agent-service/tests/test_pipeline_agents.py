"""The delivery-pipeline agents, on the fake model: each one ends with the artifact its stage needs, and the change set is valid."""

from __future__ import annotations

from agent_service.pipeline import deny_scan, parse_change_set

from .support import collect, error_of, final_of, run_request

TICKET = {"id": "t-1", "key": 7, "title": "Show what is in stock", "body": "The order list should say what is on hand.", "stage": "build"}
ARTIFACTS = [{"id": "ar-1", "kind": "spec", "state": "accepted", "version": 1, "title": "Spec: stock"}]

CHANGE_FILES = [
    {"path": "sample-app/src/api/stock.ts", "sha": "a" * 64, "size": 100},
    {"path": "sample-app/src/api/orders.ts", "sha": "b" * 64, "size": 100},
]

JOBS = [
    {"id": "job-1", "kind": "unit", "state": "passed", "inputDigest": "d" * 64, "summary": {"passed": 13, "failed": 0, "coveragePct": 82}},
    {"id": "job-2", "kind": "e2e", "state": "passed", "inputDigest": "d" * 64, "summary": {"passed": 4, "failed": 0}},
    {"id": "job-3", "kind": "scan", "state": "passed", "inputDigest": "d" * 64, "summary": {"scanSeverity": "LOW"}},
]

ROLLOUTS = [
    {
        "id": "ro-1",
        "service": "production",
        "state": "complete",
        "revision": "northwind-portal-00003",
        "previous": "northwind-portal-00002",
        "plan": [10, 50, 100],
        "step": 2,
        "trafficPct": 100,
        "checks": [
            {"percent": 10, "errorRate": 0.0, "p95Ms": 210, "ok": True, "byRevision": {}},
            {"percent": 50, "errorRate": 0.0, "p95Ms": 230, "ok": True, "byRevision": {}},
            {"percent": 100, "errorRate": 0.0, "p95Ms": 205, "ok": True, "byRevision": {}},
        ],
    }
]


class StubWeb:
    """The team server's pipeline reads, as the agents' tools call them."""

    def __init__(self) -> None:
        self.artifact_body = {
            "id": "ar-1",
            "kind": "change_set",
            "version": 1,
            "state": "accepted",
            "title": "Show what is in stock",
            "body": "Adds a stock helper.",
            "files": [{"path": "sample-app/src/api/stock.ts", "op": "write", "role": "src", "content": "export const x = 1;\n", "baseSha": None}],
        }

    async def tickets(self, status: str = "", q: str = ""):
        return [{"key": 7, "title": "Show what is in stock", "status": "in_progress", "priority": "medium", "labels": [], "points": 3, "body": "The order list should say what is on hand."}]

    async def pages(self, q: str = ""):
        return []

    async def page(self, page_id: str):
        return None

    async def messages(self, room: str = "", session: str = "", limit: int = 40):
        return []

    async def repo(self):
        return {"rev": "main@2", "files": CHANGE_FILES}

    async def repo_file(self, path: str):
        return "export const orders = [];\n"

    async def artifacts(self, ticket: str, kind: str = ""):
        return [{"id": "ar-1", "kind": "spec", "state": "accepted", "version": 1, "title": "Spec: stock"}]

    async def artifact(self, artifact_id: str):
        return self.artifact_body if artifact_id == "ar-1" else None

    async def jobs(self, ticket: str):
        return JOBS

    async def job_log(self, job_id: str):
        return {"text": "PIPELINE_RESULT: {\"ok\":true}", "done": True}

    async def rollouts(self, ticket: str):
        return ROLLOUTS


def pipeline_request(kind: str, agent: str, **over):
    base = dict(
        kind=kind,
        agent={"handle": agent, "displayName": agent.title(), "role": "Colleague", "persona": "", "skills": []},
        question=f"work on ticket #{TICKET['key']}",
        ticket=TICKET,
        artifacts=ARTIFACTS,
    )
    base.update(over)
    return run_request(**base)


async def test_the_planner_writes_a_spec_with_a_checklist():
    events = await collect(pipeline_request("spec", "planner"), web=StubWeb())
    assert error_of(events) is None
    final = final_of(events)
    assert final["artifacts"][0]["kind"] == "spec"
    assert "- [ ]" in final["artifacts"][0]["body"]


async def test_the_designer_writes_a_sandboxed_prototype():
    events = await collect(pipeline_request("design", "designer"), web=StubWeb())
    assert error_of(events) is None
    body = final_of(events)["artifacts"][0]["body"]
    assert final_of(events)["artifacts"][0]["kind"] == "design"
    assert "<script" not in body.lower()
    assert "Prototype" in body


async def test_the_developer_writes_a_change_set_the_pipeline_would_accept():
    events = await collect(pipeline_request("implement", "developer"), web=StubWeb())
    assert error_of(events) is None
    artifact = final_of(events)["artifacts"][0]
    assert artifact["kind"] == "change_set"
    files = parse_change_set(artifact["files"])
    assert files is not None, "the change set must pass the same rules the team server runs"
    assert deny_scan(files) == []
    paths = {f["path"] for f in files}
    assert "sample-app/src/api/stock.ts" in paths
    assert "sample-app/tests/stock.test.ts" in paths
    assert "vitest" in next(f["content"] for f in files if f["path"].endswith(".test.ts"))


async def test_the_qa_agent_reports_the_jobs_numbers():
    events = await collect(pipeline_request("tests", "qa"), web=StubWeb())
    assert error_of(events) is None
    artifact = final_of(events)["artifacts"][0]
    assert artifact["kind"] == "test_report"
    assert "82" in artifact["body"], "the coverage the unit job reported must be in the report"


async def test_the_release_agent_writes_the_pack_and_the_rollout_report():
    pack_events = await collect(pipeline_request("release_pack", "release"), web=StubWeb())
    assert error_of(pack_events) is None
    pack = final_of(pack_events)["artifacts"][0]
    assert pack["kind"] == "release_pack"
    assert "Readiness" in pack["body"]

    rollout_events = await collect(pipeline_request("rollout_review", "release"), web=StubWeb())
    assert error_of(rollout_events) is None
    report = final_of(rollout_events)["artifacts"][0]
    assert report["kind"] == "rollout_report"
    assert "Traffic steps" in report["body"]


def test_the_facts_a_model_cannot_copy_come_from_the_repo_listing():
    from agent_service.pipeline import normalize_files

    repo = [{"path": "sample-app/src/App.tsx", "sha": "c" * 64, "size": 10}]
    messy = [
        # a wrong role, and a made-up hash for a file that does exist
        {"path": "sample-app/src/App.tsx", "op": "write", "role": "unit_test", "content": "export const a = 1;\n", "baseSha": "abc123"},
        # an empty string where null belongs, for a file that is not on main yet
        {"path": "sample-app/tests/new.test.ts", "op": "write", "role": "src", "content": "it('x', () => {});\n", "baseSha": ""},
    ]
    assert parse_change_set(messy) is None, "the strict check alone refuses what the model wrote"
    files = parse_change_set(normalize_files(messy, repo))
    assert files is not None
    by_path = {f["path"]: f for f in files}
    assert by_path["sample-app/src/App.tsx"]["role"] == "src"
    assert by_path["sample-app/src/App.tsx"]["baseSha"] == "c" * 64
    assert by_path["sample-app/tests/new.test.ts"]["role"] == "unit_test"
    assert by_path["sample-app/tests/new.test.ts"]["baseSha"] is None


def test_normalizing_never_widens_what_may_be_written():
    from agent_service.pipeline import normalize_files

    hostile = [{"path": "sample-app/Dockerfile", "op": "write", "role": "src", "content": "FROM scratch\n", "baseSha": None}]
    assert parse_change_set(normalize_files(hostile, [])) is None
    assert normalize_files("not a list", []) == "not a list"
    without_repo = [{"path": "sample-app/src/x.ts", "op": "write", "role": "src", "content": "export {};\n", "baseSha": "d" * 64}]
    assert normalize_files(without_repo, None)[0]["baseSha"] == "d" * 64, "with no listing the model's value is left for the strict check"


def test_files_written_as_lines_become_whole_files():
    from agent_service.pipeline import files_from_model, normalize_files
    from agent_service.schemas import DraftFile

    drafted = [DraftFile(path="sample-app/src/a.ts", lines=["export const a = 1;", "export const b = 2;"]), DraftFile(path="sample-app/src/old.ts", op="delete")]
    files = parse_change_set(normalize_files(files_from_model(drafted), [{"path": "sample-app/src/old.ts", "sha": "e" * 64}]))
    assert files is not None
    assert files[0]["content"] == "export const a = 1;\nexport const b = 2;\n"
    assert files[0]["baseSha"] is None
    assert files[1]["op"] == "delete" and files[1]["baseSha"] == "e" * 64
    assert files_from_model([{"path": "sample-app/src/x.ts", "content": "whole\n"}]) == [{"path": "sample-app/src/x.ts", "content": "whole\n"}], "files that are already whole pass through"


async def test_reading_a_failed_jobs_log_keeps_a_scrubbed_copy_for_the_drafter():
    from types import SimpleNamespace

    from agent_service.tools.toolset import build_pipeline_tools

    class Web(StubWeb):  # the log of a failed typecheck, with a secret in it
        async def job_log(self, job_id: str):
            return {"text": "error TS2307: Cannot find module 'x'\nAPI_KEY=AIzaSyA12345678901234567890123456789012", "done": True}

    steps: list[str] = []
    rc = SimpleNamespace(web=Web(), scratch={}, nonce="n0nce", step=lambda name, text: steps.append(name))
    tools = {t.__name__: t for t in build_pipeline_tools(rc)}
    out = await tools["read_job_log"]("job-9")
    assert "TS2307" in out["text"]
    assert "AIzaSy" not in rc.scratch["job_logs"]["job-9"], "a key in a log never reaches a prompt"
    assert steps == ["read_job_log"]
