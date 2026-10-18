#!/usr/bin/env bash
# One-time Google Cloud bootstrap for the AI Builder Cup demo: project, billing link, APIs, identities, Artifact Registry,
# Firestore with its vector index, two Secret Manager secrets and a budget alert. Safe to re-run: every step checks first.
#
#   bash deploy/gcp-setup.sh --dry-run        print every command, call nothing
#   BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX bash deploy/gcp-setup.sh
#
# THIS CREATES A PROJECT AND LINKS A BILLING ACCOUNT (it spends money). Read the --dry-run output first.
# Environment (all optional):
#   BILLING_ACCOUNT   billing account id; found with `gcloud billing accounts list` (auto-picked when you have exactly one)
#   PROJECT_ID        reuse an existing project instead of generating wts-aibuilder-<random>
#   REGION            default asia-southeast1 (Cloud Run, Artifact Registry, Firestore, Scheduler)
#   BUDGET_AMOUNT     default 50USD (the currency must match the billing account)
# Options: --dry-run | -n   --yes | -y (skip the confirmation question)   --help
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

PROJECT_NAME="${PROJECT_NAME:-Worktrees Studio AI Cup}"
BUDGET_AMOUNT="${BUDGET_AMOUNT:-50USD}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-$REGION}"
BUILD_BUCKET_SUFFIX=_cloudbuild
EMBEDDING_DIMENSIONS=768

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run | -n) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --help | -h) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

need openssl
if [ "$DRY_RUN" = 0 ]; then need gcloud; fi

load_state
if [ -z "${PROJECT_ID:-}" ]; then
  PROJECT_ID="wts-aibuilder-$(openssl rand -hex 2)"
  NEW_ID=1
else
  NEW_ID=0
fi
[[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "invalid project id: $PROJECT_ID"
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID" # a forgotten --project can never fall back to some other project

WEB_SA="$(sa_email "$WEB_SERVICE")"
AGENTS_SA="$(sa_email "$AGENTS_SERVICE")"
BUILD_SA_EMAIL="$(sa_email "$BUILD_SA")"
BUILD_BUCKET="${PROJECT_ID}${BUILD_BUCKET_SUFFIX}"

echo "Project id     : $PROJECT_ID$([ "$NEW_ID" = 1 ] && echo ' (new)')"
echo "Project name   : $PROJECT_NAME"
echo "Region         : $REGION (Firestore: $FIRESTORE_LOCATION)"
echo "Budget alert   : $BUDGET_AMOUNT"
[ "$DRY_RUN" = 1 ] && echo "Mode           : DRY RUN, nothing is called"
echo

# 0. Billing account: found before anything is created, so an ambiguity stops the script early.
if [ -z "${BILLING_ACCOUNT:-}" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    BILLING_ACCOUNT="<BILLING_ACCOUNT>"
    note "[dry-run] BILLING_ACCOUNT is not set; a real run reads it with: gcloud billing accounts list --filter=open=true --format='value(name.basename())'"
  else
    accounts="$(gcloud billing accounts list --filter=open=true --format='value(name.basename())')"
    count="$(printf '%s\n' "$accounts" | grep -c . || true)"
    if [ "$count" = 1 ]; then
      BILLING_ACCOUNT="$accounts"
      say "using the only open billing account ($BILLING_ACCOUNT)"
    else
      echo "Open billing accounts:" >&2
      gcloud billing accounts list --filter=open=true >&2 || true
      die "found $count open billing accounts; set BILLING_ACCOUNT=<ACCOUNT_ID> and run again"
    fi
  fi
fi

confirm "This will CREATE the Google Cloud project '$PROJECT_ID' and LINK billing account '$BILLING_ACCOUNT' to it.
Everything created afterwards (Cloud Run, Firestore, Vertex AI calls) is billed to that account."

# 1. Project (the id is saved first so an interrupted run resumes the same project).
say "project $PROJECT_ID"
save_state
if probe gcloud projects describe "$PROJECT_ID"; then
  note "already exists"
else
  run gcloud projects create "$PROJECT_ID" --name="$PROJECT_NAME" --labels=purpose=ai-builder-cup
fi

# 2. Billing link.
say "billing"
billing_state="$(capture gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled,billingAccountName.basename())')"
case "$billing_state" in
  True*) note "already linked ($(printf '%s' "$billing_state" | cut -f2)); left as it is" ;;
  *) run gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT" ;;
esac

# 3. APIs. cloudresourcemanager (IAM bindings), billingbudgets (the alert) and storage (Cloud Build source bucket) are
# needed on top of the product APIs; enabling is idempotent.
say "APIs"
run gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com \
  firestore.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com logging.googleapis.com \
  cloudtrace.googleapis.com iam.googleapis.com cloudresourcemanager.googleapis.com billingbudgets.googleapis.com \
  storage.googleapis.com --project="$PROJECT_ID"

# 4. Service accounts: one per service, plus the identity Cloud Build runs as.
say "service accounts"
ensure_sa() { # ensure_sa NAME DISPLAY
  if probe gcloud iam service-accounts describe "$(sa_email "$1")" --project="$PROJECT_ID"; then
    note "$1 exists"
  else
    retry 5 10 gcloud iam service-accounts create "$1" --display-name="$2" --project="$PROJECT_ID"
  fi
}
ensure_sa "$WEB_SERVICE" "Studio web (public Cloud Run service)"
ensure_sa "$AGENTS_SERVICE" "Studio agents (private ADK service)"
ensure_sa "$BUILD_SA" "Studio image builds (Cloud Build)"

# 5. Project-level roles. Least privilege: nobody gets editor/owner.
say "IAM roles"
bind_project_role() { # bind_project_role SA_NAME ROLE
  retry 6 10 gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$(sa_email "$1")" --role="$2" --condition=None --quiet --format=none
}
bind_project_role "$AGENTS_SERVICE" roles/aiplatform.user
bind_project_role "$AGENTS_SERVICE" roles/datastore.user
bind_project_role "$AGENTS_SERVICE" roles/cloudtrace.agent
bind_project_role "$AGENTS_SERVICE" roles/logging.logWriter
bind_project_role "$WEB_SERVICE" roles/logging.logWriter
bind_project_role "$BUILD_SA" roles/logging.logWriter

# 6. Artifact Registry and the Cloud Build source bucket (regional, private).
say "Artifact Registry repository $AR_REPO"
if probe gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" --project="$PROJECT_ID"; then
  note "exists"
else
  retry 5 15 gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location="$REGION" \
    --description="Studio web and agents images" --project="$PROJECT_ID"
fi
retry 6 10 gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --location="$REGION" --project="$PROJECT_ID" \
  --member="serviceAccount:$BUILD_SA_EMAIL" --role=roles/artifactregistry.writer --format=none

say "Cloud Build source bucket gs://$BUILD_BUCKET"
if probe gcloud storage buckets describe "gs://$BUILD_BUCKET" --project="$PROJECT_ID"; then
  note "exists"
else
  retry 5 15 gcloud storage buckets create "gs://$BUILD_BUCKET" --location="$REGION" --project="$PROJECT_ID" \
    --uniform-bucket-level-access --public-access-prevention
fi
retry 6 10 gcloud storage buckets add-iam-policy-binding "gs://$BUILD_BUCKET" --project="$PROJECT_ID" \
  --member="serviceAccount:$BUILD_SA_EMAIL" --role=roles/storage.objectViewer --format=none

# 7. Firestore (native mode) and the vector index. The distance measure (COSINE) is chosen per query with find_nearest;
# the index itself only fixes the dimension and the flat (exact) layout.
say "Firestore (default) database in $FIRESTORE_LOCATION"
if probe gcloud firestore databases describe --database='(default)' --project="$PROJECT_ID"; then
  note "exists"
else
  retry 5 15 gcloud firestore databases create --database='(default)' --location="$FIRESTORE_LOCATION" \
    --type=firestore-native --project="$PROJECT_ID"
fi

say "vector index: collection knowledge, field embedding, $EMBEDDING_DIMENSIONS dimensions, flat"
index_list="$(capture gcloud firestore indexes composite list --database='(default)' --project="$PROJECT_ID" \
  --filter='name~/collectionGroups/knowledge/' --format='json(name,fields)')"
case "$index_list" in
  *vectorConfig*) note "a vector index on knowledge already exists" ;;
  *) retry 4 15 gcloud firestore indexes composite create --database='(default)' --collection-group=knowledge \
    --query-scope=collection --async --project="$PROJECT_ID" \
    --field-config="field-path=embedding,vector-config={\"dimension\":\"$EMBEDDING_DIMENSIONS\",\"flat\":\"{}\"}" ;;
esac

# 8. Secrets: random values go straight from openssl into Secret Manager. They are never printed or put in a variable.
say "secrets"
store_random_secret() { # store_random_secret create|add NAME
  local verb="$1" name="$2" shown
  if [ "$verb" = create ]; then
    shown="gcloud secrets create $name --replication-policy=automatic --data-file=- --project=$PROJECT_ID"
  else
    shown="gcloud secrets versions add $name --data-file=- --project=$PROJECT_ID"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] openssl rand -hex 32 | tr -d "\\n" | %s\n' "$shown"
    return 0
  fi
  printf '  $ openssl rand -hex 32 | tr -d "\\n" | %s\n' "$shown"
  if [ "$verb" = create ]; then
    openssl rand -hex 32 | tr -d '\n' | gcloud secrets create "$name" --replication-policy=automatic --data-file=- --project="$PROJECT_ID"
  else
    openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add "$name" --data-file=- --project="$PROJECT_ID"
  fi
}
for secret in $SECRET_NAMES; do
  if probe gcloud secrets describe "$secret" --project="$PROJECT_ID"; then
    enabled="$(capture gcloud secrets versions list "$secret" --filter='state=ENABLED' --limit=1 --format='value(name)' --project="$PROJECT_ID")"
    if [ -n "$enabled" ]; then
      note "$secret exists with an enabled version (kept; see README to rotate)"
    else
      retry_fn 5 15 store_random_secret add "$secret"
    fi
  else
    retry_fn 5 15 store_random_secret create "$secret"
  fi
  # Only the public service reads them. The agents service holds no secret.
  retry 6 10 gcloud secrets add-iam-policy-binding "$secret" --project="$PROJECT_ID" \
    --member="serviceAccount:$WEB_SA" --role=roles/secretmanager.secretAccessor --format=none
done

# 9. studio-web may call the private agents service. Only possible once that service exists; deploy.sh does it too.
say "run.invoker for $WEB_SERVICE on $AGENTS_SERVICE"
if [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] skipped: $AGENTS_SERVICE does not exist before the first deploy (deploy.sh grants it right after deploying). The command:"
  note "$(quote_cmd gcloud run services add-iam-policy-binding "$AGENTS_SERVICE" --region="$REGION" --project="$PROJECT_ID" --member="serviceAccount:$WEB_SA" --role=roles/run.invoker)"
elif probe gcloud run services describe "$AGENTS_SERVICE" --region="$REGION" --project="$PROJECT_ID"; then
  run gcloud run services add-iam-policy-binding "$AGENTS_SERVICE" --region="$REGION" --project="$PROJECT_ID" \
    --member="serviceAccount:$WEB_SA" --role=roles/run.invoker --format=none
else
  note "$AGENTS_SERVICE does not exist yet: deploy.sh grants it right after the first deploy"
fi

# 10. Budget alert. It only emails; it does not stop spending (see README).
say "budget alert $BUDGET_AMOUNT"
BUDGET_NAME="$PROJECT_NAME"
existing_budget="$(capture gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" --billing-project="$PROJECT_ID" \
  --filter="displayName=\"$BUDGET_NAME\"" --format='value(name)')"
if [ -n "$existing_budget" ]; then
  note "a budget named '$BUDGET_NAME' already exists"
elif ! retry 4 20 gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" --billing-project="$PROJECT_ID" \
  --display-name="$BUDGET_NAME" --budget-amount="$BUDGET_AMOUNT" --filter-projects="projects/$PROJECT_ID" \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
  --threshold-rule=percent=1.0,basis=forecasted-spend; then
  warn "the budget alert was NOT created (it needs Billing Account Administrator). Create it by hand: Billing > Budgets & alerts > $BUDGET_AMOUNT, scoped to $PROJECT_ID"
fi

# 11. Wait for the vector index so the first reindex does not hit FAILED_PRECONDITION.
say "waiting for the vector index"
if [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] polls: gcloud firestore indexes composite list --filter='name~/collectionGroups/knowledge/' --format='value(state)' (up to 10 minutes)"
else
  ready=0
  for _ in $(seq 1 60); do
    state="$(gcloud firestore indexes composite list --database='(default)' --project="$PROJECT_ID" \
      --filter='name~/collectionGroups/knowledge/' --format='value(state)' 2>/dev/null || true)"
    case "$state" in *READY*) ready=1; break ;; esac
    sleep 10
  done
  if [ "$ready" = 1 ]; then note "index READY"; else warn "the vector index is not READY after 10 minutes; check: gcloud firestore indexes composite list --project=$PROJECT_ID"; fi
fi

echo
echo "Done. Project: $PROJECT_ID (saved in deploy/.env.gcp, which is git-ignored)."
echo "Next: bash deploy/deploy.sh --dry-run, then bash deploy/deploy.sh, then bash deploy/scheduler.sh"
print_warnings
