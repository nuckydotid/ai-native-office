#!/usr/bin/env bash
# The sample app's hermetic test run. It is the same on a laptop, in Cloud Build and in the pipeline service:
#   bash ci/hermetic-test.sh all | build | unit | e2e
# It prints one machine-readable line at the end, which the pipeline service reads from the build log:
#   PIPELINE_RESULT: {"ok":true,"kind":"all","passed":12,"failed":0,"coveragePct":92.4}
# It never needs the network: the deps image already has node_modules and Chromium.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MODE="${1:-all}"
case "$MODE" in all | build | unit | e2e) ;; *) echo "usage: $0 all|build|unit|e2e" >&2; exit 2 ;; esac

FINISHED=0
cleanup() {
  local code=$?
  if [ "$FINISHED" = 0 ]; then
    node -e 'process.stdout.write(`PIPELINE_RESULT: ${JSON.stringify({ok:false,kind:process.argv[1]})}\n`)' "$MODE"
  fi
  exit "$code"
}
trap cleanup EXIT

echo "→ typecheck"
npm run typecheck

echo "→ lint"
npm run lint

echo "→ build"
npm run build

if [ "$MODE" = "unit" ] || [ "$MODE" = "all" ]; then
  echo "→ unit tests with coverage"
  npm run test:coverage
fi

if [ "$MODE" = "e2e" ] || [ "$MODE" = "all" ]; then
  echo "→ end-to-end tests"
  npm run e2e
fi

FINISHED=1
node ci/result.mjs "$MODE"
