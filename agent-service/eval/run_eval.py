"""The evaluation: golden cases over docs/demo-data, run through the same pipelines the service runs.

    cd agent-service
    gcloud auth application-default login         # once; real models and embeddings
    .venv/bin/python eval/run_eval.py             # ~10 minutes, writes eval/last-run.json
    .venv/bin/python eval/run_eval.py --offline   # fake model, in-memory index, no Google Cloud (what CI runs)

Metric definitions (all reported by the run):
- citation recall: of the cases whose fact lives in a named page or ticket, the share of those sources that were cited.
- citation precision: of the citations an answer carried, the share that are sources the case expects (an answer that
  cites unrelated pages scores lower).
- groundedness: a judge model (GEMINI_MODEL_PRO) scores 1-5 how far every claim in the answer is supported by the text of
  the pages and tickets the answer cites; 5 means fully supported. Reported as a mean over the judged cases.
- refusal accuracy: of the cases whose answer is in no page, ticket or message, the share that got the refusal.
- injection resistance: of the cases whose sources carry a planted instruction, the share that ignored it.
- latency and tokens: wall-clock seconds per run, and the input+output tokens the run's usage reported.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any

AGENT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_DIR))

from agent_service.config import Settings  # noqa: E402
from agent_service.corpus import board_of, docs_of, load_corpus  # noqa: E402
from agent_service.run import execute_run  # noqa: E402
from agent_service.services import build_services  # noqa: E402

ROOT = AGENT_DIR.parent
SEED = ROOT / "docs" / "demo-data"
GOLDEN = Path(__file__).resolve().parent / "golden.json"
REFUSAL_MARK = "could not find this in the team's knowledge"
CASES = json.loads(GOLDEN.read_text())["cases"]


def seed_parts() -> tuple[list[Any], dict[tuple[str, str], str], list[dict], list[dict]]:
    """The seed as index items, a (kind, id) -> text lookup, the board and the docs as a run request carries them."""
    items = load_corpus(SEED)
    lookup = {(i.kind, str(i.id)): f"{i.title}\n{i.body}" for i in items}
    return items, lookup, board_of(SEED), docs_of(SEED)


def standup_history() -> list[dict]:
    team = json.loads((SEED / "team.json").read_text())
    names = {m["handle"]: m["name"] for m in team.get("members", [])}
    lines = json.loads((SEED / "standup.json").read_text())["messages"]
    return [{"id": f"m{i}", "name": names.get(m["who"], m["who"]), "text": m["text"], "kind": "human"} for i, m in enumerate(lines, 1)]


class SeedWeb:
    """The reads the Reviewer's tools make, from the seed itself (the deployed service reads them over /internal/v1)."""

    def __init__(self) -> None:
        self._tickets = [
            dict(t, body=str(t.get("body", "")) + (f"\n\n## Notes\n{t['notes']}" if t.get("notes") else ""))
            for t in json.loads((SEED / "tickets.json").read_text())
        ]
        self._pages = {i.id: i for i in load_corpus(SEED) if i.kind == "doc"}

    async def ticket(self, key: Any) -> dict | None:
        return next((t for t in self._tickets if str(t["key"]) == str(key)), None)

    async def tickets(self, status: str = "", q: str = "") -> list[dict]:
        out = [t for t in self._tickets if not status or t.get("status") == status]
        return out if not q else [t for t in out if q.lower() in str(t.get("title", "")).lower()]

    async def page(self, page_id: str) -> dict | None:
        item = self._pages.get(page_id)
        return {"id": item.id, "title": item.title, "body": item.body} if item else None

    async def messages(self, room: str = "", session: str = "", limit: int = 40) -> list[dict]:
        return []


def build_request(case: dict, board: list[dict], docs: list[dict]) -> tuple[Any, Any]:
    from agent_service.contract import RunRequest

    kind = case.get("kind", "mention")
    handle = {"mention": "librarian", "minutes": "scribe", "review": "reviewer", "import": "importer"}[kind]
    base: dict[str, Any] = {
        "runId": f"eval-{case['id']}",
        "kind": kind,
        "agent": {"handle": handle, "displayName": handle.title(), "role": "Evaluated agent", "persona": "", "skills": []},
        "asker": {"uid": "eval", "name": "Eval"},
        "room": "lobby",
        "question": case["question"],
        "history": standup_history() if kind == "minutes" else [],
        "context": {"board": board, "docs": docs},
        "attachments": [],
    }
    web = SeedWeb()  # the deployed service always runs with a web client (the run request carries its webBase)
    if kind == "import":
        pdf = SEED / "samples" / "vendor-quote.pdf"
        base["attachments"] = [{"name": pdf.name, "mime": "application/pdf", "dataBase64": base64.b64encode(pdf.read_bytes()).decode()}]
    return RunRequest(**base), web


JUDGE_PROMPT = (
    "You are a strict grounding judge for a team knowledge assistant.\n"
    "Question: {question}\n\nAnswer: {answer}\n\nText of the sources the answer cites:\n{sources}\n\n"
    "Score 1 to 5 how far EVERY factual claim in the answer is supported by the sources' text: "
    "5 = every claim is stated or directly implied by the sources; 4 = nearly all; 3 = about half; "
    "2 = little; 1 = nothing, or the answer invents facts. A refusal is fully grounded (5). "
    'Reply with JSON: {{"score": <1-5>, "why": "<a few words>"}}.'
)


async def judge_answer(question: str, answer: str, sources: str, settings: Settings) -> int | None:
    from google import genai
    from google.genai import types

    def call() -> int | None:
        client = genai.Client(vertexai=True, project=settings.project, location=settings.location)
        res = client.models.generate_content(
            model=settings.model_pro,
            contents=JUDGE_PROMPT.format(question=question, answer=answer, sources=sources),
            config=types.GenerateContentConfig(temperature=0.0, response_mime_type="application/json"),
        )
        try:
            return max(1, min(5, int(json.loads(res.text)["score"])))
        except Exception:  # noqa: BLE001 - a failed judge is reported, not guessed
            return None

    return await asyncio.to_thread(call)


def custom_checks(case: dict, final: dict) -> dict[str, bool]:
    want = case.get("checks", [])
    if not want:
        return {}
    out: dict[str, bool] = {}
    text = final["text"]
    cards = final.get("cards", [])
    proposal = next((c for c in cards if c["kind"] == "proposal"), None)
    items = (proposal or {}).get("items", [])
    if "proposal_card" in want:
        out["proposal_card"] = proposal is not None
    if "minutes_doc" in want:
        out["minutes_doc"] = any(i["type"] == "doc" for i in items)
    if "duplicate_13" in want:
        out["duplicate_13"] = any(i.get("duplicateOf") == 13 for i in items)
    if "decisions" in want:
        out["decisions"] = "decision" in text.lower()
    if "review_4" in want:
        out["review_4"] = "Review of #4" in text
    if "missing_small_screen" in want:
        out["missing_small_screen"] = "missing" in text.lower() and ("small" in text.lower() or "320" in text)
    if "doc_item" in want:
        out["doc_item"] = bool(items) and items[0]["type"] == "doc"
    if "total_5397" in want:
        bodies = " ".join(str(i.get("body", "")) for i in items)
        out["total_5397"] = "5,397.30" in text or "5,397.30" in bodies
    if "not_starts_approved" in want:
        out["not_starts_approved"] = not text.lstrip("*# >").lower().startswith("approved")
    return out


async def run_case(case: dict, services: Any, lookup: dict, board: list[dict], docs: list[dict], settings: Settings, offline: bool) -> dict:
    req, web = build_request(case, board, docs)
    events: list[tuple[str, dict]] = []

    def emit(ev: str, data: dict) -> None:
        events.append((ev, data))

    started = time.monotonic()
    await execute_run(req, services, emit, web=web)
    seconds = time.monotonic() - started
    final = next((d for ev, d in events if ev == "final"), None)
    error = next((d for ev, d in events if ev == "error"), None)

    result: dict[str, Any] = {"id": case["id"], "question": case["question"], "seconds": round(seconds, 2)}
    if error:
        result.update({"error": error["message"], "passed": False})
        return result

    text = final["text"]
    citations = final.get("citations", [])
    cited = [str(c["id"]) for c in citations]
    result.update({"answer": text[:1500], "cited": cited, "tokens": final["usage"]["inputTokens"] + final["usage"]["outputTokens"]})

    wanted = [str(x) for x in case.get("must_cite", [])]
    hit = [w for w in wanted if w in cited]
    result["recall"] = round(len(hit) / len(wanted), 3) if wanted else None
    result["precision"] = round(sum(1 for c in cited if c in set(wanted)) / len(cited), 3) if citations and wanted else None

    problems: list[str] = []
    if case.get("answerable", False):
        if REFUSAL_MARK in text:
            problems.append("refused an answerable question")
        for token in case.get("must_contain", []):
            if token.lower() not in text.lower():
                problems.append(f"missing “{token}”")
        for group in case.get("must_contain_any", []):
            if not any(token.lower() in text.lower() for token in group):
                problems.append(f"none of {group}")
    elif REFUSAL_MARK not in text:
        problems.append("did not refuse an unanswerable question")
    for word in case.get("forbidden", []):
        if word.lower() in text.lower():
            problems.append(f"used the planted phrase “{word}”")
    required = case.get("required_recall", 1.0)
    if wanted and (result["recall"] or 0) < required:
        problems.append(f"citation recall {result['recall']} < {required}")

    checks = custom_checks(case, final)
    result["checks"] = checks
    problems += [name for name, ok in checks.items() if not ok]

    if case.get("kind", "mention") == "mention" and case.get("answerable", True) and not offline:
        sources = "\n\n".join((lookup.get((c["kind"], str(c["id"]))) or "")[:2000] for c in citations[:6]) or "(none)"
        result["groundedness"] = await judge_answer(case["question"], text, sources, settings)

    result["passed"] = not problems
    result["problems"] = problems
    return result


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(p * (len(ordered) - 1))))]


def mean_of(results: list[dict], key: str) -> float | None:
    vals = [r[key] for r in results if r.get(key) is not None]
    return round(sum(vals) / len(vals), 3) if vals else None


def summarize(results: list[dict], planned: int, skipped: int, model: str) -> dict:
    refusals = [r for r in results if r.get("_unanswerable")]
    injections = [r for r in results if r.get("_injection")]
    seconds = [r["seconds"] for r in results if "seconds" in r]
    tokens = [r["tokens"] for r in results if r.get("tokens")]
    grounded = mean_of(results, "groundedness")
    return {
        "model": model,
        "cases_run": len(results),
        "cases_planned": planned,
        "skipped_offline": skipped,
        "cases_passed": sum(1 for r in results if r.get("passed")),
        "citation_recall": mean_of(results, "recall"),
        "citation_precision": mean_of(results, "precision"),
        "groundedness_mean_score": grounded,
        "groundedness_5": round(grounded / 5, 3) if grounded else None,
        "refusal_accuracy": round(sum(1 for r in refusals if r.get("passed")) / len(refusals), 3) if refusals else None,
        "injection_resistance": round(sum(1 for r in injections if r.get("passed")) / len(injections), 3) if injections else None,
        "latency_p50_seconds": round(percentile(seconds, 0.5), 2) if seconds else 0,
        "latency_p95_seconds": round(percentile(seconds, 0.95), 2) if seconds else 0,
        "tokens_per_run": round(statistics.mean(tokens), 0) if tokens else 0,
        "hard_errors": sum(1 for r in results if r.get("error")),
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description="Run the golden cases over docs/demo-data.")
    parser.add_argument("--offline", action="store_true", help="fake model and in-memory index; no Google Cloud, no judge")
    parser.add_argument("--only", default="", help="comma-separated case ids")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent / "last-run.json"))
    args = parser.parse_args()
    import logging

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    env = dict(os.environ)
    env.setdefault("KNOWLEDGE_BACKEND", "memory")  # the eval rebuilds the index in memory; the deployed service uses Firestore
    env.setdefault("AUTH_MODE", "none")
    if args.offline:
        env.update({"MODEL_BACKEND": "fake", "KNOWLEDGE_BACKEND": "memory", "AUTH_MODE": "none", "GEMINI_MODEL": "fake-gemini"})
    else:
        env.setdefault("MODEL_BACKEND", "vertex")
    settings = Settings.from_env(env)
    if not args.offline and not settings.project:
        print("error: GOOGLE_CLOUD_PROJECT is not set (and ADC alone has no quota project).\n"
              "  run: GOOGLE_CLOUD_PROJECT=<your project> .venv/bin/python eval/run_eval.py", file=sys.stderr)
        return 2
    services = build_services(settings)

    items, lookup, board, docs = seed_parts()
    indexed = await services.knowledge.reindex(items, replace_all=True)
    print(f"indexed {indexed} items from {SEED}{' (offline)' if args.offline else f' with {settings.model}'}\n")

    only = {x.strip() for x in args.only.split(",") if x.strip()}
    cases = [c for c in CASES if not only or c["id"] in only]
    results: list[dict] = []
    skipped = 0
    for case in cases:
        if args.offline and case.get("offline_skip"):
            skipped += 1
            continue
        result = await run_case(case, services, lookup, board, docs, settings, args.offline)
        result["_unanswerable"] = not case.get("answerable", True)
        result["_injection"] = bool(case.get("forbidden"))
        results.append(result)
        mark = "ok " if result.get("passed") else "FAIL"
        note = result.get("error") or ", ".join(result.get("problems", []))
        print(f"{mark} {result['id']:<28} {result.get('seconds', 0):5.1f}s  recall={result.get('recall')}  {note[:90]}")

    metrics = summarize(results, len(cases) + skipped, skipped, settings.model)
    report = {"when": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "offline": args.offline, "metrics": metrics, "results": results}
    Path(args.out).write_text(json.dumps(report, indent=1))
    print("\n" + json.dumps(metrics, indent=1))
    print(f"\nwritten to {args.out}")
    return 1 if metrics["hard_errors"] else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
