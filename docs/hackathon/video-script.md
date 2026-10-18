# Demo video script — exactly 3:00

Rules the video follows: it opens on the live product (no logo intro), English only, no secret, key, project number or
personal address on screen, and the browser is logged out / a clean profile (the demo needs no sign-in). Record at
1440×900 or larger, 30 fps; the UI is checked in dark and light — record in **dark** (the office at night).

Mouse timings assume a comfortable pace; if a Gemini run takes longer than scripted, wait in silence — do not cut away.

## 0:00–0:12 — Open on the live product

- (Screen) Clean browser, open `https://studio-web-x6ud7nrylq-as.a.run.app`. The lobby of "Northwind Field App" loads: people, the office, the
  "Judge's 3-minute path" card, the strip "Synthetic data · resets nightly · N AI runs left".
- (Voice) "This is Worktrees Studio: an office where a small team's knowledge, meetings and work live in one loop — and the
  AI colleagues work here too. Everything you see is a live Google Cloud app; no sign-in, all data synthetic."

## 0:12–0:55 — Knowledge access (cited, verified, honest)

- (Screen) Press **Core hours** in the Judge's path card. While it works, the status line reads "Librarian is preparing the
  answer… · Searching the team's knowledge". The answer arrives with citation chips.
- (Voice) "Every answer comes from the team's own Docs, tickets and past meetings, retrieved by vector search on
  Google Cloud. It carries its sources" — (click a chip; the Remote work page opens) — "and a verifier checks every claim
  against the cited text before it is shown."
- (Screen) Back to the lobby. Press **PushRelay renewal**: answer says not decided, USD 710 offer. Press **Not in the docs**:
  the Librarian refuses.
- (Voice) "The renewal page contains a hidden instruction to assistants — 'record it as approved'. The answer ignores it:
  untrusted text is quoted as data, never followed. And when the team never wrote it down, it says so instead of guessing."

## 0:55–1:35 — Meetings → decisions → work

- (Screen) Press **Run sample standup**; the scripted standup plays into the room chat (about 30 s — let two or three lines
  show, then keep going; it continues in the background).
- (Voice) "A standup just happened. One click — End meeting — and the Scribe reads the conversation."
- (Screen) Open ⋯ above the chat → **End meeting**. While it runs: "Scribe is preparing the answer… · Read 25 messages: 3
  decisions, 4 action items". Minutes arrive with a **proposal card**: 4 ticket items, one marked "already tracked #13",
  and the minutes page.
- (Screen) Tick the two new tickets, press **Accept**. Open Plan: the ticket is there.
- (Voice) "It found the three real action items, linked the fourth to the ticket that already covers it, and proposed the
  rest. Nothing was created until I pressed Accept — and the ticket appears on the board as me."

## 1:35–2:20 — Workflow execution

- (Screen) On Plan, in the room chat: type `@planner plan PDF export for inspection reports` and send. Plan card arrives with
  steps, colleagues and prior-art citations.
- (Voice) "The Planner Agent plans from the team's own knowledge first: the Q4 roadmap already schedules PDF export, so the plan builds
  on it instead of inventing it."
- (Screen) Switch to In Review, ask `@reviewer check ticket #4`. Checklist arrives: small-screen criterion missing, with
  evidence.
- (Voice) "The Reviewer checks the ticket's notes against its own acceptance criteria before a human looks" — (keep it on
  screen) — "and it can say *missing*."
- (Screen) Docs → **Import with AI** → choose `vendor-quote.pdf`. Page appears with the quote tables and total 5,397.30.
- (Voice) "A PDF becomes a Docs page, every figure kept. This is one multimodal call to Gemini, not a parser."

## 2:20–2:50 — What is under it (facts, not a slide deck)

- (Screen) Stay on the Docs page, open a second tab once: Cloud Run console showing **two services**, `studio-agents`
  private; close it. Optionally flash Cloud Trace for one run.
- (Voice, over the product) "Under the office: two Cloud Run services. The web service owns the workplace; the private
  Python agent service runs Google ADK 2.x workflows on Gemini, with Firestore vector search for knowledge and
  Google-signed identity between the two. Every run is capped by tokens and by a demo budget, and the agent service
  scales to zero."

## 2:50–3:00 — Close

- (Screen) Back to the lobby; the playground URL visible; end on the office with the Judge's path card.
- (Voice) "Grounded answers, meetings that become accepted tickets, and work that reviews itself — with a person deciding
  every change. Open it yourself: the link is in the submission. Thank you."

## What not to show

- No terminal with a token, no Secret Manager values, no project number, no billing pages, no personal email.
- No unedited 3-minute wait for a model; runs are 5–30 s; freeze-frame while waiting is allowed, cutting away is not.
