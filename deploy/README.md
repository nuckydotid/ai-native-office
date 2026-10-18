# Deploying the AI Builder Cup demo

Two Cloud Run services in `asia-southeast1`: `studio-web` (public: Bun team server plus the built web app) and `studio-agents` (private: Python ADK service). Names and env: see [env.md](env.md).

## Order of operations

Every script takes `--dry-run`, which prints each command and calls nothing. Read it first.

1. `npm run check` and commit your work. `deploy.sh` uploads a copy of the working tree (tracked plus unignored files), so uncommitted code is deployed.
2. `bash deploy/gcp-setup.sh --dry-run`, then `BILLING_ACCOUNT=<id> bash deploy/gcp-setup.sh` (find the id with `gcloud billing accounts list`; it is picked automatically when you have one). **This creates a project and links billing.** Idempotent: re-running skips what exists.
3. `bash deploy/deploy.sh --dry-run`, then `bash deploy/deploy.sh`. Builds both images in Cloud Build, deploys agents then web, grants `run.invoker`, checks `/health` on both, seeds the demo with `POST /demo/reset`, prints the public URL last.
4. `bash deploy/scheduler.sh` creates `demo-reset` (03:00 Asia/Singapore daily). `--run-now` triggers it once.
5. Public repo: `bash scripts/export-public.sh <new-folder> --repo owner/name`, read its output, then run the `gh repo create ...` command it prints yourself.

`deploy.sh` stops if `agent-service/Dockerfile` is missing. Its build context is `agent-service/` (override with `AGENTS_CONTEXT=.`).

## Cost expectations (assumptions, not quotes)

Check current prices before relying on this. Assumed: Cloud Run Tier 2 region, 19 days of evaluation (18 Oct to 6 Nov).

| Item | Estimate | Assumption |
| --- | --- | --- |
| studio-web | roughly 8 to 15 USD | 1 vCPU and 512 Mi kept warm at the idle rate, plus request time |
| studio-agents | under 2 USD | scales to zero; seconds of CPU per run |
| Gemini and embeddings | the real variable | per run about 15k input and 1.5k output tokens; multiply by the current price of your model |
| Firestore, Secret Manager, Scheduler, Artifact Registry, Cloud Build | cents | inside free tiers for a few builds and a few hundred runs |

Worst case: `DEMO_RUNS_PER_DAY=1500` means up to 1500 Gemini runs a day. At about 1 cent per run that is 15 USD a day, so the alert would be crossed in about three days of sustained abuse. The budget alert only emails; it does not stop spending. Lower `DEMO_RUNS_PER_DAY` (edit `deploy.sh`) to something like 300 if you are not sure.

`BUDGET_AMOUNT` must be in the billing account's own currency (`50USD` for a USD account; for an IDR account something like `800000IDR`, roughly 50 USD). `gcloud billing budgets create` refuses a foreign currency and the script only warns, so check `gcloud billing accounts describe <ID> --format='value(currencyCode)'` and create the alert in the console if the warning appears.

## Teardown

When the evaluation is over (after the finalists are announced, 7 Nov):

```bash
gcloud projects delete <PROJECT_ID>
```

Stops all billing; the project can be restored for 30 days. Delete the budget in Billing if you want it gone too.

## Rotating secrets

```bash
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add GUEST_JWT_SECRET --data-file=- --project <PROJECT_ID>
bash deploy/deploy.sh --skip-build --tag <current tag>   # new revision reads :latest
```

Rotating `GUEST_JWT_SECRET` signs every guest out. For `DEMO_RESET_TOKEN`, also run `bash deploy/scheduler.sh` so the job carries the new value. Disable old versions with `gcloud secrets versions disable`.

## What NOT to paste in public places

Never put these in the README, the deck, the video, an issue or a chat:

- the output of `gcloud secrets versions access`, `gcloud auth print-identity-token`, or any token or `x-reset-token` value;
- `deploy/.env.gcp`, your billing account id, or terminal screenshots showing them;
- `src-tauri/google-client.json`, any `.env*`, `*.tfvars`, `*.tfstate`;
- Cloud Run env dumps (`gcloud run services describe`) and Cloud Build logs unreviewed.

Before the repo goes public run `scripts/secret-scan.sh`. The tracked test fixtures contain fake keys shaped like real ones; GitHub push protection may block the push on them. Build such strings from pieces in the tests, or accept the findings once with `--write-baseline` kept outside the repo.
