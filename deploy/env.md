# Environment and secrets

Set by `deploy/deploy.sh`. The Bun server and the agent service read exactly these names. `PORT` is reserved by Cloud Run: it sets it itself (the web image defaults to 8080) and `--set-env-vars` would refuse it.

## studio-web (public, Bun team server plus the built web app)

| Name | Value | Notes |
| --- | --- | --- |
| `DEMO_MODE` | `1` | Guest sign-in, seeded demo workspace. |
| `PORT` | `8080` | Image default; Cloud Run overrides it. |
| `WEB_DIR` | `/app/web` | Set in `deploy/web/Dockerfile`; where the server finds the web build. |
| `AGENT_SERVICE_URL` | URL of `studio-agents` | Read from Cloud Run after the agents deploy. It is also the ID-token audience. |
| `AGENT_SERVICE_AUTH` | `google` | Calls the agents with a Google ID token. |
| `INTERNAL_CALLER` | `studio-agents@<project>.iam.gserviceaccount.com` | The only identity allowed on `/internal/v1/*`. |
| `PUBLIC_URL` | `https://studio-web-<project number>.<region>.run.app` | Deterministic Cloud Run URL; audience of the agents' ID tokens. |
| `ALLOWED_ORIGINS` | same as `PUBLIC_URL` | |
| `TEAM_STORE` | `memory` | Rooms live in memory, hence exactly one instance. |
| `DEMO_RUNS_PER_GUEST_HOUR` | `20` | |
| `DEMO_RUNS_PER_DAY` | `1500` | Global cap. See the cost section of the README before keeping it. |
| `DEMO_DATA_DIR` | `/app/demo-data` | The seeded workspace the demo opens. `DEMO_SEED=web bash deploy/deploy.sh` points it at `/app/demo-data-web`. |
| `PIPELINE_ENABLED` | `0` | `1` switches the delivery pipeline on (artifacts, jobs, rollouts). Off: the stage pages say it is not connected. |
| `PIPELINE_SERVICE_URL` | empty | The private pipeline service, once it exists; also the audience of the ID tokens sent to it. Empty with the pipeline on means the in-process stand-in (local work only). |
| `GUEST_JWT_SECRET` | secret `GUEST_JWT_SECRET:latest` | Signs guest tokens (HS256). |
| `DEMO_RESET_TOKEN` | secret `DEMO_RESET_TOKEN:latest` | Checked against `x-reset-token` on `POST /demo/reset`. |

Run shape: min 1, max 1 instance, request-based CPU (`--cpu-throttling`), timeout 3600 s, 512 Mi, concurrency 250, session affinity, public. `deploy.sh --preview` deploys only this service as a tagged revision (`preview`) with no traffic and min 0 instances, so a change can be looked at on its own address before it goes live.

## studio-agents (private, Python ADK service)

| Name | Value | Notes |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | project id | |
| `GOOGLE_CLOUD_LOCATION` | `global` | Vertex AI location for Gemini. |
| `GOOGLE_GENAI_USE_VERTEXAI` | `true` | |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Override with the env var of the same name when running deploy.sh. Confirmed in this project, `global` location. |
| `GEMINI_MODEL_FAST` | `gemini-3.5-flash-lite` | The verifier, router and linker. |
| `GEMINI_MODEL_PRO` | `gemini-3.1-pro-preview` | The planner, Scribe writer and Importer. |
| `GEMINI_MODEL_FALLBACK` | `gemini-3.5-flash` | Used when the chosen model answers 429 or 503. |
| `EMBED_MODEL` | `gemini-embedding-001` | 768 dimensions, matching the Firestore vector index. |
| `ALLOWED_CALLER` | `studio-web@<project>.iam.gserviceaccount.com` | |
| `SERVICE_URL` | the service's own URL | Set by deploy.sh right after the first deploy; the audience an incoming ID token must carry. Without it the service refuses every call (fail closed) |
| `AUTH_MODE` | `google` | |
| `KNOWLEDGE_BACKEND` | `firestore` | |
| `MODEL_BACKEND` | `vertex` | |
| `THINKING_LEVEL` | `low` | Gemini 3 thinking level; measured on the golden set: ~3× faster and about half the tokens of the default, with the same recall |
| `TRACE_TO_CLOUD` | `true` | ADK's OpenTelemetry spans go to Cloud Trace (the `studio-agents` service account has `roles/cloudtrace.agent`) |

Run shape: min 0, max 5 instances, timeout 900 s, 1 Gi, concurrency 20, no unauthenticated access.

How the agents learn the web URL: every run request carries the server's own address in `webBase` (`RunRequest.webBase`), so the tools call back with an ID token for that audience; no extra env var is needed.

## Script settings (your shell, not the services)

`PROJECT_ID`, `REGION` (default `asia-southeast1`), `BILLING_ACCOUNT`, `BUDGET_AMOUNT` (default `50USD`), `GEMINI_MODEL*`, `EMBED_MODEL`, `AGENTS_DOCKERFILE` (default `agent-service/Dockerfile`), `AGENTS_CONTEXT` (default `agent-service`). `gcp-setup.sh` saves `PROJECT_ID` and `REGION` in `deploy/.env.gcp` (git-ignored).
