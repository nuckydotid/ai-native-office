# team-server

The **web service** of Worktrees Studio: the virtual office (who is here, and the Room conversation that is saved for everyone), the
board (issues), the docs (a tree of Markdown pages), the guest sign-in and run budgets of the hosted demo, and the
runner that asks the agent service to think. It also serves the built web app. It runs on **Cloud Run**; Hono for HTTP, Bun-native
WebSockets, and either Postgres or an in-memory store for what has to survive a restart.

## How people get in

In the hosted demo (`DEMO_MODE=1`) nobody signs in: `POST /demo/guest` hands every visitor a short-lived signed token
(`demo:<jwt>`, HS256), which is the whole credential for the REST API and the office socket. Guests are the owners of the one
synthetic workspace, each in a room of their own. There are no accounts, no invitations and no member list to manage: whoever holds a
valid token is in, and the seeded teammates are part of the seed, not of any sign-in.

`TEAM_DEV_AUTH=1` adds `dev:<uid>[@<role>][:<name>]` tokens for tests and local runs (`role` is `owner`, `admin` or `member`; owner when left
out). That is the only other way in, and the server refuses to start with it on Cloud Run.
## Configuration (environment)

| Variable | Meaning |
| --- | --- |
| `PROJECT_NAME` | the office's name |
| `DATABASE_URL` | Postgres connection string (the Cloud SQL socket URL on Cloud Run). Set → `TEAM_STORE=postgres` |
| `TEAM_STORE` | `postgres` (default when `DATABASE_URL` is set) or `memory` |
| `ALLOWED_ORIGINS` | comma list of the origins that may call the API from a browser; the page's own origin (`PUBLIC_URL`) always may. Unset: `http://localhost:1420` and `http://127.0.0.1:1420`, where `npm run dev` serves the web app |
| `MAX_PLAYERS` | office capacity, default 100 |
| `CHAT_RETENTION_DAYS` | how long the Room's messages are kept. Default `0` = forever; set a number of days to prune older messages as new ones arrive |
| `TRUST_PROXY_HOPS` | how many hops from the right of `x-forwarded-for` are your own proxies, for the per-address limits. Default 1 on Cloud Run (`K_SERVICE` is set), 0 elsewhere (the header is then ignored) |
| `TEAM_DEV_AUTH=1` | **local only**: tokens are `dev:<uid>[@<role>][:<name>]` |

The variables of the hosted demo are in its own section below; `deploy/env.md` lists everything the deploy sets.

## Endpoints

`GET /health` (use this one on Cloud Run: it reserves `/healthz`), `GET /config` (the office's name and the socket's protocol version — nothing
secret), `WS /ws` (office).

The board and the docs (bearer token; anyone signed in):

| Request | Does |
| --- | --- |
| `GET /board` | the issues, the people an issue can be assigned to (names only), who you are, and whether you may delete anyone's issue |
| `POST /board/issues`, `PATCH /board/issues/:id`, `DELETE /board/issues/:id` | make, change or delete an issue (changing is open to everyone; deleting someone else's is for the author, the owner and admins) |
| `GET /pages`, `POST /pages`, `PATCH /pages/:id`, `DELETE /pages/:id` | the docs tree: pages of Markdown, at most six levels deep, no cycles (deleting a page moves its subpages up; deleting someone else's is for the author, the owner and admins) |

The office socket speaks protocol version 7 (`src/shared/workspace/protocol.ts`). A client that sends none, or an older one, is turned away with
`update_required`. The Room's history is read in pages of up to 50, newest first (`history.get`), filtered by room and session.

## Data

Tables are created on first start in the database: `tm_workspace`, `tm_member` (the people who have a zone in the office), `tm_doc` (the map), `tm_message`, `tm_session`, `tm_thread`, and for the board and docs `tm_issue`, `tm_page`, `tm_asset` (no migration step; a `tm_invite` table from older versions is not used and is left alone). A deleted message stays as an empty tombstone so everyone's history lines up. The hosted demo runs with the in-memory store and starts from the seed again every night.

## Run and test

```bash
bun install
bun run dev        # TEAM_DEV_AUTH=1, in-memory store, port 8080
bun run test
bun run typecheck
```

The tests run the real Postgres store on PGlite (Postgres in-process), so no database is needed. For the hosted demo locally, see "Run it
locally" in the repository's README.

`src/shared/` is a generated copy of the app's shared protocol code (`npm run sync-core` in the repository root); do not edit it here.

## Deploy

`bash deploy/deploy.sh` from the repository root builds this service and the web app into one image (`deploy/web/Dockerfile`) and deploys it as
`studio-web`. One instance only (`max_instances = 1`): live room state (who is here, which agent runs are pending, the newest messages)
is in memory, and message times are made strictly increasing from the stored tail. A second instance would disagree about both.
`min_instances` is 1 because WebSockets drop when the instance scales to zero.

## Agents

When someone @mentions an agent, the server checks the mention like any other (a recent message of theirs, in a room they may ask in),
counts the run against their budget (`DEMO_RUNS_PER_GUEST_HOUR`, `DEMO_RUNS_PER_DAY`), shows everyone that the agent is working (with the
phase and one safe line about it), and asks the **agent service** (`agent-service/`, Python, Google ADK on Cloud Run) to think. The agents are the server's own
(`src/ai/agents.ts`, seeded from `docs/demo-data/agents`). The service streams events (`status`, `step`, `final`, `error`; `src/shared/ai/types.ts`), and the server saves
the answer under a deterministic id (`a:<question>:<agent>`, so asking twice never answers twice), with its **citations** (docs and tickets it relied on) and,
from the Scribe, a **proposal card**. Nothing is created until a person accepts: `card.decide` on a proposal makes the chosen tickets and pages *as that
person*. The agent service reads tickets, pages and the room's conversation through `/internal/v1/*` (Google ID token from its service account; nothing there
writes), and is told about every change to a ticket or page so its knowledge index stays current.

Anyone in the room can read what an agent answers; the owner, admins, and the person who asked (for 60 seconds) can delete it.

## The hosted demo (`DEMO_MODE=1`)

One Cloud Run service serves the built web app (`WEB_DIR`), the API and the sockets from the same address, with a seeded synthetic workspace
(`DEMO_DATA_DIR`, default `docs/demo-data`; a small built-in one when absent) that anyone can open **without an account**.

| Variable | Meaning |
| --- | --- |
| `DEMO_MODE=1` | guests, the seed, `/demo/*`, `/ai/*` and `/agents` |
| `GUEST_JWT_SECRET` | signs guest tokens (`demo:<jwt>`, HS256, 7 days); from Secret Manager. Unset: random per start |
| `AGENT_SERVICE_URL` | the agent service's address. Unset: the demo opens but its agents say the AI service is not connected |
| `AGENT_SERVICE_AUTH` | `google` (default on Cloud Run: calls carry an ID token for that address) or `none` (local only; refused on Cloud Run) |
| `INTERNAL_CALLER` | the agent service's service-account email: the only caller `/internal/v1/*` accepts |
| `PUBLIC_URL` | this server's own address (the ID tokens' audience; also an allowed origin) |
| `WEB_DIR` | the built web app (`dist`) to serve; unset: API only |
| `DEMO_DATA_DIR` | the seed folder |
| `DEMO_RESET_TOKEN` | lets Cloud Scheduler call `POST /demo/reset` (header `x-reset-token`) every night |
| `DEMO_RUNS_PER_GUEST_HOUR` / `DEMO_RUNS_PER_DAY` | the Gemini budget: runs one guest may start per hour, and all guests per day (the day ends at the 03:00 Singapore reset). Default 20 and 1500 |
| `DEMO_AGENT_EDITS=1` | let guests change the shared agents' instructions (off: the agents are the same for every visitor) |

| Request | Does |
| --- | --- |
| `POST /demo/guest {name?}` | a guest token for anyone (rate-limited per address) |
| `GET /demo/status` | `{synthetic, runsLeft, runsPerHour, resetsAt, agents}` for the strip the demo shows |
| `POST /demo/reset` | back to the seed (token only); everyone is sent away and comes back to a fresh office |
| `POST /demo/sample-standup {room}` | plays the seed's scripted standup into a room, as the seeded teammates |
| `GET /agents`, `PUT /agents/:handle` | the roster; changing one is off unless `DEMO_AGENT_EDITS` |
| `POST /ai/minutes {room, session}` | "End meeting": the Scribe writes the minutes and proposes tickets |
| `POST /ai/import {name, mime, dataBase64, parent?}` | "Import with AI": a PDF or picture becomes a Docs page |

Guests are the owners of the one synthetic workspace, each in a room of their own, and are removed after 45 minutes away.

## Not here (by design)

No `/ai/generate` and no model key on this server: Gemini is only ever called by the agent service, with its own service account (no key at all on Cloud Run).
No projects API, no billing, no GitHub, no email. No Google or Firebase sign-in, no invitations or member list, no design room: the server was once
shared with a desktop app and a design site, and everything only they used is gone.
