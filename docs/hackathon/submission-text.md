# Submission text (paste into the portal)

Values in `{{...}}` are filled from the uploaded video.

## Team name

Worktrees Studio

## Project name

Worktrees Studio: an AI-native delivery service for web teams

## Category

Future of Work & Enterprise Productivity

## One-line pitch

Ten AI colleagues work next to people in a virtual office and carry a web change from an idea to production (plan, design, code,
tests, release, canary rollout), and people approve every gate.

## The problem

A web change crosses many hands: a spec, a design, code, tests, a release and a rollout, each in a different tool, each handed
over by hand. Coding assistants write code in an editor but stop there, CI/CD tools run what a person already wrote, and chat
assistants answer without sources. Nothing carries one ticket through all of it with a person approving each step.

## What we built

A React office with one sidebar page per stage (Plan, Design, Build, Test, Release, Deploy, and Tools), the pixel office with the AI
colleagues as characters, and the room chat. Each ticket walks the stages; on each one a colleague drafts an artifact and a person
decides.

- **Plan.** The Planner Agent drafts a spec: story, acceptance criteria, estimate, risks.
- **Design.** The Designer Agent draws a prototype, shown only in a sandboxed frame with no scripts and no network.
- **Build.** The Developer Agent writes a change set of whole files (at most eight, only in three folders) that a person reads as a
  diff. The real build runs on Cloud Build when a person presses Run.
- **Test.** Unit tests with coverage and Playwright run with the network switched off. The QA Agent can add end-to-end tests.
- **Release.** The Release Agent writes the pack; the release image is built and scanned with Artifact Analysis.
- **Deploy.** Staging, then production at 10, 50 and 100 percent on Cloud Run, each step measured, with automatic rollback.
  Thresholds that owners edit in Tools decide; the AI only writes the rollout up.
- **Knowledge and meetings.** The Librarian answers with citations, the Scribe turns a meeting into minutes and proposed tickets.

Agents propose, people decide. An approval is tied to the exact content (its digest). Every gate reads the same rules the server
enforces. Untrusted text reaches the models between per-run random markers and is declared data.

What the pipeline did when we ran it for real: it refused our first release because the scan found critical flaws in the base
image, and it stopped a change from moving on when the Developer Agent's edit broke an existing end-to-end test.

## Google Cloud architecture

Three Cloud Run services in one project: `studio-web` (Bun; office, board, artifacts, gates, audit; public, one warm instance),
`studio-agents` (Python, ADK 2.x; ten colleagues; private, scales to zero) and `studio-pipeline` (Bun and TypeScript; jobs,
rollouts, budgets, locks and a kill switch; private, under its own least-privilege identity). Only the pipeline service can build
or deploy. Service-to-service traffic carries Google-signed ID tokens with the audience pinned; agents only read, through
`/internal/v1`. No API key anywhere.

Behind the pipeline: Cloud Build (hermetic builds and tests), Cloud Storage (job sources, reports, the trunk), Artifact Registry
and Artifact Analysis (release images, vulnerability scan), Pub/Sub and a Billing budget (build events, a kill switch at 80% of the
budget), Firestore (knowledge vector search with `gemini-embedding-001`, and the pipeline's own named database), and the sample
app on Cloud Run (staging and production, revisions and traffic splits). Secret Manager holds the guest-token key, Cloud Scheduler
resets the demo and Google's side at 03:00 Singapore time, ADK's OpenTelemetry exports run traces to Cloud Trace. Models
(`gemini-3.8-flash`, `3.5-flash-lite`, `3.1-pro-preview`) are environment configuration with retry, backoff and a fallback chain.

## Live demo (no sign-in)

`https://studio-web-x6ud7nrylq-as.a.run.app`: a shared synthetic workspace that resets nightly. Create a ticket in Plan, press
**Draft the spec**, accept it, and Approve & advance; Design, Build and the rest work the same way. Guests get 20 AI runs and 6
pipeline jobs an hour, and the pipeline has daily caps and a kill switch. The Judge's 3-minute path card still walks the knowledge
and meeting flows.

## Measuring it

One ticket on the deployed demo, ranges over repeated runs (18 to 19 October 2026): spec 20 to 38 s, design 33 to 38 s, change set
53 to 86 s, the Cloud Build build 186 to 228 s, 8 unit tests with 100% coverage 132 to 156 s, release image 171 to 174 s, scan 124 to
145 s, release pack 15 to 21 s. A production canary at 10, 50 and 100 percent and a rollback were verified on the live services.

The knowledge agents were measured on 38 golden cases over the demo workspace (facts in one source, multi-source questions,
unanswerable questions that must be refused, planted instructions), one run:

| Metric | Result |
| --- | --- |
| Cases passing every check | 37 of 38 |
| Citation recall / precision | 1.000 / 1.000 |
| Groundedness (judge-scored, 1 to 5) | 4.97 / 5 |
| Refusal accuracy on unanswerable questions | 100% |
| Planted instructions ignored | 100% |
| Latency p50 / p95 | 37.8 s / 81.4 s |
| Tokens per run | 19,254 |

One case misses (`next-release`). Reproduce with `GOOGLE_CLOUD_PROJECT=<id> python eval/run_eval.py` (model `gemini-3.8-flash`,
`2026-10-17`). These are the numbers of one run.

## Honest limits

- One shared workspace and one live rollout at a time. The in-memory workspace is lost if the single web instance restarts.
- The seeded company in the workspace is still the earlier field-service one; the pipeline works on the Northwind Customer Portal
  sample app.
- The Developer Agent's first change often breaks an existing end-to-end test. The pipeline catches it; fixing it can take a person's
  note. Cloud Monitoring and signed attestations are not built yet.

## Links

- Live demo: `https://studio-web-x6ud7nrylq-as.a.run.app`
- Demo video (3:00): `https://drive.google.com/file/d/1aegkuWEeJbPpCgbToksb0DkwxneWELrU/view?usp=sharing`
- Deck: the cup's template, filled in: `docs/hackathon/submission.pptx` and `docs/hackathon/submission.pdf` (same slides)
- Code (public): `https://github.com/nuckydotid/ai-native-office`

## Team

Nucky Ridwan Gunawan (team leader), Principal Software Engineer · Hamza Arif, AI Engineer · Nithin Chandrakantha Reddy, UX Researcher

## Notes for the organisers

- The video runs **3:00**; we aimed for exactly three minutes given the FAQ ("under 3 min") and the T&Cs ("3 to 4 min") differ.
- All data in the demo is synthetic (a fictional company, invented vendors and figures). No customer data, no secrets.
