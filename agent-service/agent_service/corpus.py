"""Reads a folder of Markdown pages and a tickets.json into index items, the way the team server's own knowledge push shapes them.

Used by the eval runner, the tests, and `SEED_DIR` (which pre-loads the in-memory index so a local `make dev` has something to ask about).
The folder layout is the demo seed's: `pages/<slug>.md` with front matter (`id`, `title`, `parent`), `tickets.json`, optional `team.json`.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

from .contract import IndexItem

_FRONT = re.compile(r"\A---\n(.*?)\n---\n?(.*)\Z", re.S)


def parse_page(path: Path) -> IndexItem:
    raw = path.read_text(encoding="utf-8")
    m = _FRONT.match(raw)
    meta: dict[str, str] = {}
    body = raw
    if m:
        for line in m.group(1).split("\n"):
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip().strip("\"'")
        body = m.group(2)
    return IndexItem(kind="doc", id=meta.get("id") or path.stem, title=meta.get("title") or path.stem, body=body.strip(), updatedAt=time.time() * 1000)


def ticket_item(t: dict, people: dict[str, str]) -> IndexItem:
    state = str(t.get("status", "todo")).replace("_", " ")
    who = people.get(str(t.get("assignee")), t.get("assignee")) if t.get("assignee") else "nobody yet"
    lines = [
        f"Ticket #{t['key']}: {t['title']}",
        f"Status: {state}. Priority: {t.get('priority', 'normal')}. Assigned to: {who}. Points: {t.get('points') or 'not estimated'}.",
    ]
    if t.get("labels"):
        lines.append(f"Labels: {', '.join(t['labels'])}.")
    if t.get("pr"):
        lines.append(f"Pull request: {t['pr']}")
    body = str(t.get("body", ""))
    if t.get("notes"):
        body += f"\n\n## Notes from tickets/{t['key']}.md\n{t['notes']}"
    lines += ["", body]
    return IndexItem(kind="ticket", id=str(t["key"]), title=f"#{t['key']} {t['title']}", body="\n".join(lines), updatedAt=time.time() * 1000)


def load_corpus(folder: str | Path) -> list[IndexItem]:
    root = Path(folder)
    items = [parse_page(p) for p in sorted((root / "pages").glob("*.md"))]
    people: dict[str, str] = {}
    team = root / "team.json"
    if team.exists():
        people = {m["handle"]: m["name"] for m in json.loads(team.read_text()).get("members", [])}
    tickets = root / "tickets.json"
    if tickets.exists():
        items += [ticket_item(t, people) for t in json.loads(tickets.read_text())]
    return items


def board_of(folder: str | Path) -> list[dict]:
    """The tickets as the run request's `context.board` carries them."""
    tickets = Path(folder) / "tickets.json"
    if not tickets.exists():
        return []
    return [
        {"key": t["key"], "title": t["title"], "status": t["status"], **({"assignee": t["assignee"]} if t.get("assignee") else {}), **({"pr": t["pr"]} if t.get("pr") else {})}
        for t in json.loads(tickets.read_text())
    ]


def docs_of(folder: str | Path) -> list[dict]:
    return [{"id": p.id, "title": p.title} for p in (parse_page(x) for x in sorted((Path(folder) / "pages").glob("*.md")))]
