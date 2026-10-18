#!/usr/bin/env bash
# Build and deploy studio-pipeline, the private service that runs real builds, tests, scans and rollouts, and wire the Pub/Sub push
# subscriptions that tell it when a build or a budget alert arrives.
#
#   bash deploy/pipeline.sh --dry-run      print every command, call nothing
#   bash deploy/pipeline.sh                build, deploy, grant, wire
#
# The source is a clean copy of the working tree (tracked plus untracked-but-not-ignored files), so git-ignored files never leave this
# machine. Run deploy/gcp-pipeline-setup.sh once before the first real run.
# Options: --dry-run | -n   --yes | -y   --skip-build   --tag TAG   --help
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SKIP_BUILD=0
TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run | -n) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --tag) shift; TAG="${1:-}"; [ -n "$TAG" ] || die "--tag needs a value" ;;
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
WEB_SA_EMAIL="$(sa_email "$WEB_SERVICE")"
PIPELINE_SMOKE_EMAIL="${PIPELINE_SMOKE_SA:-pipeline-smoke}@$PROJECT_ID.iam.gserviceaccount.com"
if [ -z "$TAG" ]; then
  TAG="$(date +%Y%m%d-%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
fi
PIPELINE_IMAGE="${IMAGE_BASE:-$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO}/pipeline:$TAG"

STAGING_SERVICE="${STAGING_SERVICE:-northwind-portal-staging}"
PROD_SERVICE_NAME="${PROD_SERVICE:-northwind-portal}"

echo "Project : $PROJECT_ID ($REGION)"
echo "Image   : $PIPELINE_IMAGE"
[ "$DRY_RUN" = 1 ] && echo "Mode    : DRY RUN, nothing is called"
echo

if [ "$DRY_RUN" = 0 ]; then
  [ -f "$ROOT/pipeline-service/Dockerfile" ] || die "missing pipeline-service/Dockerfile"
  need git
fi

confirm "This builds the pipeline image and deploys studio-pipeline (private) in $PROJECT_ID.
It uses your uncommitted working tree. Builds and rollouts started from it spend real quota."

PLACEHOLDER="$(mktemp -d "${TMPDIR:-/tmp}/pipeline-build.XXXXXX")"
cleanup() { rm -rf "$PLACEHOLDER"; }
trap cleanup EXIT

stage_source() {
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] copy 'git ls-files --cached --others --exclude-standard' into a temp dir and refuse if .env*, *.pem, *.tfstate are in it"
    return 0
  fi
  (cd "$ROOT" && git ls-files -z --cached --others --exclude-standard) |
    while IFS= read -r -d '' file; do
      if [ -e "$ROOT/$file" ] || [ -L "$ROOT/$file" ]; then printf '%s\0' "$file"; fi
    done |
    (cd "$ROOT" && COPYFILE_DISABLE=1 tar -cf - --null -T -) |
    tar -xf - -C "$PLACEHOLDER"
  local leaked
  leaked="$(find "$PLACEHOLDER" \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.tfstate' -o -name 'service-account*.json' \) ! -name '.env.example' -print | head -5)"
  [ -z "$leaked" ] || die "refusing to upload; sensitive-looking files are in the source copy: $leaked"
}

if [ "$SKIP_BUILD" = 0 ]; then
  say "building the pipeline image in Cloud Build"
  if [ "$DRY_RUN" = 0 ]; then stage_source; fi
  run gcloud builds submit "${PLACEHOLDER:-$ROOT}" --project="$PROJECT_ID" --quiet \
    --config="$ROOT/deploy/cloudbuild.yaml" \
    --service-account="projects/$PROJECT_ID/serviceAccounts/$PIPELINE_BUILD_EMAIL" \
    --gcs-source-staging-dir="gs://${PROJECT_ID}_cloudbuild/source" \
    --substitutions="_IMAGE=$PIPELINE_IMAGE,_DOCKERFILE=pipeline-service/Dockerfile,_CONTEXT=."
else
  say "skipping the build (the image must already exist with tag $TAG)"
fi

WEB_URL="$(capture gcloud run services describe "$WEB_SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
say "deploying $PIPELINE_SERVICE (private)"
PIPELINE_ENV="$(join_env \
  "PROJECT_ID=$PROJECT_ID" "REGION=$REGION" "PIPELINE_BUCKET=$PIPELINE_BUCKET" "FIRESTORE_DATABASE=pipeline" \
  "ARTIFACT_REPO=$NORTHWIND_AR_REPO" "STAGING_SERVICE=$STAGING_SERVICE" "PROD_SERVICE=$PROD_SERVICE_NAME" \
  "BUILD_SERVICE_ACCOUNT=$PIPELINE_BUILD_EMAIL" "RUNTIME_SERVICE_ACCOUNT=$RUNTIME_EMAIL" \
  "PIPELINE_CALLERS=$WEB_SA_EMAIL,$PIPELINE_EVENTS_EMAIL,$PIPELINE_SMOKE_EMAIL" "PIPELINE_AUTH=google" "PIPELINE_ENABLED=1" \
  "WEB_SERVICE_URL=${WEB_URL:-}" "BASELINE_DIR=/app/sample-app" "SMOKE_SCRIPT=/app/sample-app/smoke/smoke.mjs" \
  "JOBS_PER_DAY=30" "JOBS_PER_GUEST_HOUR=6" "MAX_CONCURRENT_JOBS=2" "SCANS_PER_DAY=6" "ROLLOUTS_PER_DAY=15")"
run gcloud run deploy "$PIPELINE_SERVICE" --project="$PROJECT_ID" --region="$REGION" --image="$PIPELINE_IMAGE" \
  --service-account="$PIPELINE_SA_EMAIL" --no-allow-unauthenticated \
  --min-instances=0 --max-instances=1 --concurrency=20 --timeout=900 --memory=1Gi --cpu=1 --cpu-boost \
  --set-env-vars="$PIPELINE_ENV" --quiet

PIPELINE_URL="$(capture gcloud run services describe "$PIPELINE_SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
if [ "$DRY_RUN" = 1 ]; then PIPELINE_URL="https://$PIPELINE_SERVICE-<PROJECT_NUMBER>.$REGION.run.app"; fi
[ -n "$PIPELINE_URL" ] || die "could not read the URL of $PIPELINE_SERVICE"
note "$PIPELINE_URL"

# The service URL is also the audience every caller's ID token carries; Cloud Run only knows it after the first deploy.
say "setting SERVICE_URL on $PIPELINE_SERVICE"
run gcloud run services update "$PIPELINE_SERVICE" --project="$PROJECT_ID" --region="$REGION" --update-env-vars="$(join_env "SERVICE_URL=$PIPELINE_URL")" --quiet

say "granting run.invoker on $PIPELINE_SERVICE to $WEB_SERVICE and $PIPELINE_EVENTS_SA"
run gcloud run services add-iam-policy-binding "$PIPELINE_SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --member="serviceAccount:$WEB_SA_EMAIL" --role=roles/run.invoker --format=none
run gcloud run services add-iam-policy-binding "$PIPELINE_SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --member="serviceAccount:$PIPELINE_EVENTS_EMAIL" --role=roles/run.invoker --format=none
run gcloud run services add-iam-policy-binding "$PIPELINE_SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --member="serviceAccount:$PIPELINE_SMOKE_EMAIL" --role=roles/run.invoker --format=none

# The push subscriptions: Cloud Build and the budget alert tell the pipeline when to reconcile.
wire_subscription() { # wire_subscription NAME ENDPOINT
  if probe gcloud pubsub subscriptions describe "$1" --project="$PROJECT_ID"; then
    run gcloud pubsub subscriptions update "$1" --project="$PROJECT_ID" \
      --push-endpoint="$2" --push-auth-service-account="$PIPELINE_EVENTS_EMAIL" --push-auth-token-audience="$PIPELINE_URL" --ack-deadline=60 --quiet
  else
    run gcloud pubsub subscriptions create "$1" --project="$PROJECT_ID" \
      --topic="${1%-pipeline}" --push-endpoint="$2" --push-auth-service-account="$PIPELINE_EVENTS_EMAIL" \
      --push-auth-token-audience="$PIPELINE_URL" --ack-deadline=60 --quiet
  fi
}
say "wiring Pub/Sub push subscriptions"
wire_subscription cloud-builds-pipeline "$PIPELINE_URL/v1/events/build"
wire_subscription budget-alerts-pipeline "$PIPELINE_URL/v1/events/budget"

echo
print_warnings
echo "studio-pipeline:"
echo "$PIPELINE_URL"
echo
echo "Point the web service at it (deploy/deploy.sh does this when PIPELINE_ENABLED=1):"
echo "  PIPELINE_ENABLED=1 PIPELINE_SERVICE_URL=$PIPELINE_URL bash deploy/deploy.sh"
