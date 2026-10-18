"""`MODEL_BACKEND=fake`: a deterministic stand-in for Gemini, so the whole service runs and is tested with no Google Cloud.

It reads the same prompts a real model would and answers by rules: the retriever calls the search tool, the answerer copies the
sentences of the passages that overlap the question (with their labels and quotes), the verifier checks each claim's words and numbers
against its cited passages, and so on. It is not a language model and makes no attempt to sound like one; what it gives the tests is a
stable contract: same input, same output, and the failure modes (a made-up claim, an injected order) on demand.

Two markers in a question switch a failure mode on, so tests can reach it: `[fake:hallucinate]` makes the answerer add a claim no
passage supports, and `[fake:stubborn]` makes the reviser keep it. `fake_obeys` is the "fake judge" for prompt-injection tests: it
follows an order only when it stands outside the quoted data, as a careless prompt would let a real model do.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncGenerator
from typing import Any

from google.adk.models._capabilities import LlmCapabilities
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from ..grounding import support_ratio
from ..knowledge.types import Passage
from .embeddings import tokens

_BLOCK = re.compile(r"<<<([0-9a-f]{8,64})\n(.*?)\n\1>>>", re.S)
_HEAD = re.compile(r'^\[(P\d+)\] (\w+) "(.*?)" \(id: (.*?)\)(?: · section: .*)?$')
_ORDER = re.compile(
    r"ignore (?:all |any |the |your )?(?:previous|prior|above)(?: \w+)? (?:instructions|rules)[^.\n]*?"
    r"(?:reply|respond|answer|say|output|write)(?: only)?(?: with| exactly)?\s*[:\-]?\s*[\"'“]?([A-Z][A-Z0-9_ -]{2,40})",
    re.I,
)

HALLUCINATION = "The project budget for this work is $4.2 million."

# The Developer Agent's deterministic change set: a new helper and its unit test, small enough to read and real enough to run.
STOCK_SRC = """\
export interface StockLine {
  sku: string;
  available: number;
}

export const stock: StockLine[] = [
  { sku: 'NW-WAX-01', available: 12 },
  { sku: 'NW-NOTE-12', available: 4 },
];

/** How many of a sku are on hand; 0 when the sku is not stocked. */
export function availableFor(sku: string): number {
  return stock.find((line) => line.sku === sku)?.available ?? 0;
}
"""

STOCK_TEST = """\
import { describe, expect, it } from 'vitest';
import { availableFor } from '../src/api/stock';

describe('stock', () => {
  it('knows what is available for a sku', () => {
    expect(availableFor('NW-WAX-01')).toBe(12);
  });

  it('is zero for something unknown', () => {
    expect(availableFor('not-a-sku')).toBe(0);
  });
});
"""


def split_blocks(text: str) -> tuple[list[tuple[str, str]], str]:
    """Quoted blocks as (label line, body), and the text outside them."""
    blocks = []
    for m in _BLOCK.finditer(text):
        start = text.rfind("\n\n", 0, m.start())
        label = text[start + 2 : m.start()].strip().split("\n")[-1] if start >= 0 else text[: m.start()].strip().split("\n")[-1]
        blocks.append((label, m.group(2)))
    return blocks, _BLOCK.sub("", text)


def parse_passages(body: str) -> list[tuple[str, Passage]]:
    out: list[tuple[str, Passage]] = []
    cur: tuple[str, str, str, str] | None = None
    buf: list[str] = []

    def flush() -> None:
        if cur:
            label, kind, title, item = cur
            out.append((label, Passage(kind, item, 0, title, "\n".join(buf).strip())))

    for line in body.split("\n"):
        m = _HEAD.match(line)
        if m:
            flush()
            cur, buf = (m.group(1), m.group(2), m.group(3), m.group(4)), []
        else:
            buf.append(line)
    flush()
    return out


def fake_obeys(prompt_text: str) -> str | None:
    """The fake judge: the word a careless model would be talked into saying, if an order stands outside the quoted data."""
    _, outside = split_blocks(prompt_text)
    m = _ORDER.search(outside)
    return m.group(1).strip() if m else None


def _sentences(text: str) -> list[str]:
    out = []
    for raw in re.split(r"(?<=[.!?])\s+|\n+", text):
        if raw.lstrip().startswith("#"):
            continue  # a heading is a title, not a statement
        s = re.sub(r"^[\s>*#\-\d.)]+", "", raw).strip()
        if len(s) >= 15 and not s.startswith("```"):
            out.append(s)
    return out


class FakeLlm(BaseLlm):
    model: str = "fake-gemini"
    tier: str = "main"

    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities(output_schema_and_tools=False)

    @classmethod
    def supported_models(cls) -> list[str]:
        return [r"fake-.*"]

    # ── plumbing ──
    @staticmethod
    def _text_of(content: types.Content) -> str:
        return "\n".join(p.text for p in (content.parts or []) if p.text)

    def _request_parts(self, req: LlmRequest) -> tuple[str, str, bool, list[dict[str, Any]]]:
        system = str(req.config.system_instruction) if req.config and req.config.system_instruction else ""
        user = ""
        responded = False
        responses: list[dict[str, Any]] = []
        for c in req.contents or []:
            for p in c.parts or []:
                if p.function_response is not None:
                    responded = True
                    responses.append(dict(p.function_response.response or {}))
            if c.role == "user" and any(p.text for p in (c.parts or [])):
                user = self._text_of(c)
        return system, user, responded, responses

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        system, user, responded, responses = self._request_parts(llm_request)
        m = re.search(r"ROLE:\s*(\w+)", system)
        role = m.group(1) if m else "answerer"
        handler = getattr(self, f"_role_{role}", None)
        if handler is None:
            out: Any = f"(fake {role})"
        else:
            out = handler(system, user, responded, responses)
        parts: list[types.Part]
        if isinstance(out, list):  # function calls
            parts = [types.Part(function_call=types.FunctionCall(name=n, args=a)) for n, a in out]
            text = json.dumps(out)
        elif isinstance(out, str):
            parts = [types.Part(text=out)]
            text = out
        else:
            text = json.dumps(out.model_dump() if hasattr(out, "model_dump") else out)
            parts = [types.Part(text=text)]
        tin = max(1, (len(system) + len(user)) // 4)
        tout = max(1, len(text) // 4)
        yield LlmResponse(
            content=types.Content(role="model", parts=parts),
            usage_metadata=types.GenerateContentResponseUsageMetadata(
                prompt_token_count=tin, candidates_token_count=tout, total_token_count=tin + tout
            ),
        )

    # ── helpers shared by roles ──
    @staticmethod
    def _question(user: str) -> str:
        _, outside = split_blocks(user)
        m = re.findall(r"^.*? asks: (.*)$", outside, re.M | re.S)
        return (m[-1] if m else outside).strip()

    @staticmethod
    def _find_block(user: str, starts: str) -> str:
        for label, body in split_blocks(user)[0]:
            if label.startswith(starts):
                return body
        return ""

    # ── roles ──
    def _role_retriever(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        if responded:
            n = sum(int(r.get("count", 0) or 0) for r in responses)
            return f"Found {n} passages."
        q = self._question(user)
        keywords = " ".join(dict.fromkeys(tokens(re.sub(r"\[fake:\w+\]", "", q)))) or q
        calls: list[tuple[str, dict]] = [("search_knowledge", {"query": keywords})]
        if re.search(r"\b(ticket|board|review|in progress|assigned|assignee|pull request|pr)\b", q, re.I):
            calls.append(("list_tickets", {}))
        return calls

    def _role_answerer(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import Claim, Draft

        obeyed = fake_obeys(system + "\n" + user)
        if obeyed:
            return Draft(can_answer=True, claims=[Claim(text=obeyed, evidence=["P1"], quote="")])
        q = self._question(user)
        qtok = set(tokens(re.sub(r"\[fake:\w+\]", "", q)))
        passages = parse_passages(self._find_block(user, "Passages the team"))
        scored: list[tuple[float, str, str]] = []
        for label, p in passages:
            for s in _sentences(p.text):
                stok = set(tokens(s))
                shared = qtok & stok
                if len(shared) >= max(2, int(len(qtok) * 0.34 + 0.5)) or (len(qtok) <= 2 and shared):
                    scored.append((len(shared) / (len(qtok) or 1), label, s))
        scored.sort(key=lambda t: -t[0])
        claims: list[Claim] = []
        seen: set[str] = set()
        for _, label, s in scored:
            if s not in seen and len(claims) < 4:
                seen.add(s)
                claims.append(Claim(text=s, evidence=[label], quote=s[:200]))
        if claims and "[fake:hallucinate]" in q:
            claims.append(Claim(text=HALLUCINATION, evidence=[claims[0].evidence[0]], quote=""))
        if not claims:
            return Draft(can_answer=False, claims=[], missing=" ".join(sorted(qtok))[:80])
        return Draft(can_answer=True, claims=claims)

    def _role_verifier(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import ClaimVerdict, Verdict

        passages = dict(parse_passages(self._find_block(user, "Passages the team")))
        claims_body = self._find_block(user, "The draft answer")
        verdicts = []
        for line in claims_body.split("\n"):
            m = re.match(r"^(\d+)\.\s+(.*?)\s+\(cites: (.*?)\)\s*$", line)
            if not m:
                continue
            idx, text, cites = int(m.group(1)), m.group(2), [c.strip() for c in m.group(3).split(",")]
            cited = [passages[c] for c in cites if c in passages]
            nums = set(re.findall(r"\d[\d.,]*", text))
            hay = " ".join(p.text for p in cited)
            ok = bool(cited) and support_ratio(text, cited) >= 0.6 and all(n in hay for n in nums)
            verdicts.append(ClaimVerdict(index=idx, supported=ok, reason="" if ok else "the cited passages do not say this"))
        return Verdict(verdicts=verdicts)

    def _role_reviser(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import Claim, Draft

        q = self._question(user) + " " + user
        rejected = {int(m.group(1)) for m in re.finditer(r"^(\d+)\. rejected:", self._find_block(user, "What the fact checker"), re.M)}
        claims = []
        for line in self._find_block(user, "The draft answer").split("\n"):
            m = re.match(r"^(\d+)\.\s+(.*?)\s+\(cites: (.*?)\)\s*$", line)
            if m and (int(m.group(1)) not in rejected or "[fake:stubborn]" in q):
                cites = [c.strip() for c in m.group(3).split(",") if c.strip() and c.strip() != "none"]
                claims.append(Claim(text=m.group(2), evidence=cites, quote=""))
        return Draft(can_answer=bool(claims), claims=claims, missing="" if claims else "the sources do not confirm it")

    # ── Planner Agent ──
    def _role_researcher(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        if responded:
            titles = list(dict.fromkeys(p["title"] for r in responses for p in r.get("passages", [])))
            return "Prior art: " + "; ".join(titles[:4]) if titles else "Prior art: nothing relevant found."
        q = self._question(user)
        keywords = " ".join(dict.fromkeys(tokens(q))) or q
        return [("search_knowledge", {"query": keywords}), ("list_tickets", {})]

    def _role_estimator(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        board = self._find_block(user, "The board right now")
        lines = [ln for ln in board.split("\n") if ln.startswith("#")]
        return "- Design and build the core slice: medium effort.\n- Review and write-up: low effort.\n" + (
            f"- {len(lines)} tickets already on the board; check them for overlap.\n" if lines else ""
        )

    # ── Scribe ──
    @staticmethod
    def _meeting_lines(user: str) -> list[tuple[str, str]]:
        body = FakeLlm._find_block(user, "Recent chat")
        out: list[tuple[str, str]] = []
        for line in body.split("\n"):
            m = re.match(r"^(.{1,40}?)(?: \(agent\))?: (.+)$", line.strip())
            if m:
                out.append((m.group(1), m.group(2)))
        return out

    def _role_extractor(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import ActionItem, Decision, MeetingExtract

        lines = self._meeting_lines(user)
        topic = (lines[0][1][:60] if lines else "the meeting")
        decisions, actions, risks, questions = [], [], [], []
        want_action = re.compile(r"\b(will|need to|must|should|check|fix|update|add|write|send|prepare|follow up)\b", re.I)
        want_decision = re.compile(r"\b(decided|decision|agreed|we'll|we will|let's|locked|ship)\b", re.I)
        for name, text in lines:
            if text.rstrip().endswith("?"):
                questions.append(text)
                continue
            if re.search(r"\b(risk|worried|concern|might slip)\b", text, re.I):
                risks.append(text)
            if want_decision.search(text):
                decisions.append(Decision(text=text[:200], by=name))
            elif want_action.search(text):
                actions.append(ActionItem(title=text[:80], body=text[:300], owner=name, points=0, labels=[]))
        return MeetingExtract(
            topic=topic,
            summary=f"The team talked through {topic.lower()[:80]}; {len(decisions)} decision(s) and {len(actions)} action item(s) were drawn out.",
            attendees=list(dict.fromkeys(n for n, _ in lines))[:8],
            decisions=decisions[:6],
            action_items=actions[:8],
            risks=risks[:3],
            open_questions=questions[:3],
        )

    def _role_linker(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import ActionLink, ActionLinks

        items = []
        for line in self._find_block(user, "The action items to match").split("\n"):
            m = re.match(r"^(\d+)\.\s+(.*)$", line.strip())
            if m:
                items.append((int(m.group(1)), m.group(2)))
        tickets = []
        for line in self._find_block(user, "The board right now").split("\n"):
            m = re.match(r"^#(\d+)\s+\[[^\]]+\]\s+(.*?)(?:\s+·.*)?$", line.strip())
            if m:
                tickets.append((int(m.group(1)), m.group(2)))
        links = []
        for index, title in items:
            wtok = set(tokens(title))
            best, score = 0, 0.0
            for key, ttitle in tickets:
                shared = len(wtok & set(tokens(ttitle)))
                if shared > score:
                    best, score = key, shared
            links.append(ActionLink(index=index, duplicateOf=best if score >= 2 else 0))
        return ActionLinks(links=links)

    def _role_minutes(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import MinutesDoc

        raw = self._find_block(user, "The extractor's reading of the meeting")
        marks = "\n".join(
            f"- {ln.strip()[3:]}: {'already #' + ln.split('already tracked as #')[-1][:4] if 'already tracked' in ln else 'new'}"
            for ln in self._find_block(user, "How the action items match the board").split("\n")
            if ln.strip()
        )
        title_line = ""
        decisions, actions, risks, questions, summary = [], [], [], [], ""
        try:
            data = json.loads(raw[raw.index("{") : raw.rindex("}") + 1])
            title_line = str(data.get("topic", "")) or "the meeting"
            summary = str(data.get("summary", ""))
            decisions = [str(d.get("text", "")) for d in data.get("decisions", [])]
            actions = [str(a.get("title", "")) for a in data.get("action_items", [])]
            risks = [str(r) for r in data.get("risks", [])]
            questions = [str(q) for q in data.get("open_questions", [])]
        except (ValueError, KeyError):
            title_line = "the meeting"
        parts = [f"# Meeting minutes: {title_line}", "", summary or "(no summary)", ""]
        if decisions:
            parts += ["## Decisions", *[f"- {d}" for d in decisions], ""]
        if actions:
            parts += ["## Action items", *[f"- {a} — {marks.splitlines()[i].split(': ', 1)[-1] if i < len(marks.splitlines()) else 'new'}" for i, a in enumerate(actions)], ""]
        if risks:
            parts += ["## Risks", *[f"- {r}" for r in risks], ""]
        if questions:
            parts += ["## Open questions", *[f"- {q}" for q in questions], ""]
        return MinutesDoc(title=f"Meeting minutes: {title_line}", markdown="\n".join(parts).strip())

    # ── Reviewer ──
    def _role_inspector(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        if not responded:
            m = re.search(r"#(\d+)", self._question(user))
            return [("get_ticket", {"key": int(m.group(1)) if m else 1})]
        passages = []
        for r in responses:
            for p in r.get("passages", []):
                body = p.get("text", "")
                block = re.search(r"<<<[0-9a-f]{8,64}\n(.*?)\n[0-9a-f]{8,64}>>>", body, re.S)
                if block:
                    body = block.group(1)
                passages.append((p.get("label", ""), p.get("title", ""), body))
        criteria: list[str] = []
        for _, _, body in passages:
            in_criteria = False
            for line in body.split("\n"):
                if re.match(r"^#{1,4}\s*acceptance criteria", line, re.I):
                    in_criteria = True
                    continue
                if in_criteria:
                    if line.startswith("#"):
                        break
                    s = re.sub(r"^[\s>*\-\d.)]+", "", line).strip()
                    if s:
                        criteria.append(s)
        if not criteria:
            criteria = ["The work shown matches what the ticket describes."]
        found = "Criteria:\n" + "\n".join(f"{i}. {c}" for i, c in enumerate(criteria, 1))
        # The evidence is the ticket's notes: the acceptance-criteria block is cut out, so a criterion is never its own evidence.
        ev_lines = []
        for lab, title, body in passages:
            notes = re.sub(r"#{1,4}\s*acceptance criteria.*?(?=\n#{1,4}\s|\Z)", "", body, flags=re.I | re.S)
            ev_lines.append(f"[{lab}] {title}: {' '.join(notes.split())[:200]}")
        found += "\n\nEvidence:\n" + ("\n".join(ev_lines) if ev_lines else "[none] (nothing was read)")
        return found

    def _role_reviewer(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import Criterion, ReviewOut

        gathered = self._find_block(user, "What the gatherer found")
        head = gathered.split("Evidence:", 1)[0]
        criteria_raw = [m.group(1).strip() for m in re.finditer(r"^\d+\.\s+(.*)$", head, re.M)]
        evidence_lines = [ln for ln in gathered.split("\n") if ln.startswith("[")]
        evidence_text = " ".join(evidence_lines)
        out_criteria: list[Criterion] = []
        for c in criteria_raw:
            ctok = set(tokens(c))
            shared = len(ctok & set(tokens(evidence_text)))
            status = "met" if ctok and shared >= max(2, int(len(ctok) * 0.5)) else "missing"
            labels = [ln[1 : ln.find("]")] for ln in evidence_lines if status == "met"]
            out_criteria.append(Criterion(text=c[:200], status=status, evidence=labels[:2], note="the notes show this" if status == "met" else "the notes do not show this"))
        missing = sum(1 for c in out_criteria if c.status != "met")
        recommendation = "approve" if out_criteria and not missing else "changes" if out_criteria else "unclear"
        return ReviewOut(
            criteria=out_criteria,
            recommendation=recommendation,
            summary=f"Checked {len(out_criteria)} criteria against the ticket's notes: {len(out_criteria) - missing} look met, {missing} do not."
            + (" Check those first." if missing else ""),
        )

    # ── Importer ──
    def _role_importer(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import ImportOut

        q = self._question(user)
        m = re.search(r'"([^"]+\.(?:pdf|png|jpe?g|webp|txt|md))"', q, re.I)
        name = m.group(1) if m else "the attached file"
        if "[fake:empty]" in q:
            return ImportOut(title=name.rsplit(".", 1)[0].replace("-", " ").title(), summary="The file could not be read as a document.", markdown="", labels=[])
        body = re.search(r"^(.*)$", user, re.M)
        return ImportOut(
            title=name.rsplit(".", 1)[0].replace("-", " ").title(),
            summary=f"Imported {name} from the file's contents (offline model).",
            markdown=f"# {name}\n\n(Read by the offline model; the same page read by Gemini keeps every printed figure.)\n\n{body.group(1)[:200] if body else ''}",
            labels=["import"],
        )

    # ── Chief of staff ──
    def _role_router(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import Route

        q = self._question(user)
        if re.search(r"\b(minutes|meeting|standup)\b", q, re.I):
            return Route(target="scribe", reason="meeting write-up")
        if re.search(r"\b(review|criteria|check)\b.*#?\d+|#\d+.*\b(review|criteria|check)\b", q, re.I):
            return Route(target="reviewer", reason="ticket check")
        if re.search(r"\bplan|roadmap|how should|what would it take|goal\b", q, re.I):
            return Route(target="planner", reason="goal to plan", question=q[:400])
        if "?" in q and len(q.split()) >= 3:
            return Route(target="librarian", reason="question about the records", question=q[:400])
        return Route(target="self", reason="studio question")

    # ── Planner Agent (the card writer) ──
    def _role_synthesizer(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import AskOptionOut, PlannerAgent, PlannerOut

        q = re.sub(r"\[fake:\w+\]", "", self._question(user)).strip()
        if len(tokens(q)) < 3:
            return PlannerOut(
                decision="ask",
                message="I need one detail before I can plan this.",
                ask_prompt="What kind of work is this?",
                ask_mode="choice",
                ask_options=[
                    AskOptionOut(id="feature", label="A new feature", hint="Something users will see"),
                    AskOptionOut(id="fix", label="A fix", hint="Something is broken"),
                    AskOptionOut(id="research", label="Research", hint="Find out before deciding"),
                ],
            )
        passages = parse_passages(self._find_block(user, "Prior-art passages"))
        titles = list(dict.fromkeys(p.title for _, p in passages))[:3]
        linked = re.search(r"#(\d+)", q)
        short = q[:80].rstrip(" .")
        return PlannerOut(
            decision="plan",
            message=f"Here is a plan for “{short}”. Check it and press Proceed when it looks right.",
            summary=f"Deliver “{short}” in small steps, starting from what the team already decided"
            + (f" ({'; '.join(titles)})." if titles else "."),
            steps=[
                "Write down the goal and what done looks like",
                "Read the prior art listed below and note the constraints",
                "Build the smallest slice that proves the idea",
                "Check the slice against the acceptance criteria",
                "Write it up in Docs and move the ticket to review",
            ],
            agents=[
                PlannerAgent(handle="librarian", why="Finds the earlier decisions this work must respect.", effort="low"),
                PlannerAgent(handle="reviewer", why="Checks the result against the criteria before review.", effort="medium"),
            ],
            ticket_link=linked.group(1) if linked else "",
            ticket_title="" if linked else short[:80],
            ticket_body="" if linked else f"Goal: {q[:300]}",
            risks=["The scope grows while building; keep to the smallest slice.", "A constraint in the prior art is missed."],
            sources=[lab for lab, _ in passages[:2]],
        )

    # ── Delivery pipeline: spec, design, implement, tests, release ──
    def _role_spec_writer(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import SpecOut

        q = re.sub(r"\[fake:\w+\]", "", self._question(user)).strip()
        short = q[:80].rstrip(" .") or "the ticket"
        return SpecOut(
            message=f"Here is the spec for “{short}”. Read the criteria and accept it if they are right.",
            title=f"Spec: {short[:80]}",
            story=f"As a wholesale customer I want “{short}”, so that the portal shows me what I need without a call.",
            criteria=[
                "The portal shows the new information for the orders it applies to",
                "An order without the information shows a clear, empty state",
                "The existing list, search and detail views still work",
            ],
            estimate="Medium: one screen and its data path; the uncertain part is the empty state.",
            risks=["The data behind it may be incomplete for older orders.", "The change touches a screen the team uses daily."],
            definition_of_done=["The acceptance criteria pass in the portal", "The unit and end-to-end tests are green", "A person has looked at it"],
        )

    def _role_constraints(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        return (
            "- The ticket touches the order list and its detail view.\n"
            "- Keep the existing layout, labels and spacing; add the smallest control that satisfies the criteria.\n"
            "- The portal is light-only and has no icons beyond text labels."
        )

    def _role_designer(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import DesignOut

        q = re.sub(r"\[fake:\w+\]", "", self._question(user)).strip()
        short = q[:80].rstrip(" .") or "the order list"
        prototype = (
            '<main style="font-family:system-ui,sans-serif">'
            '<h1 style="font-size:20px;margin:0 0 12px">Orders</h1>'
            '<label style="display:block;margin:0 0 12px">Filter by status'
            '<select style="display:block;margin-top:4px;padding:6px"><option>All statuses</option><option>Shipped</option></select></label>'
            '<table style="border-collapse:collapse;width:100%"><thead><tr>'
            '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">Order</th>'
            '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">Customer</th>'
            '<th style="text-align:left;border-bottom:1px solid #ddd;padding:6px">Status</th></tr></thead><tbody>'
            '<tr><td style="padding:6px">o-1001</td><td style="padding:6px">Harbour Outfitters</td><td style="padding:6px">Shipped</td></tr>'
            '<tr><td style="padding:6px">o-1003</td><td style="padding:6px">Brecon Bikes</td><td style="padding:6px">Processing</td></tr>'
            "</tbody></table></main>"
        )
        return DesignOut(
            message=f"Here is a design for “{short}”. The prototype is the main screen; the flow and the checks are below it.",
            title=f"Design: {short[:80]}",
            flow=["Orders list with the new control", "Order detail unchanged", "Empty state when nothing matches"],
            prototype_html=prototype,
            tokens=["--surface: #ffffff", "--ink: #1f2a2a", "--line: #e5e1d8", "radius: 10px", "spacing: 8 / 12 / 16 px"],
            a11y=["The filter has a visible label", "The select keeps a visible focus ring", "Status is written as text, never colour alone"],
        )

    def _role_repo_reader(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        if not responded:
            return [("list_repo", {}), ("read_repo_file", {"path": "sample-app/src/api/orders.ts"})]
        paths = [str(f.get("path")) for r in responses for f in (r.get("files") or [])]
        read = [str(r.get("path")) for r in responses if r.get("path")]
        return (
            "- The change adds a new helper beside the order data and its unit test.\n"
            f"- Files on main: {', '.join(paths[:6]) or '(none read)'}\n"
            f"- Read in full: {', '.join(read) or '(none)'}\n"
            "- New files need no baseSha; nothing on main is edited."
        )

    @staticmethod
    def _stock_change_set() -> Any:
        from ..schemas import ChangeSetOut, DraftFile

        return ChangeSetOut(
            message="Here is the change set: a stock helper with its unit test.",
            title="Show what is in stock",
            body="Adds a small stock lookup beside the order data, with unit tests. Only new files: nothing on main changes.",
            files=[
                DraftFile(path="sample-app/src/api/stock.ts", op="write", lines=STOCK_SRC.rstrip("\n").split("\n")),
                DraftFile(path="sample-app/tests/stock.test.ts", op="write", lines=STOCK_TEST.rstrip("\n").split("\n")),
            ],
        )

    def _role_drafter(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        return self._stock_change_set()

    def _role_repairer(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        # The fake's draft is always valid, so the repair step repeats it; the problems list decides for a real model.
        return self._stock_change_set()

    @staticmethod
    def _ticket_id(user: str) -> str:
        m = re.search(r"\(id: ([A-Za-z0-9_.:-]+)\)", user)
        return m.group(1) if m else ""

    def _role_test_reader(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        if not responded:
            return [("list_jobs", {"ticket": self._ticket_id(user)})]
        states = [f"{j.get('kind')}={j.get('state')}" for r in responses for j in (r.get("jobs") or [])]
        return "- Jobs read: " + (", ".join(states) or "(none)") + "\n- Every number in the report must come from these jobs."

    def _role_qa(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import TestReportOut

        jobs_text = self._find_block(user, "The jobs that ran")
        coverage = re.search(r"coveragePct=([\d.]+)", jobs_text)
        passed = sum(int(m.group(1)) for m in re.finditer(r"passed=(\d+)", jobs_text))
        failed = sum(int(m.group(1)) for m in re.finditer(r"failed=(\d+)", jobs_text))
        return TestReportOut(
            message="Here is the test report, built only from the jobs that ran.",
            title="Test report",
            summary=f"The jobs on this change set are listed below: {passed} checks passed and {failed} failed. Read the failing job's log before changing anything.",
            passed=passed,
            failed=failed,
            coverage_pct=float(coverage.group(1)) if coverage else 0,
            regression=["The order list reads the same data module the new helper sits beside.", "The end-to-end list flow touches the same screen."],
        )

    def _role_release_reader(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        if not responded:
            ticket = self._ticket_id(user)
            return [("list_jobs", {"ticket": ticket}), ("list_rollouts", {"ticket": ticket})]
        states = [f"{j.get('kind')}={j.get('state')}" for r in responses for j in (r.get("jobs") or [])]
        return "- Jobs read: " + (", ".join(states) or "(none)") + "\n- Rollouts were read too when there were any."

    def _role_release_writer(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import ReleaseOut, ScoreLine

        jobs_text = self._find_block(user, "The jobs that ran")
        coverage = re.search(r"coveragePct=([\d.]+)", jobs_text)
        scan = re.search(r"scanSeverity=(\w+)", jobs_text)
        tests_ok = "unit=passed" in jobs_text.replace(": ", "=") and "e2e=passed" in jobs_text.replace(": ", "=")
        scorecard = [
            ScoreLine(name="tests", ok=tests_ok, detail="unit and end-to-end jobs on this change set"),
            ScoreLine(name="coverage", ok=bool(coverage) and float(coverage.group(1)) >= 70, detail=f"{coverage.group(1)}% lines" if coverage else "no coverage reported"),
            ScoreLine(name="scan", ok=bool(scan) and scan.group(1).upper() in ("NONE", "LOW", "MEDIUM"), detail=scan.group(1).lower() if scan else "no scan yet"),
            ScoreLine(name="changes", ok=True, detail="the accepted change set is the input"),
            ScoreLine(name="rollback", ok=False, detail="no rollout yet; the gate decides after the canary"),
        ]
        return ReleaseOut(
            message="Here is the release pack. The scorecard lists what the facts say; the gate reads them itself.",
            title="Release pack",
            notes=["A small helper beside the order data, with unit tests.", "No screen changes, so the portal looks the same."],
            risk="low: the change adds new files and touches no existing behaviour.",
            scorecard=scorecard,
        )

    def _role_rollout_writer(self, system: str, user: str, responded: bool, responses: list[dict]) -> Any:
        from ..schemas import RolloutOut

        lines = [ln.strip() for ln in self._find_block(user, "The rollouts of this ticket").split("\n") if ln.strip().startswith("step ")]
        steps = [f"{ln.split(':')[0].strip()}: {ln.split(':', 1)[1].strip()}" for ln in lines]
        outcome = "complete" if any("state=complete" in ln for ln in self._find_block(user, "The rollouts of this ticket").split("\n")) else "in progress"
        return RolloutOut(
            message="Here is the rollout report, written from the checks the pipeline measured.",
            title="Rollout report",
            summary="The pipeline sent real requests at each traffic step and counted what each revision answered; the numbers are below.",
            steps=steps,
            outcome=f"{outcome}: the checks at each step were the judge.",
        )
