#!/usr/bin/env bash
# One-time Google Cloud setup for the delivery pipeline: the pipeline bucket, the `pipeline` Firestore database, the `northwind`
# Artifact Registry repository, the four service accounts, the Pub/Sub topics the Cloud Build and budget events arrive on, and the two
# public portal services the rollouts move. Safe to re-run: every step checks first.
#
#   bash deploy/gcp-pipeline-setup.sh --dry-run        print every command, call nothing
#   bash deploy/gcp-pipeline-setup.sh                  create what is missing
#
# THIS CREATES BILLED RESOURCES (Cloud Run services scale to zero, the bucket and Firestore are near-free). Read the dry run first.
# Options: --dry-run | -n   --yes | -y   --help
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run | -n) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --help | -h) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

if [ "$DRY_RUN" = 0 ]; then need gcloud; fi
load_state
[ -n "${PROJECT_ID:-}" ] || die "PROJECT_ID is not set: run deploy/gcp-setup.sh first or export PROJECT_ID"
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"

PIPELINE_BUCKET="${PROJECT_ID}${PIPELINE_BUCKET_SUFFIX}"
PIPELINE_SA_EMAIL="$(sa_email "$PIPELINE_SA")"
PIPELINE_BUILD_EMAIL="$(sa_email "$PIPELINE_BUILD_SA")"
PIPELINE_EVENTS_EMAIL="$(sa_email "$PIPELINE_EVENTS_SA")"
RUNTIME_EMAIL="$(sa_email "$NORTHWIND_RUNTIME_SA")"
STAGING_SERVICE=northwind-portal-staging
PROD_SERVICE_NAME=northwind-portal
PLACEHOLDER_IMAGE="us-docker.pkg.dev/cloudrun/container/hello"

echo "Project        : $PROJECT_ID ($REGION)"
echo "Pipeline bucket: gs://$PIPELINE_BUCKET"
echo "Pipeline SA    : $PIPELINE_SA_EMAIL"
echo "Build SA       : $PIPELINE_BUILD_EMAIL"
echo "Runtime SA     : $RUNTIME_EMAIL"
[ "$DRY_RUN" = 1 ] && echo "Mode           : DRY RUN, nothing is called"
echo

confirm "This will create the pipeline bucket, the 'pipeline' Firestore database, the 'northwind' Artifact Registry repository, four service accounts, Pub/Sub topics and the two public portal services in $PROJECT_ID.
The public portal services run a placeholder image until the first rollout, and they are open to the internet on purpose (a synthetic demo, reset nightly)."

# 1. APIs the pipeline uses.
say "APIs"
run gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com \
  pubsub.googleapis.com storage.googleapis.com iam.googleapis.com iamcredentials.googleapis.com logging.googleapis.com monitoring.googleapis.com \
  clouderrorreporting.googleapis.com containeranalysis.googleapis.com containerscanning.googleapis.com \
  cloudresourcemanager.googleapis.com --project="$PROJECT_ID"

# 2. Service accounts.
say "service accounts"
ensure_sa() { # ensure_sa NAME DISPLAY
  if probe gcloud iam service-accounts describe "$(sa_email "$1")" --project="$PROJECT_ID"; then
    note "$1 exists"
  else
    retry 5 10 gcloud iam service-accounts create "$1" --display-name="$2" --project="$PROJECT_ID"
  fi
}
ensure_sa "$PIPELINE_SA" "Studio pipeline (private builds, tests and rollouts)"
ensure_sa "$PIPELINE_BUILD_SA" "Pipeline build steps (Cloud Build, no deploy)"
ensure_sa "$NORTHWIND_RUNTIME_SA" "Northwind portal runtime"
ensure_sa "$PIPELINE_EVENTS_SA" "Pub/Sub push to studio-pipeline"
ensure_sa pipeline-smoke "Manual pipeline smoke checks"

# The person running the smoke script may impersonate that service account (the token carries the caller's email).
OPERATOR="$(capture gcloud config get-value account)"
if [ -n "$OPERATOR" ]; then
  retry 6 10 gcloud iam service-accounts add-iam-policy-binding "pipeline-smoke@$PROJECT_ID.iam.gserviceaccount.com" --project="$PROJECT_ID" \
    --member="user:$OPERATOR" --role=roles/iam.serviceAccountTokenCreator --format=none
fi

# 3. The bucket: sources, trunk archives, build logs. Three days is enough for a demo, and keeps the bill at zero.
say "bucket gs://$PIPELINE_BUCKET"
if probe gcloud storage buckets describe "gs://$PIPELINE_BUCKET" --project="$PROJECT_ID"; then
  note "exists"
else
  retry 5 15 gcloud storage buckets create "gs://$PIPELINE_BUCKET" --location="$REGION" --project="$PROJECT_ID" --uniform-bucket-level-access --public-access-prevention
fi
run gcloud storage buckets update "gs://$PIPELINE_BUCKET" --project="$PROJECT_ID" --lifecycle-file=/dev/stdin <<'YAML' || warn "the 3-day lifecycle rule was not set"
rule:
  - action:
      type: Delete
    condition:
      age: 3
YAML

# 4. Firestore, named database `pipeline`, so the pipeline's state never mixes with the agents' knowledge in `(default)`.
say "Firestore database pipeline in $REGION"
if probe gcloud firestore databases describe --database=pipeline --project="$PROJECT_ID"; then
  note "exists"
else
  retry 5 20 gcloud firestore databases create --database=pipeline --location="$REGION" --type=firestore-native --project="$PROJECT_ID"
fi

# 5. Artifact Registry for the portal images, keeping the last five tags.
say "Artifact Registry repository $NORTHWIND_AR_REPO"
if probe gcloud artifacts repositories describe "$NORTHWIND_AR_REPO" --location="$REGION" --project="$PROJECT_ID"; then
  note "exists"
else
  retry 5 15 gcloud artifacts repositories create "$NORTHWIND_AR_REPO" --repository-format=docker --location="$REGION" \
    --description="Northwind portal images built by the delivery pipeline" --project="$PROJECT_ID"
fi
retry 6 10 gcloud artifacts repositories add-iam-policy-binding "$NORTHWIND_AR_REPO" --location="$REGION" --project="$PROJECT_ID" \
  --member="serviceAccount:$PIPELINE_BUILD_EMAIL" --role=roles/artifactregistry.writer --format=none
# The pipeline service's own image is built with the same service account, into the studio repository.
retry 6 10 gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --location="$REGION" --project="$PROJECT_ID" \
  --member="serviceAccount:$PIPELINE_BUILD_EMAIL" --role=roles/artifactregistry.writer --format=none
# Cloud Run pulls the portal images as its service agent; the runtime identity may read them too.
PROJECT_NUMBER="${PROJECT_NUMBER:-$(capture gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')}"
if [ -n "$PROJECT_NUMBER" ]; then
  retry 6 10 gcloud artifacts repositories add-iam-policy-binding "$NORTHWIND_AR_REPO" --location="$REGION" --project="$PROJECT_ID" \
    --member="serviceAccount:service-$PROJECT_NUMBER@serverless-robot-prod.iam.gserviceaccount.com" --role=roles/artifactregistry.reader --format=none
fi
retry 6 10 gcloud artifacts repositories add-iam-policy-binding "$NORTHWIND_AR_REPO" --location="$REGION" --project="$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_EMAIL" --role=roles/artifactregistry.reader --format=none
# The deployer reads the image it is about to point a revision at.
retry 6 10 gcloud artifacts repositories add-iam-policy-binding "$NORTHWIND_AR_REPO" --location="$REGION" --project="$PROJECT_ID" \
  --member="serviceAccount:$PIPELINE_SA_EMAIL" --role=roles/artifactregistry.reader --format=none

# 6. IAM: least privilege, spelled out. The pipeline deploys; the build steps never do.
say "IAM roles"
bind_project_role() { # bind_project_role SA_NAME ROLE
  retry 6 10 gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$(sa_email "$1")" --role="$2" --condition=None --quiet --format=none
}
bind_sa_role() { # bind_sa_role SA_NAME MEMBER_EMAIL ROLE
  retry 6 10 gcloud iam service-accounts add-iam-policy-binding "$(sa_email "$1")" --project="$PROJECT_ID" \
    --member="serviceAccount:$2" --role="$3" --format=none
}

bind_project_role "$PIPELINE_SA" roles/cloudbuild.builds.editor
bind_project_role "$PIPELINE_SA" roles/datastore.user
bind_project_role "$PIPELINE_SA" roles/logging.logWriter
bind_project_role "$PIPELINE_SA" roles/monitoring.viewer
bind_project_role "$PIPELINE_SA" roles/run.viewer
bind_project_role "$PIPELINE_SA" roles/containeranalysis.occurrences.viewer
bind_project_role "$PIPELINE_BUILD_SA" roles/logging.logWriter
bind_project_role "$PIPELINE_BUILD_SA" roles/containeranalysis.occurrences.editor
bind_project_role "$NORTHWIND_RUNTIME_SA" roles/logging.logWriter

bind_sa_role "$PIPELINE_BUILD_SA" "$PIPELINE_SA_EMAIL" roles/iam.serviceAccountUser
bind_sa_role "$NORTHWIND_RUNTIME_SA" "$PIPELINE_SA_EMAIL" roles/iam.serviceAccountUser

# The build service account reads sources and writes logs in the pipeline bucket only.
retry 6 10 gcloud storage buckets add-iam-policy-binding "gs://$PIPELINE_BUCKET" --project="$PROJECT_ID" \
  --member="serviceAccount:$PIPELINE_BUILD_EMAIL" --role=roles/storage.objectAdmin --format=none
retry 6 10 gcloud storage buckets add-iam-policy-binding "gs://$PIPELINE_BUCKET" --project="$PROJECT_ID" \
  --member="serviceAccount:$PIPELINE_SA_EMAIL" --role=roles/storage.objectAdmin --format=none
# Cloud Build checks that the build identity can read the bucket's metadata before it writes its logs there.
retry 6 10 gcloud storage buckets add-iam-policy-binding "gs://$PIPELINE_BUCKET" --project="$PROJECT_ID" \
  --member="serviceAccount:$PIPELINE_BUILD_EMAIL" --role=roles/storage.legacyBucketReader --format=none

# Cloud Build's own service agent reads the source object and may act as the build service account.
PROJECT_NUMBER="$(capture gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
if [ "$DRY_RUN" = 1 ]; then PROJECT_NUMBER="<PROJECT_NUMBER>"; fi
CLOUDBUILD_AGENT="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
retry 6 10 gcloud storage buckets add-iam-policy-binding "gs://$PIPELINE_BUCKET" --project="$PROJECT_ID" \
  --member="$CLOUDBUILD_AGENT" --role=roles/storage.objectViewer --format=none
retry 6 10 gcloud iam service-accounts add-iam-policy-binding "$PIPELINE_BUILD_EMAIL" --project="$PROJECT_ID" \
  --member="$CLOUDBUILD_AGENT" --role=roles/iam.serviceAccountUser --format=none
# The build steps read the uploaded source object from Cloud Build's own staging bucket.
retry 6 10 gcloud storage buckets add-iam-policy-binding "gs://${PROJECT_ID}_cloudbuild" --project="$PROJECT_ID" \
  --member="serviceAccount:$PIPELINE_BUILD_EMAIL" --role=roles/storage.objectViewer --format=none

# 7. Pub/Sub: Cloud Build publishes every build to `cloud-builds`; the budget alert publishes to `budget-alerts`.
say "Pub/Sub topics"
for topic in cloud-builds budget-alerts; do
  if probe gcloud pubsub topics describe "$topic" --project="$PROJECT_ID"; then
    note "$topic exists"
  else
    retry 5 10 gcloud pubsub topics create "$topic" --project="$PROJECT_ID"
  fi
done

# 8. The two public portal services. They start on a placeholder image; the first rollout puts the real one there.
say "portal services $STAGING_SERVICE and $PROD_SERVICE_NAME"
ensure_run_service() { # ensure_run_service NAME
  if probe gcloud run services describe "$1" --project="$PROJECT_ID" --region="$REGION"; then
    note "$1 exists"
  else
    run gcloud run deploy "$1" --project="$PROJECT_ID" --region="$REGION" --image="$PLACEHOLDER_IMAGE" \
      --service-account="$RUNTIME_EMAIL" --allow-unauthenticated --min-instances=0 --max-instances=5 \
      --concurrency=80 --timeout=60 --memory=256Mi --cpu=1 --set-env-vars="NORTHWIND_ENV=demo" --quiet
  fi
  retry 6 10 gcloud run services add-iam-policy-binding "$1" --project="$PROJECT_ID" --region="$REGION" \
    --member="serviceAccount:$PIPELINE_SA_EMAIL" --role=roles/run.developer --format=none
}
ensure_run_service "$STAGING_SERVICE"
ensure_run_service "$PROD_SERVICE_NAME"

# 9. The budget alert: at 80% of the IDR 800,000 the pipeline's kill switch goes on. Best effort: it needs Billing Account Administrator.
say "budget alert → Pub/Sub topic budget-alerts (best effort)"
BUDGET_ACCOUNT="$(capture gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName.basename())')"
if [ -z "$BUDGET_ACCOUNT" ]; then
  warn "could not read the billing account; add the Pub/Sub notification by hand in Billing > Budgets"
elif [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] gcloud billing budgets update <budget> --billing-account=$BUDGET_ACCOUNT --add-notifications-rule=pubsub-topic=projects/$PROJECT_ID/topics/budget-alerts"
else
  budget_name="$(gcloud billing budgets list --billing-account="$BUDGET_ACCOUNT" --billing-project="$PROJECT_ID" --filter='displayName="Worktrees Studio AI Cup"' --format='value(name)' | head -1)"
  if [ -n "$budget_name" ]; then
    run gcloud billing budgets update "$budget_name" --billing-account="$BUDGET_ACCOUNT" \
      --notifications-rule-pubsub-topic="projects/$PROJECT_ID/topics/budget-alerts" --quiet || warn "the budget notification was not added (it needs Billing Account Administrator)"
  else
    warn "no budget named 'Worktrees Studio AI Cup' found; add the Pub/Sub notification by hand"
  fi
fi

echo
print_warnings
echo "Pipeline setup done. Next:"
echo "  bash deploy/pipeline.sh            # build and deploy studio-pipeline, and wire the Pub/Sub push subscriptions"
