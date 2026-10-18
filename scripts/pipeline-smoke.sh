#!/usr/bin/env bash
# A manual check of the deployed studio-pipeline: it reads the trunk, the status and the two portal services. It never starts a build
# (those cost money); start one from a stage page when you want the full path.
#
#   bash scripts/pipeline-smoke.sh
# Environment: PROJECT_ID, REGION, PIPELINE_SERVICE (default studio-pipeline); needs an authenticated gcloud.
set -euo pipefail

REGION="${REGION:-asia-southeast1}"
PIPELINE_SERVICE="${PIPELINE_SERVICE:-studio-pipeline}"
if [ -z "${PROJECT_ID:-}" ]; then
  echo "PROJECT_ID is not set; run deploy/gcp-setup.sh first or export it" >&2
  exit 1
fi
command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"

BASE="$(gcloud run services describe "$PIPELINE_SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
[ -n "$BASE" ] || { echo "$PIPELINE_SERVICE is not deployed" >&2; exit 1; }
# A human operator impersonates the pipeline's own service account: the service's verifier checks the token's audience and caller email.
SMOKE_SA="${SMOKE_SA:-pipeline-smoke@$PROJECT_ID.iam.gserviceaccount.com}"
TOKEN="$(gcloud auth print-identity-token --impersonate-service-account="$SMOKE_SA" --audiences="$BASE" --include-email 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "could not get an ID token; grant yourself roles/iam.serviceAccountTokenCreator on $SMOKE_SA" >&2
  exit 1
fi
echo "pipeline: $BASE"

get() { # get PATH
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl --config - -fsS --max-time 60 "$BASE$1"
}

echo "→ /health"
get /health | head -c 300; echo
echo "→ /v1/status"
get "/v1/status?uid=smoke" | head -c 400; echo
echo "→ /v1/repo"
REPO="$(get /v1/repo)"
node -e 'const d = JSON.parse(process.argv[1]); console.log(`${d.rev}, ${d.files.length} files`)' "$REPO" 2>/dev/null || echo "$REPO" | head -c 200
echo "→ /v1/environments"
get /v1/environments | head -c 600; echo
echo "ok"
