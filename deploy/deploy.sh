#!/usr/bin/env bash
# Build both images in Cloud Build and roll them out to Cloud Run: studio-agents (private) first, then studio-web (public).
#
#   bash deploy/deploy.sh --dry-run     print every command, call nothing
#   bash deploy/deploy.sh               build, deploy, grant, smoke-test, reseed the demo
#
# The source is a clean copy of the working tree (tracked plus untracked-but-not-ignored files), so git-ignored files such
# as src-tauri/google-client.json or .env* never leave this machine. Uncommitted changes ARE deployed.
# Options:
#   --dry-run | -n   print only
#   --yes | -y       skip the confirmation question
#   --skip-build     reuse images already in Artifact Registry (use --tag to name them)
#   --tag TAG        image tag (default: <timestamp>-<short commit>)
#   --no-reset       do not call POST /demo/reset at the end
#   --preview        deploy ONLY studio-web as a tagged revision that gets no traffic (https://preview---<service host>), with its own
#                    memory and no reset; the public site and studio-agents stay as they are. Move traffic when it looks right.
# Environment (optional): PROJECT_ID, REGION (from deploy/.env.gcp), GEMINI_MODEL, GEMINI_MODEL_FAST, GEMINI_MODEL_PRO,
#   EMBED_MODEL, AGENTS_DOCKERFILE (default agent-service/Dockerfile), AGENTS_CONTEXT (default agent-service),
#   DEMO_SEED (`demo-data`, the default, or `web`: which seeded workspace the demo opens), PIPELINE_ENABLED (0 or 1),
#   PIPELINE_SERVICE_URL (the private pipeline service, once it exists)
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SKIP_BUILD=0
DO_RESET=1
PREVIEW=0
TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run | -n) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-reset) DO_RESET=0 ;;
    --preview) PREVIEW=1; DO_RESET=0 ;;
    --tag) shift; TAG="${1:-}"; [ -n "$TAG" ] || die "--tag needs a value" ;;
    --help | -h) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

if [ "$DRY_RUN" = 0 ]; then need gcloud; need curl; fi
load_state
[ -n "${PROJECT_ID:-}" ] || die "PROJECT_ID is not set: run deploy/gcp-setup.sh first (it saves it in deploy/.env.gcp) or export PROJECT_ID"
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"

# Model ids live in the environment, not in code. These four were confirmed against this project in the `global` location
# during the spike (gemini-3.8-flash, gemini-3.1-pro-preview, gemini-3.5-flash-lite and gemini-embedding-001 at 768 dimensions;
# gemini-3.5-flash is the fallback when a model returns 429/503).
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.8-flash}"
GEMINI_MODEL_FAST="${GEMINI_MODEL_FAST:-gemini-3.5-flash-lite}"
GEMINI_MODEL_PRO="${GEMINI_MODEL_PRO:-gemini-3.1-pro-preview}"
GEMINI_MODEL_FALLBACK="${GEMINI_MODEL_FALLBACK:-gemini-3.5-flash}"
EMBED_MODEL="${EMBED_MODEL:-gemini-embedding-001}"

case "${DEMO_SEED:-demo-data}" in
  demo-data) DEMO_DATA_DIR_IN_IMAGE=/app/demo-data ;;
  web) DEMO_DATA_DIR_IN_IMAGE=/app/demo-data-web ;;
  *) die "DEMO_SEED must be demo-data or web" ;;
esac
PIPELINE_ENABLED="${PIPELINE_ENABLED:-0}"
PIPELINE_SERVICE_URL="${PIPELINE_SERVICE_URL:-}"

AGENTS_DOCKERFILE="${AGENTS_DOCKERFILE:-agent-service/Dockerfile}"
AGENTS_CONTEXT="${AGENTS_CONTEXT:-agent-service}"
WEB_DOCKERFILE=deploy/web/Dockerfile
WEB_CONTEXT=.

if [ -z "$TAG" ]; then
  TAG="$(date +%Y%m%d-%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
fi
IMAGE_BASE="$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO"
WEB_IMAGE="$IMAGE_BASE/web:$TAG"
AGENTS_IMAGE="$IMAGE_BASE/agents:$TAG"
PIPELINE_IMAGE="$IMAGE_BASE/pipeline:$TAG"
WEB_SA="$(sa_email "$WEB_SERVICE")"
AGENTS_SA="$(sa_email "$AGENTS_SERVICE")"
BUILD_SA_EMAIL="$(sa_email "$BUILD_SA")"

echo "Project   : $PROJECT_ID ($REGION)"
echo "Images    : $WEB_IMAGE"
echo "            $AGENTS_IMAGE"
[ "$PIPELINE_ENABLED" = 1 ] && echo "            $PIPELINE_IMAGE (pipeline)"
[ "$DRY_RUN" = 1 ] && echo "Mode      : DRY RUN, nothing is called"
echo

if [ "$DRY_RUN" = 0 ]; then
  [ -f "$ROOT/$WEB_DOCKERFILE" ] || die "missing $WEB_DOCKERFILE"
  [ -f "$ROOT/$AGENTS_DOCKERFILE" ] || die "missing $AGENTS_DOCKERFILE (the agent service is not in this checkout yet)"
elif [ ! -f "$ROOT/$AGENTS_DOCKERFILE" ]; then
  warn "$AGENTS_DOCKERFILE does not exist yet; a real run would stop here"
fi
if [ "$PREVIEW" = 1 ]; then
  confirm "This will build the web image and deploy ONLY a tagged studio-web revision that gets no traffic in $PROJECT_ID.
The public site and studio-agents stay as they are. It uses your uncommitted working tree."
else
  confirm "This will build two images and DEPLOY studio-agents (private) and studio-web (PUBLIC, open to the internet) in $PROJECT_ID.
It uses your uncommitted working tree."
fi

STAGE="<stage-dir>"
LOGDIR=""
cleanup() {
  if [ "$DRY_RUN" = 0 ]; then
    [ -n "$LOGDIR" ] && rm -rf "$LOGDIR"
    case "$STAGE" in "${TMPDIR:-/tmp}"/studio-build.*) rm -rf "$STAGE" ;; esac
  fi
}
trap cleanup EXIT

# 1. Source copy: tracked and untracked-but-not-ignored files only.
stage_source() {
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/studio-build.XXXXXX")"
  # The list is filtered for files deleted in the working tree, which git still lists while they are not staged for removal.
  (cd "$ROOT" && git ls-files -z --cached --others --exclude-standard) |
    while IFS= read -r -d '' file; do
      if [ -e "$ROOT/$file" ] || [ -L "$ROOT/$file" ]; then printf '%s\0' "$file"; fi
    done |
    (cd "$ROOT" && COPYFILE_DISABLE=1 tar -cf - --null -T -) |
    tar -xf - -C "$STAGE"
  local leaked
  leaked="$(find "$STAGE" \( -name google-client.json -o -name '.env' -o -name '.env.*' -o -name '*.tfstate' -o -name '*.pem' -o -name 'service-account*.json' \) ! -name '.env.example' -print | head -5)"
  [ -z "$leaked" ] || die "refusing to upload; sensitive-looking files are in the source copy: $leaked"
  note "source copy: $(find "$STAGE" -type f | wc -l | tr -d ' ') files in $STAGE"
}

build_image() { # build_image NAME IMAGE DOCKERFILE CONTEXT
  run gcloud builds submit "$STAGE" --project="$PROJECT_ID" --quiet \
    --config="$DEPLOY_DIR/cloudbuild.yaml" \
    --service-account="projects/$PROJECT_ID/serviceAccounts/$BUILD_SA_EMAIL" \
    --gcs-source-staging-dir="gs://${PROJECT_ID}_cloudbuild/source" \
    --substitutions="_IMAGE=$2,_DOCKERFILE=$3,_CONTEXT=$4"
}

if [ "$SKIP_BUILD" = 1 ]; then
  say "skipping the build (images must already exist with tag $TAG)"
else
  say "source copy"
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] copy 'git ls-files --cached --others --exclude-standard' into a temp dir and refuse if .env*, google-client.json, *.pem, *.tfstate are in it"
  else
    stage_source
  fi

  if [ "$PREVIEW" = 1 ]; then
    say "building the web image in Cloud Build"
    if [ "$DRY_RUN" = 0 ]; then LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/studio-logs.XXXXXX")"; fi
    build_image web "$WEB_IMAGE" "$WEB_DOCKERFILE" "$WEB_CONTEXT"
  else
  say "building web, agents and pipeline images in Cloud Build (in parallel)"
  if [ "$DRY_RUN" = 1 ]; then
    build_image web "$WEB_IMAGE" "$WEB_DOCKERFILE" "$WEB_CONTEXT"
    build_image agents "$AGENTS_IMAGE" "$AGENTS_DOCKERFILE" "$AGENTS_CONTEXT"
    [ "$PIPELINE_ENABLED" = 1 ] && build_image pipeline "$PIPELINE_IMAGE" pipeline-service/Dockerfile .
  else
    LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/studio-logs.XXXXXX")"
    (build_image web "$WEB_IMAGE" "$WEB_DOCKERFILE" "$WEB_CONTEXT") >"$LOGDIR/web.log" 2>&1 &
    web_pid=$!
    (build_image agents "$AGENTS_IMAGE" "$AGENTS_DOCKERFILE" "$AGENTS_CONTEXT") >"$LOGDIR/agents.log" 2>&1 &
    agents_pid=$!
    pipeline_pid=""
    if [ "$PIPELINE_ENABLED" = 1 ]; then
      (build_image pipeline "$PIPELINE_IMAGE" pipeline-service/Dockerfile .) >"$LOGDIR/pipeline.log" 2>&1 &
      pipeline_pid=$!
    fi
    failed=0
    for name in web agents pipeline; do
      pid="$web_pid"
      [ "$name" = agents ] && pid="$agents_pid"
      [ "$name" = pipeline ] && pid="$pipeline_pid"
      [ -n "$pid" ] || continue
      if wait "$pid"; then
        note "$name image built"
      else
        failed=1
        echo "---- $name build failed; last lines of its log ----" >&2
        tail -n 60 "$LOGDIR/$name.log" >&2
      fi
    done
    [ "$failed" = 0 ] || die "a build failed (see above)"
  fi
  fi
fi

# 2. studio-agents: private, scales to zero. Deployed first because studio-web needs its URL. (A preview leaves it as it is.)
if [ "$PREVIEW" = 0 ]; then
say "deploying $AGENTS_SERVICE (private)"
AGENTS_ENV="$(join_env \
  "GOOGLE_CLOUD_PROJECT=$PROJECT_ID" "GOOGLE_CLOUD_LOCATION=global" "GOOGLE_GENAI_USE_VERTEXAI=true" \
  "GEMINI_MODEL=$GEMINI_MODEL" "GEMINI_MODEL_FAST=$GEMINI_MODEL_FAST" "GEMINI_MODEL_PRO=$GEMINI_MODEL_PRO" \
  "GEMINI_MODEL_FALLBACK=$GEMINI_MODEL_FALLBACK" \
  "EMBED_MODEL=$EMBED_MODEL" "ALLOWED_CALLER=$WEB_SA" "AUTH_MODE=google" \
  "KNOWLEDGE_BACKEND=firestore" "MODEL_BACKEND=vertex" "THINKING_LEVEL=low" "TRACE_TO_CLOUD=true")"
run gcloud run deploy "$AGENTS_SERVICE" --project="$PROJECT_ID" --region="$REGION" --image="$AGENTS_IMAGE" \
  --service-account="$AGENTS_SA" --no-allow-unauthenticated \
  --min-instances=0 --max-instances=5 --concurrency=20 --timeout=900 --memory=1Gi --cpu=1 --cpu-boost \
  --set-env-vars="$AGENTS_ENV" --quiet
fi

say "reading the agents URL"
AGENTS_URL="$(capture gcloud run services describe "$AGENTS_SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
PROJECT_NUMBER="$(capture gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
if [ "$DRY_RUN" = 1 ]; then
  AGENTS_URL="https://$AGENTS_SERVICE-<PROJECT_NUMBER>.$REGION.run.app"
  PROJECT_NUMBER="<PROJECT_NUMBER>"
fi
[ -n "$AGENTS_URL" ] || die "could not read the URL of $AGENTS_SERVICE"
note "$AGENTS_URL"

# The service's own URL is the audience its callers' ID tokens carry, and Cloud Run only knows it after the first deploy.
# A second, small update sets it; without it the audience check inside the service would have nothing to compare against.
if [ "$PREVIEW" = 0 ]; then
say "setting SERVICE_URL on $AGENTS_SERVICE (the ID-token audience)"
run gcloud run services update "$AGENTS_SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --update-env-vars="$(join_env "SERVICE_URL=$AGENTS_URL")" --quiet
fi

# 2b. studio-pipeline: private, one instance at a time. The image is built above when PIPELINE_ENABLED=1; the deploy and the Pub/Sub
# subscriptions live in deploy/pipeline.sh so the pipeline can also be deployed on its own.
if [ "$PIPELINE_ENABLED" = 1 ] && [ "$PREVIEW" = 0 ]; then
  say "deploying $PIPELINE_SERVICE (private)"
  run bash "$DEPLOY_DIR/pipeline.sh" --skip-build --tag "$TAG" --yes
fi
if [ -z "$PIPELINE_SERVICE_URL" ] && [ "$PIPELINE_ENABLED" = 1 ]; then
  PIPELINE_SERVICE_URL="$(capture gcloud run services describe "$PIPELINE_SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
  if [ "$DRY_RUN" = 1 ]; then PIPELINE_SERVICE_URL="https://$PIPELINE_SERVICE-<PROJECT_NUMBER>.$REGION.run.app"; fi
  if [ -z "$PIPELINE_SERVICE_URL" ]; then
    warn "$PIPELINE_SERVICE is not deployed yet; studio-web will start without the pipeline"
  else
    note "pipeline: $PIPELINE_SERVICE_URL"
  fi
fi

# 3. studio-web: public, exactly one instance (the office rooms live in its memory). Cloud Run URLs are deterministic
# (https://SERVICE-PROJECTNUMBER.REGION.run.app), so the service can be told its own URL at deploy time.
WEB_URL_EXPECTED="https://$WEB_SERVICE-$PROJECT_NUMBER.$REGION.run.app"
ALLOWED_WEB_ORIGINS="$WEB_URL_EXPECTED"
PREVIEW_URL=""
PREVIEW_FLAGS=()
if [ "$PREVIEW" = 1 ]; then
  # The public address is read from the live service, so the preview talks to the same agents and shares the guest-token audience.
  WEB_URL_EXPECTED="$(capture gcloud run services describe "$WEB_SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
  if [ "$DRY_RUN" = 1 ]; then WEB_URL_EXPECTED="https://$WEB_SERVICE-<hash>-<region code>.a.run.app"; fi
  [ -n "$WEB_URL_EXPECTED" ] || die "$WEB_SERVICE is not deployed yet: deploy once without --preview first"
  PREVIEW_URL="https://preview---${WEB_URL_EXPECTED#https://}"
  ALLOWED_WEB_ORIGINS="$WEB_URL_EXPECTED,$PREVIEW_URL"
  PREVIEW_FLAGS=(--no-traffic --tag=preview)
fi
say "deploying $WEB_SERVICE (public$([ "$PREVIEW" = 1 ] && echo ', preview: no traffic'))"
WEB_ENV="$(join_env \
  "DEMO_MODE=1" "AGENT_SERVICE_URL=$AGENTS_URL" "AGENT_SERVICE_AUTH=google" "INTERNAL_CALLER=$AGENTS_SA" "PIPELINE_CALLER=$(sa_email "$PIPELINE_SA")" \
  "PUBLIC_URL=$WEB_URL_EXPECTED" "ALLOWED_ORIGINS=$ALLOWED_WEB_ORIGINS" "TEAM_STORE=memory" \
  "DEMO_DATA_DIR=$DEMO_DATA_DIR_IN_IMAGE" "PIPELINE_ENABLED=$PIPELINE_ENABLED" "PIPELINE_SERVICE_URL=$PIPELINE_SERVICE_URL" \
  "DEMO_RUNS_PER_GUEST_HOUR=20" "DEMO_RUNS_PER_DAY=1500")"
MIN_WEB_INSTANCES=1
[ "$PREVIEW" = 1 ] && MIN_WEB_INSTANCES=0
run gcloud run deploy "$WEB_SERVICE" --project="$PROJECT_ID" --region="$REGION" --image="$WEB_IMAGE" \
  --service-account="$WEB_SA" --allow-unauthenticated \
  --min-instances="$MIN_WEB_INSTANCES" --max-instances=1 --concurrency=250 --timeout=3600 --memory=512Mi --cpu=1 --cpu-boost \
  --cpu-throttling --session-affinity \
  --set-env-vars="$WEB_ENV" \
  --set-secrets="GUEST_JWT_SECRET=GUEST_JWT_SECRET:latest,DEMO_RESET_TOKEN=DEMO_RESET_TOKEN:latest" \
  ${PREVIEW_FLAGS[@]+"${PREVIEW_FLAGS[@]}"} --quiet

WEB_URL="$(capture gcloud run services describe "$WEB_SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
if [ "$DRY_RUN" = 1 ]; then WEB_URL="$WEB_URL_EXPECTED"; fi
[ -n "$WEB_URL" ] || die "could not read the URL of $WEB_SERVICE"
if [ "$PIPELINE_ENABLED" = 1 ] && [ "$PREVIEW" = 0 ] && [ -n "$PIPELINE_SERVICE_URL" ]; then
  # The pipeline tells the web service when a job or a rollout changed; it needs the web service's address to do it.
  say "pointing $PIPELINE_SERVICE at $WEB_SERVICE"
  run gcloud run services update "$PIPELINE_SERVICE" --project="$PROJECT_ID" --region="$REGION" --update-env-vars="$(join_env "WEB_SERVICE_URL=$WEB_URL")" --quiet
fi
if [ "$PREVIEW" = 0 ] && [ "$WEB_URL" != "$WEB_URL_EXPECTED" ]; then
  warn "the web URL is $WEB_URL, not the expected $WEB_URL_EXPECTED; updating PUBLIC_URL and ALLOWED_ORIGINS to match"
  run gcloud run services update "$WEB_SERVICE" --project="$PROJECT_ID" --region="$REGION" \
    --update-env-vars="$(join_env "PUBLIC_URL=$WEB_URL" "ALLOWED_ORIGINS=$WEB_URL")" --quiet
fi

# 4. studio-web may call the private agents service (its ID token is checked by Cloud Run itself).
say "granting run.invoker on $AGENTS_SERVICE to $WEB_SERVICE"
run gcloud run services add-iam-policy-binding "$AGENTS_SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --member="serviceAccount:$WEB_SA" --role=roles/run.invoker --format=none

# 5. Smoke tests. Tokens go to curl through its config on stdin, never through arguments or the terminal.
SMOKE_FAILED=0
CHECK_URL="$WEB_URL"
[ "$PREVIEW" = 1 ] && CHECK_URL="$PREVIEW_URL"
say "checking $CHECK_URL/health"
if [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] curl -fsS --retry 6 --retry-delay 5 --retry-all-errors --max-time 20 $CHECK_URL/health"
elif body="$(curl -fsS --retry 6 --retry-delay 5 --retry-all-errors --max-time 20 "$CHECK_URL/health")"; then
  note "web is up: ${body:0:200}"
else
  SMOKE_FAILED=1
  warn "web /health failed. Logs: gcloud run services logs read $WEB_SERVICE --region=$REGION --project=$PROJECT_ID --limit=50"
fi

say "checking $AGENTS_URL/health (private: with your own identity token)"
if [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] gcloud auth print-identity-token | curl --config - -fsS --retry 6 --retry-delay 5 --retry-all-errors --max-time 60 $AGENTS_URL/health"
else
  id_token="$(gcloud auth print-identity-token 2>/dev/null || true)"
  if [ -z "$id_token" ]; then
    SMOKE_FAILED=1
    warn "could not get an identity token (gcloud auth login). Alternative: gcloud run services proxy $AGENTS_SERVICE --region=$REGION --project=$PROJECT_ID --port=18080 and curl localhost:18080/health"
  elif body="$(printf 'header = "Authorization: Bearer %s"\n' "$id_token" |
    curl --config - -fsS --retry 6 --retry-delay 5 --retry-all-errors --max-time 60 "$AGENTS_URL/health")"; then
    note "agents are up: ${body:0:200}"
  else
    SMOKE_FAILED=1
    warn "agents /health failed (403 means your user lacks run.invoker on $AGENTS_SERVICE: gcloud run services add-iam-policy-binding $AGENTS_SERVICE --region=$REGION --member=user:<you> --role=roles/run.invoker). Logs: gcloud run services logs read $AGENTS_SERVICE --region=$REGION --project=$PROJECT_ID --limit=50"
  fi
  id_token=""
fi

# 6. Seed the demo workspace and trigger the knowledge reindex (the server does both on /demo/reset).
if [ "$DO_RESET" = 1 ]; then
  say "seeding the demo: POST $WEB_URL/demo/reset"
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] gcloud secrets versions access latest --secret=DEMO_RESET_TOKEN | curl --config - -sS -X POST -H 'content-type: application/json' -d '{}' $WEB_URL/demo/reset   (token read from Secret Manager, never printed)"
  else
    reset_token="$(gcloud secrets versions access latest --secret=DEMO_RESET_TOKEN --project="$PROJECT_ID" 2>/dev/null || true)"
    if [ -z "$reset_token" ]; then
      SMOKE_FAILED=1
      warn "could not read DEMO_RESET_TOKEN from Secret Manager; the demo was not reseeded"
    else
      reset_out="$(mktemp "${TMPDIR:-/tmp}/studio-reset.XXXXXX")"
      code="$(printf 'header = "x-reset-token: %s"\n' "$reset_token" |
        curl --config - -sS -X POST -H 'content-type: application/json' -d '{}' --max-time 180 \
          -o "$reset_out" -w '%{http_code}' "$WEB_URL/demo/reset" || true)"
      reset_token=""
      case "$code" in
        2*) note "demo reset: HTTP $code" ;;
        *) SMOKE_FAILED=1; warn "POST /demo/reset answered HTTP ${code:-none}: $(head -c 300 "$reset_out")" ;;
      esac
      rm -f "$reset_out"
    fi
  fi
fi

echo
print_warnings
if [ "$PREVIEW" = 1 ]; then
  echo "Preview URL (no traffic is sent to this revision; its memory and demo data are its own):"
  echo "$PREVIEW_URL"
  echo "Move traffic when it looks right:"
  echo "  gcloud run services update-traffic $WEB_SERVICE --region=$REGION --project=$PROJECT_ID --to-tags=preview=100"
else
  echo "Public URL:"
  echo "$WEB_URL"
fi
[ "$SMOKE_FAILED" = 0 ] || exit 1
