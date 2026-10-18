"""The slides of the cup's submission template, in the template's order, with this project's content.

The knowledge numbers on the performance slide come from `eval-summary.json` (a real run of `agent-service/eval`); the pipeline numbers come
from `pipeline-run.json` (timings recorded while a script drove one ticket through the live site).
"""
from __future__ import annotations

from engine import *  # noqa: F401,F403

LIVE_URL = "https://studio-web-x6ud7nrylq-as.a.run.app"
REPO_URL = "https://github.com/nuckydotid/ai-native-office"
TEAM_MEMBERS = [
    ("Nucky Ridwan Gunawan", "Principal Software Engineer"),
    ("Hamza Arif", "AI Engineer"),
    ("Nithin Chandrakantha Reddy", "UX Researcher"),
]


def content(title: str, source: str) -> Slide:
    return Slide("content", source, title, [title_box(title)])


def pill(x, y, w, h, text, fill, color=INK, size=9, bold=False, line=None, radius=None):
    return Box(x, y, w, h, [P(text, size=size, color=color, bold=bold, align="ctr", after=0)], fill=fill, line=line, radius=radius if radius is not None else h / 2, anchor="ctr", pad=(0.04, 0.0, 0.04, 0.0), name="Pill")


def build(team: str, leader: str, video_url: str | None, m: dict) -> list[Slide]:
    metrics = m["metrics"]
    passed, total = metrics["cases_passed"], metrics["cases_planned"]
    slides: list[Slide] = []

    # ───────────── 1. Team details (the template's cover) ─────────────
    s = Slide("cover", "slide1.xml")
    s.add(
        Text(
            0.16, 3.0, 9.58, 2.5,
            P("Team Details", size=21, font=SEMI_FONT, after=0),
            P("", size=8, after=0),
            P(f"Team name: {team}", size=18, num=True, after=0),
            P(f"Team leader name: {leader}", size=18, num=True, after=0),
            P("Problem Statement: Future of Work & Enterprise Productivity", size=18, num=True, after=0),
            P("", size=8, after=0),
            P("Team composition", size=12, bold=True, left=0.625, after=2),
            *[P(f"{i}.  {name}{' (Leader)' if i == 1 else ''}, {role}", size=12, left=0.625, after=1) for i, (name, role) in enumerate(TEAM_MEMBERS, 1)],
            pad=(0.1, 0.08, 0.1, 0.05),
            name="Team details",
        )
    )
    slides.append(s)

    pr = m.get("pipeline", {})

    # ───────────── 2. Brief about the idea ─────────────
    s = content("Brief about the idea", "slide3.xml")
    s.add(
        Text(0.3, 1.3, 5.3, 1.2,
             P("Worktrees Studio: an AI-native delivery service for web teams", size=14, font=MEDIUM_FONT, after=4),
             P("Ten AI colleagues work next to people in a virtual office and carry a web change from an idea to production: they plan, design, write code and tests, prepare the release and narrate the rollout. People approve every gate.", size=11, after=0)),
        Card(0.3, 2.62, 5.3, 0.72, P("**Know.** Ask in the office and get an answer with its sources, or an honest “that is not written down”.", size=10.5, after=0), fill=BLUE_T, anchor="ctr"),
        Card(0.3, 3.42, 5.3, 0.72, P("**Decide.** End a meeting: minutes, decisions and proposed tickets, accepted by a person.", size=10.5, after=0), fill=GREEN_T, anchor="ctr"),
        Card(0.3, 4.22, 5.3, 0.72, P("**Ship.** Plan, Design, Build, Test, Release, Deploy: real builds, real tests, a real canary on Google Cloud.", size=10.5, after=0), fill=PURPLE_T, anchor="ctr"),
        Pic(5.85, 1.4, 3.85, 2.406, "stage-spec.png", "The Plan stage in the live demo: the ticket panel with the Planner Agent's spec and its acceptance criteria, the pixel office in the middle and the room chat on the right."),
        Text(5.85, 3.84, 3.85, 0.42, P("A spec drafted by the Planner Agent, waiting for a person to accept it.", size=9, color=MUTED, after=0), pad=(0.0, 0.03, 0.0, 0.0)),
    )
    stats = [("10", "AI colleagues"), ("6", "stages, each with a gate"), ("Real", "Cloud Build and Cloud Run")]
    for i, (big, small) in enumerate(stats):
        s.add(Card(5.85 + i * 1.3, 4.35, 1.25, 0.82, P(big, size=13, bold=True, color=BLUE, align="ctr", after=0), P(small, size=9, color=MUTED, align="ctr", after=0), fill=WHITE, line=LINE, anchor="ctr", pad=(0.04, 0.04, 0.04, 0.04)))
    slides.append(s)

    # ───────────── 3. Opportunities ─────────────
    s = content("Opportunities", "slide4.xml")
    cols = [
        ("How different is it from any of the other existing ideas?", BLUE_T, [
            "**Coding copilots** write code in an editor. Ours carries the whole change: spec, design, code, tests, release, rollout, with a gate between each.",
            "**CI/CD tools** run what a person already wrote. Ours has colleagues that draft the work and people who approve it.",
            "**Chat assistants** answer without sources. Ours cites the doc or ticket, checks every claim and refuses when nothing supports it.",
            "**Not a bot in a window:** the colleagues walk the office and show what they are doing.",
        ]),
        ("How will it be able to solve the problem?", GREEN_T, [
            "**Hand-offs shrink:** the same ticket carries its spec, design, code, test results and release notes from stage to stage.",
            "**Agents propose, people decide:** every artifact waits for a person; an approval is tied to the exact content (its digest).",
            "**Real checks, not opinions:** builds, unit and end-to-end tests, a vulnerability scan and a measured canary decide whether a change moves on.",
            "**Knowledge stays close:** the same colleagues answer from the team’s docs, tickets and meetings.",
        ]),
        ("USP of the proposed solution", PURPLE_T, [
            "**Safe to run AI-written code:** tests run with the network off, files are limited to three folders, a scan blocks forbidden calls, designs show only in a sandboxed frame.",
            "**Thresholds, not a model, judge a rollout:** a bad candidate rolls itself back; the AI only writes it up.",
            "**It says no, for real:** an agent’s change broke an existing end-to-end test and the gate stayed red; our first release was refused for critical flaws in the base image.",
            "**Built on Google Cloud end to end:** service identities, no API keys, jobs that cost nothing when idle.",
        ]),
    ]
    for i, (head, fill, items) in enumerate(cols):
        paras = [P(head, size=12, bold=True, after=7)] + [P(t, size=10, bullet=True, after=5) for t in items]
        s.add(Card(0.3 + i * 3.2, 1.32, 3.0, 4.05, *paras, fill=fill, pad=(0.14, 0.12, 0.12, 0.08)))
    slides.append(s)

    # ───────────── 4. Features ─────────────
    s = content("List of features offered by the solution", "slide5.xml")
    feats = [
        ("1  Plan", "The Planner Agent drafts a spec: story, acceptance criteria, estimate, risks.", BLUE_T),
        ("2  Design", "The Designer Agent draws a prototype, shown in a sandboxed frame.", GREEN_T),
        ("3  Build", "The Developer Agent writes a change set. You read it as a diff, then run the real build.", AMBER_T),
        ("4  Test", "Unit tests with coverage and Playwright run with the network off. QA adds tests.", PURPLE_T),
        ("5  Release", "The Release Agent writes the pack. An image is built and scanned for vulnerabilities.", BLUE_T),
        ("6  Deploy", "Staging, then production at 10, 50 and 100 percent, with checks and automatic rollback.", GREEN_T),
        ("7  Tools", "Thresholds you can edit, budgets, an audit trail, and honest integration status.", AMBER_T),
        ("8  Office and knowledge", "Cited answers, minutes and proposed tickets from meetings, and the pixel office.", PURPLE_T),
    ]
    for i, (head, body, fill) in enumerate(feats):
        r, c = divmod(i, 4)
        s.add(Card(0.3 + c * 2.4, 1.35 + r * 1.78, 2.2, 1.62, P(head, size=12, bold=True, after=5), P(body, size=10, after=0), fill=fill))
    s.add(Text(0.3, 4.95, 9.4, 0.42, P("**Also:** gates that read the same rules the server enforces, a per-environment lock, per-guest and daily budgets with a kill switch, guest access with no sign-in, and a nightly reset of the demo and of Google’s side.", size=9.5, color=MUTED, after=0), pad=(0.0, 0.04, 0.0, 0.0)))
    slides.append(s)

    # ───────────── 5. Process flow / use cases ─────────────
    s = content("Process flow diagram or Use-case diagram", "slide6.xml")
    stages = [
        ("Plan", "Planner Agent", "spec", "spec accepted"),
        ("Design", "Designer Agent", "design", "design accepted"),
        ("Build", "Developer Agent", "change set", "build passes"),
        ("Test", "QA Agent", "test report", "tests and coverage"),
        ("Release", "Release Agent", "release pack", "scan and approval"),
        ("Deploy", "Release Agent", "rollout report", "100% and healthy"),
    ]
    bw, gap, y0, bh = 1.42, 0.176, 1.42, 1.18
    for i, (name, who, art, gate) in enumerate(stages):
        x = 0.3 + i * (bw + gap)
        s.add(Card(x, y0, bw, bh, P(f"{i + 1}  {name}", size=11.5, bold=True, after=2), P(who, size=9.5, color=MUTED, after=2), P(f"makes: {art}", size=9.5, after=0), fill=BLUE_T if i in (0, 5) else CARD, line=BLUE if i in (0, 5) else LINE, pad=(0.1, 0.08, 0.06, 0.04)))
        s.add(Text(x, y0 + bh + 0.04, bw, 0.3, P(f"gate: {gate}", size=9, color=BLUE, align="ctr", after=0), anchor="t", pad=(0, 0.01, 0, 0)))
        if i < 5:
            s.add(Line(x + bw + 0.01, y0 + bh / 2, x + bw + gap - 0.01, y0 + bh / 2, color=MUTED, width=1.5))
    s.add(Text(0.3, y0 + bh + 0.36, 9.4, 0.3, P("A person presses Approve & advance only when the gate’s checklist is green. Any ticket can be sent back to an earlier stage.", size=9.5, color=MUTED, align="ctr", after=0)))
    lanes = [
        ("Agents propose", BLUE_T, ["Ask a colleague in a stage, or @mention one in the chat", "It reads the repo, the spec and the job logs with read-only tools", "It returns an artifact, never an action", "The web service checks it again before keeping it"]),
        ("People decide", GREEN_T, ["Accept or reject a draft: the approval is tied to its digest", "Press Run: a build costs real minutes, so a person starts it", "Approve & advance when the gate is green", "Owners start the rollout and can roll back"]),
        ("The pipeline proves", PURPLE_T, ["Cloud Build runs the tests with the network off", "Artifact Analysis scans the release image", "Cloud Run takes traffic in steps, measured per revision", "Thresholds, not a model, decide; failure rolls back"]),
    ]
    for i, (head, fill, items) in enumerate(lanes):
        paras = [P(head, size=12, bold=True, after=5)] + [P(f"{n}  {t}", size=10, after=3) for n, t in enumerate(items, 1)]
        s.add(Card(0.3 + i * 3.2, 3.5, 3.0, 1.87, *paras, fill=fill))
    slides.append(s)

    # ───────────── 6. Wireframes ─────────────
    s = content("Wireframes/Mock diagrams of the proposed solution (optional)", "slide7.xml")
    s.add(Box(0.35, 1.3, 9.3, 3.72, fill=WHITE, line="9AA0A6", line_w=1.0, radius=0.1, name="Window"))
    s.add(Text(0.5, 1.33, 2.5, 0.28, P("Worktrees Studio", size=9.5, bold=True, after=0), anchor="ctr"))
    s.add(pill(3.5, 1.36, 3.6, 0.22, "Demo workspace: synthetic data, resets nightly, 20 AI runs left", BLUE_T, color=BLUE, size=9))
    cy, ch = 1.7, 3.25
    s.add(Box(0.45, cy, 1.1, ch, fill=WHITE, line=LINE, radius=0.06, name="Sidebar"))
    for i, (t, sel) in enumerate([("Plan", False), ("Design", False), ("Build", True), ("Test", False), ("Release", False), ("Deploy", False), ("Tools", False)]):
        s.add(Box(0.5, cy + 0.07 + i * 0.44, 1.0, 0.38, [P(t, size=9.5, bold=sel, color=BLUE if sel else INK, after=0)], fill=BLUE_T if sel else None, radius=0.06, anchor="ctr", pad=(0.08, 0, 0.04, 0), name="Sidebar item"))
    s.add(Box(1.65, cy, 2.55, ch, fill=WHITE, line=LINE, radius=0.06, name="Stage panel"))
    s.add(Text(1.72, cy + 0.03, 2.4, 0.26, P("#17 Add a status filter", size=9.5, bold=True, after=0), anchor="ctr"))
    for i, (t, on) in enumerate([("Plan", False), ("Design", False), ("Build", True), ("Test", False)]):
        s.add(pill(1.74 + i * 0.6, cy + 0.32, 0.56, 0.19, t, BLUE if on else BLUE_T, color=WHITE if on else BLUE, size=8.5))
    s.add(pill(1.74, cy + 0.58, 1.55, 0.22, "Draft the change set", PURPLE_T, color=PURPLE, size=9))
    s.add(Card(1.74, cy + 0.88, 2.37, 1.0, P("Change set v1   Waiting for you", size=9, bold=True, after=2), P("OrderList.tsx   +6 −2", size=9, color=MUTED, after=2), P("+ aria-live count of matches", size=9, color=GREEN, after=2), fill=CARD, radius=0.07, pad=(0.08, 0.05, 0.06, 0.04)))
    s.add(pill(2.5, cy + 1.62, 0.7, 0.2, "Reject", WHITE, size=9, line=LINE))
    s.add(pill(3.3, cy + 1.62, 0.7, 0.2, "Accept", BLUE, color=WHITE, size=9, bold=True))
    s.add(Card(1.74, cy + 1.98, 2.37, 1.2, P("To leave Build", size=9, bold=True, after=3), P("✓  A change set is accepted", size=9, after=2), P("✓  The build passes", size=9, after=3), fill=WHITE, line=LINE, radius=0.07, pad=(0.08, 0.05, 0.06, 0.04)))
    s.add(pill(1.84, cy + 2.8, 1.7, 0.24, "Approve & advance to Test", BLUE, color=WHITE, size=9, bold=True))
    s.add(Box(4.3, cy, 2.65, ch, fill="EFE6D6", line=LINE, radius=0.06, name="Office"))
    s.add(Box(4.55, cy + 0.25, 1.0, 0.65, fill="C9D6EE", radius=0.04, name="Rug"))
    s.add(Box(5.85, cy + 0.2, 0.85, 0.36, fill="B8706A", radius=0.05, name="Sofa"))
    for name, px, py, w in [("Developer Agent", 4.4, 2.85, 1.25), ("Designer Agent", 5.7, 2.85, 1.2), ("Planner Agent", 4.4, 3.3, 1.2), ("Release Agent", 5.7, 3.3, 1.2), ("Guest", 5.2, 2.2, 0.8)]:
        s.add(pill(px, py, w, 0.2, name, WHITE, size=9, line=LINE))
        s.add(Box(px + w / 2 - 0.06, py + 0.22, 0.12, 0.22, fill=BLUE if name == "Guest" else PURPLE, radius=0.05, name="Person"))
    s.add(Text(4.35, cy + ch - 0.32, 2.55, 0.26, P("Colleagues walk to the room they work in", size=9, color=MUTED, after=0), anchor="ctr"))
    s.add(Box(7.05, cy, 2.5, ch, fill=WHITE, line=LINE, radius=0.06, name="Chat"))
    s.add(Text(7.12, cy + 0.04, 1.6, 0.26, P("Lobby", size=10, bold=True, after=0), anchor="ctr"))
    s.add(Card(7.14, cy + 0.34, 2.3, 0.78, P("Add a status filter to the orders list.", size=9, after=2), P("1 file: OrderList.tsx", size=9, color=MUTED, after=0), fill=PURPLE_T, radius=0.08, pad=(0.08, 0.05, 0.06, 0.04)))
    s.add(Card(7.14, cy + 1.22, 2.3, 1.3, P("Proposal: review the change set", size=9, bold=True, after=3), P("change set v1: Add status filter", size=9, left=0.2, after=4), fill=WHITE, line=PURPLE, radius=0.08, pad=(0.08, 0.06, 0.06, 0.04)))
    s.add(Box(7.24, cy + 1.5, 0.1, 0.1, fill=BLUE, line=BLUE, radius=0.02, name="Checkbox"))
    s.add(pill(7.24, cy + 2.15, 1.0, 0.22, "Accept 1 item", BLUE, color=WHITE, size=9, bold=True))
    s.add(pill(8.3, cy + 2.15, 0.7, 0.22, "Dismiss", CARD, size=9))
    for n, (nx, ny) in enumerate([(0.38, cy - 0.12), (1.58, cy - 0.12), (4.23, cy - 0.12), (6.98, cy - 0.12)], 1):
        s.add(Box(nx, ny, 0.24, 0.24, [P(str(n), size=9, bold=True, color=WHITE, align="ctr", after=0)], fill=BLUE, radius=0.12, anchor="ctr", pad=(0, 0, 0, 0), name="Callout"))
    s.add(Text(0.3, 5.04, 9.4, 0.36, P("**1** The pipeline is the sidebar · **2** One panel per stage: ask, decide, run, gate · **3** The office, with colleagues as characters · **4** Chat: answers and proposals", size=9.5, color=MUTED, after=0), pad=(0.0, 0.04, 0.0, 0.0)))
    slides.append(s)

    # ───────────── 7. Architecture ─────────────
    s = content("Architecture diagram of the proposed solution", "slide8.xml")
    s.add(pill(2.15, 1.3, 2.6, 0.34, "Browser: React app, guest token", CARD, size=9.5, line=LINE, radius=0.08))
    s.add(Box(0.3, 1.8, 6.25, 2.0, fill="F8F9FA", line="9AA0A6", radius=0.1, name="Cloud Run"))
    s.add(Text(0.38, 1.81, 3.4, 0.24, P("Google Cloud Run, asia-southeast1", size=9, bold=True, color=MUTED, after=0), anchor="ctr"))
    s.add(Card(0.5, 2.1, 1.8, 1.55, P("studio-pipeline", size=10.5, bold=True, after=1), P("private, Bun + TypeScript", size=9, color=MUTED, after=3), P("jobs, rollouts, budgets, locks, kill switch, under its own identity", size=9.5, after=0), fill=AMBER_T, line=AMBER, radius=0.08))
    s.add(Card(2.55, 2.1, 1.8, 1.55, P("studio-web", size=10.5, bold=True, after=1), P("public, one warm instance", size=9, color=MUTED, after=3), P("Bun: office, board, artifacts, gates, audit, guest sign-in", size=9.5, after=0), fill=BLUE_T, line=BLUE, radius=0.08))
    s.add(Card(4.6, 2.1, 1.8, 1.55, P("studio-agents", size=10.5, bold=True, after=1), P("private, scales to zero", size=9, color=MUTED, after=3), P("Python, ADK 2.x: ten colleagues, read-only tools", size=9.5, after=0), fill=PURPLE_T, line=PURPLE, radius=0.08))
    s.add(Line(3.45, 1.64, 3.45, 2.1, color=BLUE, width=1.5))
    s.add(Line(2.55, 2.5, 2.3, 2.5, color=AMBER, width=1.5))
    s.add(Line(4.35, 2.5, 4.6, 2.5, color=PURPLE, width=1.5))
    s.add(Line(4.6, 3.2, 4.35, 3.2, color=PURPLE, width=1.5, dash=True))
    s.add(Card(6.75, 1.3, 2.95, 1.0, P("Gemini", size=10.5, bold=True, after=1), P("on the Agent Platform", size=9, color=MUTED, after=3), P("3.8 Flash writes, 3.5 Flash-Lite routes, 3.1 Pro drafts code; embeddings 768-d", size=9, after=0), fill=GREEN_T, line=GREEN, radius=0.08))
    s.add(Card(6.75, 2.4, 2.95, 0.7, P("Firestore", size=10.5, bold=True, after=2), P("knowledge vectors; pipeline state (named database)", size=9, after=0), fill=AMBER_T, line=AMBER, radius=0.08))
    s.add(Card(6.75, 3.2, 2.95, 0.6, P("Secret Manager · Cloud Scheduler", size=9.5, bold=True, after=1), P("guest key, nightly reset", size=9, color=MUTED, after=0), fill=WHITE, line=LINE, radius=0.08))
    s.add(Line(6.4, 2.45, 6.75, 1.8, color=GREEN, width=1.5))
    s.add(Line(6.4, 2.8, 6.75, 2.75, color=AMBER, width=1.5))
    strip = [
        ("Cloud Build", "builds and tests, network off"),
        ("Cloud Storage", "job sources, reports, trunk"),
        ("Artifact Registry + Analysis", "release images, vulnerability scan"),
        ("Pub/Sub + Billing budget", "build events, kill switch at 80%"),
        ("Sample app on Cloud Run", "staging, then production 10/50/100"),
    ]
    for i, (a, b) in enumerate(strip):
        s.add(Card(0.3 + i * 1.9, 4.05, 1.8, 0.78, P(a, size=9.5, bold=True, after=1), P(b, size=9, color=MUTED, after=0), fill=WHITE, line=LINE, radius=0.07, pad=(0.08, 0.05, 0.05, 0.04)))
    s.add(Line(1.4, 3.65, 1.4, 4.05, color=AMBER, width=1.25, dash=True))
    s.add(Line(1.4, 3.85, 9.1, 3.85, arrow=False, color=AMBER, width=1.25, dash=True))
    for i in (1, 2, 3, 4):
        s.add(Line(0.3 + i * 1.9 + 0.9, 3.85, 0.3 + i * 1.9 + 0.9, 4.05, color=AMBER, width=1.25, dash=True))
    s.add(Text(0.3, 4.88, 9.4, 0.5, P("Only studio-pipeline can build or deploy, with the least rights it needs. Service to service: Google-signed ID tokens, audience pinned. Agents only read, through /internal/v1. No API key anywhere.", size=9, color=MUTED, align="ctr", after=0)))
    slides.append(s)

    # ───────────── 8. Technologies ─────────────
    s = content("Technologies to be used in the solution", "slide9.xml")
    gc = [
        ("Gemini on the Gemini Enterprise Agent Platform", "writing, tools, code, judging, embeddings"),
        ("Agent Development Kit (ADK) 2.x", "graph workflows with structured output and tools"),
        ("Cloud Run: three services and the sample app", "web, agents, pipeline; staging and production revisions"),
        ("Cloud Build, Cloud Storage, Artifact Registry", "hermetic builds and tests, sources, release images"),
        ("Artifact Analysis (Container Analysis)", "vulnerability scan that gates the release"),
        ("Firestore, Pub/Sub, Billing budgets", "vector search and state; build events; kill switch"),
        ("Secret Manager, IAM, ID tokens, Cloud Scheduler", "service identities, no keys, nightly reset"),
        ("Cloud Trace and Cloud Logging", "ADK OpenTelemetry traces, job logs"),
    ]
    app = [
        ("React 19, HeroUI, Tailwind, Vite, PixiJS", "every screen and the pixel office"),
        ("Bun, Hono, WebSocket; TypeScript throughout", "web and pipeline services, one shared contract"),
        ("Python, FastAPI, server-sent events", "agent service"),
        ("Vitest, Playwright, node:test, bun:test, pytest", "322 app, 205 web-service, 42 agent and 10 pipeline-service tests"),
        ("Deny-scan, path allowlist, sandboxed iframe", "AI-written code and pages are untrusted"),
    ]
    for x, head, fill, items in [(0.3, "Google Cloud", BLUE_T, gc), (5.1, "Application", GREEN_T, app)]:
        paras = [P(head, size=13, bold=True, after=6)] + [P(f"**{a}** · {b}", size=10, bullet=True, after=4) for a, b in items]
        s.add(Card(x, 1.32, 4.6, 4.05, *paras, fill=fill, pad=(0.16, 0.12, 0.14, 0.08)))
    slides.append(s)

    # ───────────── 9. Estimated implementation cost ─────────────
    s = content("Estimated implementation cost (optional)", "slide10.xml")
    s.add(Card(0.3, 1.32, 5.75, 4.05, fill=CARD))
    s.add(Text(0.45, 1.38, 5.4, 0.5, P("Roughly US$0.10 to 0.30 per ticket, start to finish", size=16, bold=True, color=BLUE, after=0), anchor="ctr"))
    rows = [
        ("One agent run (about 19,000 tokens, measured)", "US$0.01 to 0.02"),
        ("A ticket: about six agent runs", "US$0.06 to 0.12"),
        ("Cloud Build, about 12 minutes of builds per ticket (measured)", "a few cents"),
        ("Demo ceiling: 30 jobs a day, 15 rollouts, 6 scans", "capped in code"),
        ("Idle: one warm web instance; pipeline and agents at zero", "US$10 to 15 a month"),
        ("Firestore, Storage, Registry, Pub/Sub, Scheduler at demo volume", "under US$3 a month"),
    ]
    for i, (a, b) in enumerate(rows):
        y = 1.95 + i * 0.56
        s.add(Line(0.45, y, 5.9, y, arrow=False, color=LINE, width=0.75))
        s.add(Text(0.45, y + 0.02, 3.55, 0.52, P(a, size=9.5, after=0), anchor="ctr", pad=(0.0, 0.0, 0.05, 0.0)))
        s.add(Text(4.0, y + 0.02, 1.9, 0.52, P(b, size=9.5, bold=True, align="r", after=0), anchor="ctr", pad=(0.05, 0.0, 0.0, 0.0)))
    s.add(Card(6.25, 1.32, 3.45, 4.05,
               P("How it was estimated", size=12, bold=True, after=6),
               P("Gemini 3.8 Flash list price: US$0.75 per million input and US$3.75 per million output tokens (launch pricing); about 94% of tokens are input.", size=10, bullet=True, after=5),
               P("Build minutes are the ones this deck’s own run used. The price per minute depends on the machine type: check current prices.", size=10, bullet=True, after=5),
               P("Cost is bounded by design: a daily budget of AI runs and jobs, two jobs at once, a ten-minute timeout, and a billing alert that flips a kill switch at 80%.", size=10, bullet=True, after=5),
               P("These are estimates, not invoices.", size=10, bullet=True, after=0),
               fill=AMBER_T, pad=(0.15, 0.12, 0.12, 0.08)))
    slides.append(s)

    # ───────────── 10-11. Snapshots (two slides) ─────────────
    s = content("Snapshots of the prototype", "slide11.xml")
    s.add(
        Pic(0.3, 1.4, 5.55, 3.469, "stage-design.png", "The Design stage: the Designer Agent's prototype of the status filter in a sandboxed frame, with the Plan Room chat showing the proposal card."),
        Text(0.3, 4.9, 5.55, 0.5, P("**Design.** The prototype is the Designer Agent’s own page, shown in a sandboxed frame with no scripts and no network.", size=9, color=MUTED, after=0), pad=(0.0, 0.03, 0.0, 0.0)),
        Pic(6.05, 1.4, 1.68, 3.77, "panel-spec.png", "The spec the Planner Agent drafted for the ticket: a story and five acceptance criteria."),
        Pic(7.97, 1.4, 1.68, 3.77, "panel-diff.png", "The Developer Agent's change set for the ticket, shown as a diff of OrderList.tsx against main."),
        Text(6.05, 5.15, 1.68, 0.3, P("Spec to accept", size=9, color=MUTED, align="ctr", after=0), pad=(0, 0.02, 0, 0)),
        Text(7.97, 5.15, 1.68, 0.3, P("Change set as a diff", size=9, color=MUTED, align="ctr", after=0), pad=(0, 0.02, 0, 0)),
    )
    slides.append(s)

    s = content("Snapshots of the prototype", "slide11.xml")
    s.add(
        Pic(0.3, 1.4, 5.55, 3.469, "stage-regression.png", "The Test stage after a real run: unit tests passed with 100 percent coverage, the end-to-end test failed, and the gate stays red with Approve and advance disabled."),
        Text(0.3, 4.9, 5.55, 0.5, P("**Test.** A real run of the Developer Agent’s change: the end-to-end test failed, so the ticket cannot move on until it is fixed.", size=9, color=MUTED, after=0), pad=(0.0, 0.03, 0.0, 0.0)),
        Pic(6.05, 1.4, 1.68, 3.77, "panel-blocked.png", "The Release gate: the scan found critical issues, so Approve & advance stays disabled."),
        Pic(7.97, 1.4, 1.68, 3.77, "panel-tests.png", "The Test stage: unit tests passed with coverage and end-to-end tests passed."),
        Text(6.05, 5.15, 1.68, 0.3, P("A release the gate refused", size=9, color=MUTED, align="ctr", after=0), pad=(0, 0.02, 0, 0)),
        Text(7.97, 5.15, 1.68, 0.3, P("Tests passing, with coverage", size=9, color=MUTED, align="ctr", after=0), pad=(0, 0.02, 0, 0)),
    )
    slides.append(s)

    # ───────────── 12. Performance ─────────────
    s = content("Prototype Performance report/Benchmarking", "slide12.xml")
    rows = [tuple(r) for r in pr.get("rows", [])]
    s.add(Card(0.3, 1.32, 4.75, 4.05, P("One ticket, start to finish, on the live site", size=10.5, bold=True, after=0), fill=CARD))
    for i, (a, b) in enumerate(rows):
        y = 1.72 + i * 0.35
        s.add(Text(0.42, y, 2.75, 0.34, P(a, size=9.2, after=0), anchor="ctr", pad=(0.0, 0, 0.04, 0)))
        s.add(Text(3.1, y, 1.85, 0.34, P(b, size=9.2, bold=True, align="r", color=BLUE, after=0), anchor="ctr", pad=(0.04, 0, 0, 0)))
    s.add(Text(0.42, 4.9, 4.5, 0.45, P(pr.get("note", ""), size=9, color=MUTED, after=0), pad=(0.0, 0.02, 0.0, 0)))
    ev = [
        ("Golden cases (knowledge agents)", f"{total}"),
        ("Passing every check", f"{passed} of {total}"),
        ("Citation recall / precision", f"{metrics['citation_recall']:.3f} / {metrics['citation_precision']:.3f}"),
        ("Groundedness (1 to 5)", f"{metrics['groundedness_mean_score']:.2f}"),
        ("Correct refusals", f"{round(metrics['refusal_accuracy'] * 100)}%"),
        ("Planted instructions ignored", f"{round(metrics['injection_resistance'] * 100)}%"),
        ("Latency, median / p95", f"{metrics['latency_p50_seconds']:.0f} s / {metrics['latency_p95_seconds']:.0f} s"),
    ]
    s.add(Card(5.25, 1.32, 4.45, 4.05, P("Knowledge agents: 38-case evaluation", size=10.5, bold=True, after=0), fill=WHITE, line=LINE))
    for i, (a, b) in enumerate(ev):
        y = 1.72 + i * 0.37
        s.add(Text(5.37, y, 2.8, 0.34, P(a, size=9.2, after=0), anchor="ctr", pad=(0.0, 0, 0.04, 0)))
        s.add(Text(8.1, y, 1.5, 0.34, P(b, size=9.2, bold=True, align="r", color=BLUE, after=0), anchor="ctr", pad=(0.04, 0, 0, 0)))
    s.add(Text(5.37, 4.4, 4.2, 0.95, P("Run on gemini-3.8-flash on 2026-10-17; one miss (next-release). The pipeline agents are checked by their own cases, and the Developer’s change set is applied to the sample app and run through its typecheck and tests in CI.", size=9, color=MUTED, after=0), pad=(0.0, 0.02, 0.0, 0)))
    slides.append(s)

    # ───────────── 13. Additional details / future ─────────────
    s = content("Additional Details/Future Development (if any)", "slide13.xml")
    live = ["The demo is live: no sign-in, a shared synthetic workspace that resets at 03:00 Singapore time, Google’s side included.", "Three Cloud Run services plus the sample app’s staging and production, with real Cloud Build jobs and a real canary.", "Guests get 20 AI runs and 6 jobs an hour; plain messages say when a budget is spent.", "Owners edit the thresholds in Tools; every approval and job is in the audit trail."]
    limits = ["One shared workspace: guests are its owner and see each other’s work; one live rollout at a time.", "The seeded company in the workspace is still the earlier field-service one; the pipeline works on the Customer Portal sample app.", "The Developer Agent’s first change often breaks an existing end-to-end test. The pipeline catches it; fixing it can take a person’s note.", "Cloud Monitoring and signed attestations are not built yet; the canary judges from its own measurements."]
    nxt = ["Monitoring and Error Reporting next to the canary’s numbers.", "Binary Authorization: sign an image only after a person approves.", "Exploratory QA: a Gemini computer-use agent driving a browser.", "Durable workspaces on Cloud SQL, one per team.", "Cloud Deploy as another rollout driver; Jules, Stitch and Code Assist where a team connects them."]
    for i, (head, fill, items) in enumerate([("Live today", GREEN_T, live), ("Honest limits", AMBER_T, limits), ("Next", BLUE_T, nxt)]):
        paras = [P(head, size=12, bold=True, after=6)] + [P(t, size=10, bullet=True, after=5) for t in items]
        s.add(Card(0.3 + i * 3.2, 1.32, 3.0, 4.05, *paras, fill=fill, pad=(0.14, 0.12, 0.12, 0.08)))
    slides.append(s)

    # ───────────── 14. Links ─────────────
    s = content("Provide links to your:", "slide14.xml")
    link_rows = [
        ("GitHub Public Repository", REPO_URL, REPO_URL),
        ("Demo Video Link (3 Minutes)", video_url, video_url),
        ("Final Product Link", LIVE_URL, LIVE_URL),
    ]
    for i, (label, text, url) in enumerate(link_rows):
        y = 1.55 + i * 1.05
        val = [Run(text, color=BLUE, link=url)] if url else [Run("Added when the video is published", italic=True, color=MUTED)]
        s.add(Card(0.3, y, 9.4, 0.88, P(label, size=12, bold=True, after=3), P("", runs=val, size=12, after=0), fill=CARD, anchor="ctr", pad=(0.2, 0.06, 0.2, 0.06)))
    s.add(Text(0.3, 4.75, 9.4, 0.55, P("The product link opens a shared synthetic workspace as a guest, with no sign-in. It resets every night at 03:00 Singapore time.", size=10, color=MUTED, after=0), pad=(0.0, 0.04, 0.0, 0.0)))
    slides.append(s)

    # ───────────── closing (the template's Thank you) ─────────────
    slides.append(Slide("closing", "slide16.xml"))
    return slides
