"""The delivery pipeline's rules, mirrored from `src/shared/pipeline/protocol.ts`.

An agent writes code, so the same limits that run in the team server run here too: only three roots may be written, whole files with a
`baseSha`, at most 8 files and 400 lines each, and a deny scan for anything that could reach the machine or the network. The team server
checks again; this side checks first so a run ends with a sentence instead of an artifact that will be dropped.
"""

from __future__ import annotations

import re
from typing import Any

from .contract import ArtifactDraftOut, ArtifactFile, ArtifactKind
from .textutil import sanitize_text

ARTIFACT_KINDS: tuple[ArtifactKind, ...] = ("spec", "design", "change_set", "test_report", "release_pack", "rollout_report", "exploration_report")

# What the team server accepts (PIPELINE_LIMITS) and what an agent promises to stay under.
BODY_MAX = 120_000
TITLE_MAX = 200
FILES_MAX = 8
FILE_LINES_MAX = 400
FILE_BYTES_MAX = 40_000
CHANGE_SET_BYTES_MAX = 200_000
DRAFTS_PER_RUN = 4

WRITABLE_ROOTS = (
    ("sample-app/src/", "src"),
    ("sample-app/tests/", "unit_test"),
    ("sample-app/e2e/", "e2e_test"),
)

FILE_EXT = re.compile(r"\.(ts|tsx|css|html|json|svg|md)$")
SHA = re.compile(r"^[0-9a-f]{64}$")

# What AI-written code may not do, by pattern. Same list as the shared protocol, in Python.
DENY: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("child_process", re.compile(r"\b(?:child_process|worker_threads|cluster)\b")),
    ("node network or file modules", re.compile(r"(?:from\s+|require\(\s*|import\(\s*)['\"](?:node:)?(?:net|dgram|http|https|http2|tls|dns|fs|fs/promises|vm)['\"]")),
    ("network call to an absolute address", re.compile(r"\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b[^\n]{0,120}https?://")),
    ("WebSocket", re.compile(r"\bnew\s+WebSocket\b")),
    ("eval or Function constructor", re.compile(r"\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(")),
    ("dynamic import", re.compile(r"\bimport\s*\(")),
    ("process.env", re.compile(r"\bprocess\s*\.\s*env\b")),
    ("password field", re.compile(r"type\s*=\s*\{?\s*['\"`]password|autoComplete\s*=\s*\{?\s*['\"`](?:current|new)-password|autocomplete\s*=\s*['\"`](?:current|new)-password", re.I)),
    ("external link or asset", re.compile(r"\b(?:href|src|action|formAction|poster)\s*=\s*\{?\s*['\"`]https?://", re.I)),
    ("navigation to an absolute address", re.compile(r"\b(?:window\.open|location\.(?:href|assign|replace))\b[^\n]{0,80}https?://", re.I)),
    ("raw HTML injection", re.compile(r"\b(?:dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write\s*\(")),
    ("cookies", re.compile(r"\bdocument\s*\.\s*cookie\b")),
)


def role_of_path(path: str) -> str | None:
    if not path or len(path) > 200 or "\\" in path or "\0" in path or path.startswith("/"):
        return None
    if re.search(r"(^|/)\.\.?(/|$)", path) or "//" in path:
        return None
    if any(part.startswith(".") for part in path.split("/")):
        return None
    if not FILE_EXT.search(path):
        return None
    for prefix, role in WRITABLE_ROOTS:
        if path.startswith(prefix) and len(path) > len(prefix):
            return role
    return None


def _as_dict(file: ArtifactFile | dict[str, Any]) -> dict[str, Any]:
    return file if isinstance(file, dict) else file.model_dump()


def files_from_model(items: Any) -> list[Any]:
    """What a drafting step wrote (files as arrays of lines, or already whole files) as the dicts `parse_change_set` reads."""
    out: list[Any] = []
    for item in items or []:
        raw = item.model_dump() if hasattr(item, "model_dump") else item
        if isinstance(raw, dict) and "lines" in raw:
            raw = {k: v for k, v in raw.items() if k != "lines"} | {"content": "\n".join(str(x) for x in (raw.get("lines") or []))}
        out.append(raw)
    return out


def normalize_files(files: Any, repo: list[dict[str, Any]] | None) -> Any:
    """The facts a model cannot be trusted to copy are taken from the repo listing instead: the `role` follows the path, and `baseSha` is the
    sha256 main has for that path (null for a file that is not there yet). What the model chose (path, op, content) is left as it was,
    and the strict `parse_change_set` still refuses anything else."""
    if not isinstance(files, list):
        return files
    shas = {str(f.get("path")): f.get("sha") for f in (repo or []) if isinstance(f, dict)}
    out: list[Any] = []
    for raw in files:
        if not isinstance(raw, dict):
            out.append(raw)
            continue
        path = str(raw.get("path", ""))
        fixed = dict(raw)
        role = role_of_path(path)
        if role:
            fixed["role"] = role
        if repo is not None:
            fixed["baseSha"] = shas.get(path) or None
        if fixed.get("op") == "delete":
            fixed["content"] = ""
        out.append(fixed)
    return out


def parse_change_set(files: Any) -> list[dict[str, Any]] | None:
    """Cleaned whole files, or None when anything in the set is not allowed. Nothing is repaired."""
    if not isinstance(files, list) or not files or len(files) > FILES_MAX:
        return None
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    total = 0
    for raw in files:
        if not isinstance(raw, dict):
            return None
        path = str(raw.get("path", ""))
        expected = role_of_path(path)
        if not expected or raw.get("role") != expected or raw.get("op") not in ("write", "delete"):
            return None
        if path in seen:
            return None
        seen.add(path)
        base = raw.get("baseSha")
        if base is not None and not (isinstance(base, str) and SHA.match(base)):
            return None
        content = ""
        if raw.get("op") == "write":
            raw_content = raw.get("content")
            if not isinstance(raw_content, str):
                return None
            content = sanitize_text(raw_content.replace("\r\n", "\n").replace("\r", "\n"), FILE_BYTES_MAX)
            lines = 0 if content == "" else content.count("\n") + 1
            if not content or lines > FILE_LINES_MAX or len(content.encode("utf-8")) > FILE_BYTES_MAX:
                return None
            content += "\n"
        elif isinstance(raw.get("content"), str) and raw.get("content") != "":
            return None
        total += len(content.encode("utf-8"))
        if total > CHANGE_SET_BYTES_MAX:
            return None
        out.append({"path": path, "op": raw["op"], "role": expected, "content": content, "baseSha": base})
    return out


def deny_scan(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for file in files:
        if file.get("op") != "write":
            continue
        for number, line in enumerate(str(file.get("content", "")).split("\n"), start=1):
            for rule, pattern in DENY:
                if pattern.search(line):
                    findings.append({"path": file["path"], "line": number, "rule": rule, "text": line.strip()[:120]})
    return findings


def validate_artifact(draft: ArtifactDraftOut) -> tuple[ArtifactDraftOut | None, list[str]]:
    """The draft as the team server would keep it, or the reasons it would drop it. `change_set` files are validated and scanned."""
    problems: list[str] = []
    if draft.kind not in ARTIFACT_KINDS:
        return None, [f"unknown artifact kind {draft.kind!r}"]
    title = sanitize_text(draft.title, TITLE_MAX)
    body = sanitize_text(draft.body, BODY_MAX)
    if not title or not body:
        return None, ["an artifact needs a title and a body"]
    if draft.kind == "change_set":
        files = parse_change_set([f.model_dump() if isinstance(f, ArtifactFile) else f for f in draft.files])
        if files is None:
            return None, ["the change set has a file outside sample-app/src, tests or e2e, or is over a limit"]
        findings = deny_scan(files)
        if findings:
            first = findings[0]
            return None, [f"a change set cannot use {first['rule']} ({first['path']}, line {first['line']})"]
        return ArtifactDraftOut(kind=draft.kind, title=title, body=body, files=[ArtifactFile(**f) for f in files], meta=draft.meta), []
    if draft.files:
        return None, ["only a change set carries files"]
    return ArtifactDraftOut(kind=draft.kind, title=title, body=body, meta=draft.meta), problems


def validate_artifacts(drafts: list[ArtifactDraftOut]) -> tuple[list[ArtifactDraftOut], list[str]]:
    kept: list[ArtifactDraftOut] = []
    problems: list[str] = []
    for draft in drafts[:DRAFTS_PER_RUN]:
        valid, why = validate_artifact(draft)
        if valid is not None:
            kept.append(valid)
        else:
            problems.extend(why)
    return kept, problems
