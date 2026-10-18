#!/usr/bin/env bash
# Cloud Scheduler job `demo-reset`: every day at 03:00 Asia/Singapore it POSTs {studio-web}/demo/reset, which puts the demo
# workspace back to its seed and reindexes the knowledge base. The shared secret travels in the `x-reset-token` header; it
# is read from Secret Manager when the job is created, written to a private temp file for gcloud (never an argument,
# never printed) and removed again. Re-run after rotating DEMO_RESET_TOKEN so the job picks up the new value.
#
#   bash deploy/scheduler.sh --dry-run
#   bash deploy/scheduler.sh               create or update the job
#   bash deploy/scheduler.sh --run-now     also trigger it once right away
# Options: --dry-run | -n   --yes | -y   --run-now   --help
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

JOB=demo-reset
SCHEDULE="0 3 * * *"
TIME_ZONE="Asia/Singapore"
RUN_NOW=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run | -n) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --run-now) RUN_NOW=1 ;;
    --help | -h) sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

if [ "$DRY_RUN" = 0 ]; then need gcloud; fi
load_state
[ -n "${PROJECT_ID:-}" ] || die "PROJECT_ID is not set: run deploy/gcp-setup.sh first or export PROJECT_ID"
export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"

WEB_URL="$(capture gcloud run services describe "$WEB_SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
if [ "$DRY_RUN" = 1 ]; then WEB_URL="https://$WEB_SERVICE-<PROJECT_NUMBER>.$REGION.run.app"; fi
[ -n "$WEB_URL" ] || die "$WEB_SERVICE is not deployed yet: run deploy/deploy.sh first"
TARGET="$WEB_URL/demo/reset"

echo "Project  : $PROJECT_ID ($REGION)"
echo "Job      : $JOB, '$SCHEDULE' $TIME_ZONE"
echo "Target   : POST $TARGET"
[ "$DRY_RUN" = 1 ] && echo "Mode     : DRY RUN, nothing is called"
echo
confirm "This will create or update the Cloud Scheduler job '$JOB' in $PROJECT_ID."

if probe gcloud scheduler jobs describe "$JOB" --location="$REGION" --project="$PROJECT_ID"; then
  verb=update
  header_flag=--update-headers
else
  verb=create
  header_flag=--headers
fi

if [ "$DRY_RUN" = 1 ]; then
  say "$verb job $JOB"
  note "[dry-run] token = gcloud secrets versions access latest --secret=DEMO_RESET_TOKEN (kept in a mode-600 temp flags file, never printed)"
  note "[dry-run] if the job already exists, 'jobs update http' with --update-headers is used instead"
  run gcloud scheduler jobs create http "$JOB" --location="$REGION" --project="$PROJECT_ID" \
    --schedule="$SCHEDULE" --time-zone="$TIME_ZONE" --uri="$TARGET" --http-method=POST \
    --message-body='{}' --attempt-deadline=180s --max-retry-attempts=2 \
    --headers='x-reset-token=<from Secret Manager>,content-type=application/json'
  if [ "$RUN_NOW" = 1 ]; then run gcloud scheduler jobs run "$JOB" --location="$REGION" --project="$PROJECT_ID"; fi
  exit 0
fi

say "$verb job $JOB"
token="$(gcloud secrets versions access latest --secret=DEMO_RESET_TOKEN --project="$PROJECT_ID")"
[ -n "$token" ] || die "DEMO_RESET_TOKEN is empty or unreadable"
flags_file="$(umask 077 && mktemp "${TMPDIR:-/tmp}/studio-scheduler.XXXXXX")"
trap 'rm -f "$flags_file"' EXIT
# gcloud reads these flags from the file; the token is not in any process argument.
printf '%s:\n  x-reset-token: "%s"\n  content-type: application/json\n' "$header_flag" "$token" >"$flags_file"
token=""

if [ "$verb" = create ]; then
  gcloud scheduler jobs create http "$JOB" --location="$REGION" --project="$PROJECT_ID" \
    --schedule="$SCHEDULE" --time-zone="$TIME_ZONE" --uri="$TARGET" --http-method=POST \
    --message-body='{}' --attempt-deadline=180s --max-retry-attempts=2 --flags-file="$flags_file"
else
  gcloud scheduler jobs update http "$JOB" --location="$REGION" --project="$PROJECT_ID" \
    --schedule="$SCHEDULE" --time-zone="$TIME_ZONE" --uri="$TARGET" --http-method=POST \
    --message-body='{}' --attempt-deadline=180s --max-retry-attempts=2 --flags-file="$flags_file"
fi

if [ "$RUN_NOW" = 1 ]; then
  say "running the job once"
  run gcloud scheduler jobs run "$JOB" --location="$REGION" --project="$PROJECT_ID"
fi
echo
echo "Job $JOB is set. Check it: gcloud scheduler jobs describe $JOB --location=$REGION --project=$PROJECT_ID"
