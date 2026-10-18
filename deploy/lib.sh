#!/usr/bin/env bash
# Shared helpers for deploy/*.sh. Source it; do not run it. Plain bash 3.2 (macOS) compatible.
# shellcheck shell=bash

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
STATE_FILE="${DEPLOY_STATE_FILE:-$DEPLOY_DIR/.env.gcp}"

# Fixed names shared by every script (change them here, nowhere else).
REGION_FROM_ENV=0
[ -n "${REGION:-}" ] && REGION_FROM_ENV=1
REGION="${REGION:-asia-southeast1}"
WEB_SERVICE=studio-web
AGENTS_SERVICE=studio-agents
PIPELINE_SERVICE=studio-pipeline
BUILD_SA=studio-build
PIPELINE_SA=studio-pipeline
PIPELINE_BUILD_SA=pipeline-build
PIPELINE_EVENTS_SA=pipeline-events
NORTHWIND_RUNTIME_SA=northwind-runtime
AR_REPO=studio
NORTHWIND_AR_REPO=northwind
PIPELINE_BUCKET_SUFFIX=-pipeline
SECRET_NAMES="GUEST_JWT_SECRET DEMO_RESET_TOKEN"

DRY_RUN=0
ASSUME_YES=0
WARNINGS=""

say()  { printf '→ %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; WARNINGS="${WARNINGS}  - $*"$'\n'; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

# Prints one argument the way a person would type it: bare when safe, single-quoted otherwise (--flag='a b').
quote_arg() {
  local arg="$1" prefix=''
  case "$arg" in --*=*) prefix="${arg%%=*}="; arg="${arg#*=}" ;; esac
  if [ -z "$arg" ] || [[ "$arg" =~ [^A-Za-z0-9_./:=@%+,-] ]]; then
    arg="'$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")'"
  fi
  printf '%s%s' "$prefix" "$arg"
}

# Prints the arguments as one copy-pasteable shell command.
quote_cmd() {
  local out='' arg
  for arg in "$@"; do out="$out$(quote_arg "$arg") "; done
  printf '%s' "${out% }"
}

# run CMD...: execute it, or only print it under --dry-run. Never pass a secret as an argument.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] %s\n' "$(quote_cmd "$@")"
    return 0
  fi
  printf '  $ %s\n' "$(quote_cmd "$@")"
  "$@"
}

# probe CMD...: read-only existence check, exit status only. Under --dry-run nothing is called and the thing is
# assumed missing, so the dry run shows the whole creation path.
probe() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] check %s -> assumed missing\n' "$(quote_cmd "$@")"
    return 1
  fi
  "$@" >/dev/null 2>&1
}

# capture CMD...: read-only, prints stdout (empty on failure). Under --dry-run prints nothing but a note on stderr.
capture() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] read %s\n' "$(quote_cmd "$@")" >&2
    return 0
  fi
  "$@" 2>/dev/null || true
}

# retry TRIES DELAY CMD...: Google APIs need a moment after being enabled and IAM is eventually consistent.
retry() {
  local tries="$1" delay="$2" n=1
  shift 2
  if [ "$DRY_RUN" = 1 ]; then
    run "$@"
    return 0
  fi
  until run "$@"; do
    [ "$n" -lt "$tries" ] || return 1
    n=$((n + 1))
    note "retrying in ${delay}s ($n/$tries)"
    sleep "$delay"
  done
}

# retry_fn TRIES DELAY FUNCTION ARGS...: like retry, for shell functions that print their own dry-run line.
retry_fn() {
  local tries="$1" delay="$2" n=1
  shift 2
  until "$@"; do
    [ "$n" -lt "$tries" ] || return 1
    n=$((n + 1))
    note "retrying in ${delay}s ($n/$tries)"
    sleep "$delay"
  done
}

sa_email() { printf '%s@%s.iam.gserviceaccount.com' "$1" "$PROJECT_ID"; }

# Reads the few non-secret settings gcp-setup.sh saved. Variables already in the environment win.
load_state() {
  [ -f "$STATE_FILE" ] || return 0
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      PROJECT_ID) [ -n "${PROJECT_ID:-}" ] || export PROJECT_ID="$value" ;;
      REGION) [ "$REGION_FROM_ENV" = 1 ] || export REGION="$value" ;;
    esac
  done <"$STATE_FILE"
}

save_state() {
  if [ "$DRY_RUN" = 1 ]; then
    note "(dry-run) would write $STATE_FILE with PROJECT_ID=$PROJECT_ID REGION=$REGION"
    return 0
  fi
  (
    umask 077
    printf '# Written by deploy/gcp-setup.sh. Not a secret, but local to this checkout (git-ignored).\nPROJECT_ID=%s\nREGION=%s\n' "$PROJECT_ID" "$REGION" >"$STATE_FILE"
  )
}

# confirm "what is about to happen": asks on the terminal unless --yes. Never used under --dry-run.
confirm() {
  [ "$DRY_RUN" = 1 ] && return 0
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -r /dev/tty ] || die "no terminal to ask on; re-run with --yes to confirm: $1"
  printf '\n%s\nType "yes" to continue: ' "$1" >/dev/tty
  local answer=''
  read -r answer </dev/tty || true
  [ "$answer" = yes ] || die "aborted"
}

# Joins KEY=VALUE pairs for `gcloud run deploy --set-env-vars`, with "|" as the delimiter so values may contain commas.
# ("@" cannot be the delimiter: service-account emails are values and contain it, and gcloud then mis-splits them.)
join_env() {
  local out='' pair
  for pair in "$@"; do out="${out}|${pair}"; done
  printf '^|^%s' "${out#|}"
}

print_warnings() {
  [ -z "$WARNINGS" ] && return 0
  printf '\nThings to look at:\n%s' "$WARNINGS" >&2
}
