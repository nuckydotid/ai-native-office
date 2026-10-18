# studio-agents

The AI brain of Worktrees Studio: Google ADK 2.x agent workflows on Gemini (the Gemini Enterprise Agent Platform), served
as FastAPI + server-sent events. It runs on Cloud Run as the private `studio-agents` service; only `studio-web` may call it,
with a Google-signed ID token. It holds no secret: it authenticates to the Agent Platform with its own service account.

## What is here

```text
agent_service/
  main.py            FastAPI app: GET /health, POST /v1/run (SSE), POST /v1/index, POST /v1/reindex
  run.py             one run end to end: budget, wall-clock cap, dispatch, scrubbing, the final/error event
  agents/            the pipelines: librarian, planner (the Planner Agent), scribe, reviewer, importer, chief (Studio)
  knowledge/         chunking (headings, deterministic ids), Firestore vector store, in-memory store
  models/            the Gemini clients (real and fake), the retry/fallback wrapper, the per-run token budget
  tools/             what an agent may call: search_knowledge, get_document, list_tickets, get_ticket, recent_messages
  prompt.py          the prompt builder: rules in the system instruction, everything else quoted between a random nonce
  scrub.py           credential-shaped strings never reach a model or an answer
eval/                golden cases over docs/demo-data + the runner (run_eval.py)
tests/               pytest with the fake model; no Google Cloud needed
```

The wire contract (`RunRequest`, run events, `IndexItem`) mirrors `src/shared/ai/` in the app repository; field names are the
contract. Models are environment configuration (`GEMINI_MODEL`, `GEMINI_MODEL_FAST`, `GEMINI_MODEL_PRO`,
`GEMINI_MODEL_FALLBACK`, `EMBED_MODEL`); see `../deploy/env.md`.

## Run it locally

```bash
make install     # a venv with the dependencies
make dev         # fake model, in-memory index, http://localhost:8090 (no Google Cloud at all)
make test        # pytest against the fake model
```

For real models: `gcloud auth application-default login` once, then

```bash
GOOGLE_CLOUD_PROJECT=<your project> MODEL_BACKEND=vertex KNOWLEDGE_BACKEND=firestore make dev
```

(Firestore needs the vector index on the `knowledge` collection; `deploy/gcp-setup.sh` creates it. The in-memory backend is
enough for a first look.)

## The evaluation

```bash
GOOGLE_CLOUD_PROJECT=<your project> python eval/run_eval.py        # 38 golden cases, ~15-30 minutes
python eval/run_eval.py --offline                                  # fake model smoke of the runner
```

It indexes `../docs/demo-data` in memory, runs every case through the real pipelines, judges groundedness with
`GEMINI_MODEL_PRO`, and writes `eval/last-run.json` (git-ignored). The README of the app repository reports the numbers
from a real run.
