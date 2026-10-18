#!/usr/bin/env bash
# Builds the PUBLIC copy of this repository: a new folder with only the files git tracks, one commit, no history.
#
#   scripts/export-public.sh <target-dir> [--repo owner/name] [options]
#
# What it does, in order:
#   1. refuses a target that exists and is not empty (or sits inside this repo), and a working tree with uncommitted
#      or untracked files (commit first, or pass --allow-dirty: untracked files are NOT exported either way);
#   2. copies exactly `git ls-files`: git-ignored files such as src-tauri/google-client.json, node_modules or .env* are absent;
#   3. runs scripts/secret-scan.sh on the copy and stops, without committing, if it reports anything;
#   4. `git init -b main`, ONE commit "Initial commit" with this repo's configured git identity (name and e-mail become
#      public) and no trailers of any kind;
#   5. scans the new repository again and prints the identity, the commit and, with --repo, the `gh repo create` command.
# It never creates or pushes anything remote: the printed command is yours to run.
#
# Options: --repo owner/name        print the gh command for this GitHub repository
#          --allow-email ADDR       (repeatable; "*@domain" works) forwarded to secret-scan.sh
#          --allow-rule RULE[:PATH] (repeatable) forwarded to secret-scan.sh
#          --baseline FILE          findings you already reviewed (see secret-scan.sh --write-baseline)
#          --author-name N --author-email E   publish under this identity instead of the configured one
#          --allow-dirty            export tracked files even though the working tree has other changes
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN="$ROOT/scripts/secret-scan.sh"
TARGET=""
REPO_SLUG=""
ALLOW_DIRTY=0
AUTHOR_NAME=""
AUTHOR_EMAIL=""
SCAN_ARGS=()

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) shift; REPO_SLUG="${1:-}" ;;
    --allow-email | --allow-rule | --baseline) SCAN_ARGS+=("$1" "${2:-}"); shift ;;
    --author-name) shift; AUTHOR_NAME="${1:-}" ;;
    --author-email) shift; AUTHOR_EMAIL="${1:-}" ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option: $1" ;;
    *) [ -z "$TARGET" ] || die "only one target directory, got a second: $1"; TARGET="$1" ;;
  esac
  shift
done
[ -n "$TARGET" ] || { usage >&2; exit 2; }
if [ -n "$REPO_SLUG" ]; then
  [[ "$REPO_SLUG" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo must look like owner/name, got: $REPO_SLUG"
fi
for tool in git tar perl; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
[ -x "$SCAN" ] || [ -f "$SCAN" ] || die "missing $SCAN"
git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$ROOT is not a git repository"

# 1. Target and source checks.
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd -P)"
ROOT_REAL="$(cd "$ROOT" && pwd -P)"
case "$TARGET/" in "$ROOT_REAL"/*) die "the target must be outside this repository ($ROOT_REAL)" ;; esac
case "$ROOT_REAL/" in "$TARGET"/*) die "the target contains this repository" ;; esac
[ "$TARGET" != "/" ] && [ "$TARGET" != "$HOME" ] || die "refusing to use $TARGET as the target"
if [ -n "$(ls -A "$TARGET")" ]; then
  die "target is not empty: $TARGET (use a new or empty folder)"
fi

SUBMODULES="$(git -C "$ROOT" ls-files -s | awk '$1 == "160000"' | wc -l | tr -d ' ')"
[ "$SUBMODULES" = 0 ] || die "this repository has git submodules; export them by hand"

DIRTY="$(git -C "$ROOT" status --porcelain | wc -l | tr -d ' ')"
if [ "$DIRTY" != 0 ]; then
  echo "The working tree has $DIRTY uncommitted or untracked path(s):" >&2
  git -C "$ROOT" status --porcelain | head -12 >&2
  if [ "$ALLOW_DIRTY" = 0 ]; then
    rmdir "$TARGET" 2>/dev/null || true
    die "commit (or stash) first so the public copy contains what you intend, or pass --allow-dirty"
  fi
  echo "--allow-dirty: exporting the working-tree content of TRACKED files only (untracked files are left out)." >&2
fi

NAME="${AUTHOR_NAME:-$(git -C "$ROOT" config user.name || true)}"
EMAIL="${AUTHOR_EMAIL:-$(git -C "$ROOT" config user.email || true)}"
[ -n "$NAME" ] && [ -n "$EMAIL" ] || die "no git identity: set user.name and user.email in this repo, or pass --author-name and --author-email"

# 2. Copy exactly the tracked files.
echo "== copying tracked files into $TARGET =="
TOTAL="$(git -C "$ROOT" ls-files | wc -l | tr -d ' ')"
git -C "$ROOT" ls-files -z |
  while IFS= read -r -d '' file; do
    # A tracked file deleted in the working tree is skipped (only possible with --allow-dirty).
    if [ -e "$ROOT/$file" ] || [ -L "$ROOT/$file" ]; then printf '%s\0' "$file"; fi
  done |
  (cd "$ROOT" && COPYFILE_DISABLE=1 tar -cf - --null -T -) |
  tar -xf - -C "$TARGET"
COPIED="$(find "$TARGET" \( -type f -o -type l \) | wc -l | tr -d ' ')"
echo "  tracked: $TOTAL, copied: $COPIED, size: $(du -sh "$TARGET" | cut -f1)"
[ "$COPIED" -le "$TOTAL" ] || die "copied more files than git tracks ($COPIED > $TOTAL); something is wrong"
[ "$DIRTY" != 0 ] || [ "$COPIED" = "$TOTAL" ] || die "expected $TOTAL files but copied $COPIED"
for banned in src-tauri/google-client.json .env node_modules .git; do
  [ ! -e "$TARGET/$banned" ] || die "$banned is in the copy; stop and look at why it is tracked"
done
SYMLINKS="$(find "$TARGET" -type l | wc -l | tr -d ' ')"
[ "$SYMLINKS" = 0 ] || echo "  note: $SYMLINKS symbolic link(s) in the copy (they point to paths on this machine unless relative)"

# 3. Secret scan of the copy. Nothing is committed unless it passes.
echo
if ! bash "$SCAN" --tree "$TARGET" ${SCAN_ARGS[@]+"${SCAN_ARGS[@]}"}; then
  echo >&2
  echo "Stopped before committing. The copy is left in $TARGET for inspection; delete it when done." >&2
  echo "Fix or deliberately accept each finding (see scripts/secret-scan.sh --help), then run this script again with a fresh folder." >&2
  exit 1
fi

# 4. One commit under the configured identity, nothing else attached.
echo
echo "== creating the repository =="
git_clean() {
  GIT_AUTHOR_NAME="$NAME" GIT_AUTHOR_EMAIL="$EMAIL" GIT_COMMITTER_NAME="$NAME" GIT_COMMITTER_EMAIL="$EMAIL" \
    git -C "$TARGET" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c commit.template= "$@"
}
git -C "$TARGET" init -q -b main
git_clean add -A --force
STAGED="$(git -C "$TARGET" ls-files | wc -l | tr -d ' ')"
[ "$STAGED" = "$COPIED" ] || [ "$SYMLINKS" != 0 ] || die "git staged $STAGED of $COPIED files; a .gitignore in the copy hides some"
git_clean commit -q --no-verify --no-gpg-sign -m "Initial commit"

COMMITS="$(git -C "$TARGET" rev-list --all --count)"
MESSAGE="$(git -C "$TARGET" log -1 --format=%B)"
AUTHOR_OUT="$(git -C "$TARGET" log -1 --format='%an <%ae>')"
COMMITTER_OUT="$(git -C "$TARGET" log -1 --format='%cn <%ce>')"
[ "$COMMITS" = 1 ] || die "expected exactly one commit, found $COMMITS"
[ "$(printf '%s' "$MESSAGE" | tr -d '\n')" = "Initial commit" ] || die "the commit message is not exactly 'Initial commit' (a hook or template changed it)"
if printf '%s' "$MESSAGE" | grep -qiE '^[A-Za-z-]+:'; then die "the commit message carries a trailer"; fi
[ "$AUTHOR_OUT" = "$NAME <$EMAIL>" ] && [ "$COMMITTER_OUT" = "$NAME <$EMAIL>" ] || die "the commit identity is not the configured one"
[ -z "$(git -C "$TARGET" status --porcelain)" ] || die "the new repository is not clean after the commit"

# 5. Scan what was actually committed (content and history), then report.
echo
if ! bash "$SCAN" --repo "$TARGET" --no-gitleaks ${SCAN_ARGS[@]+"${SCAN_ARGS[@]}"}; then
  die "the committed repository fails the scan (it is local only, nothing was published): $TARGET"
fi

echo
echo "Done. Nothing was pushed and nothing was created on GitHub."
echo "  folder : $TARGET"
echo "  commit : $(git -C "$TARGET" rev-parse --short HEAD) \"Initial commit\" ($COMMITS commit, $STAGED files)"
echo "  public identity of the commit: $AUTHOR_OUT"
echo "     (this name and address will be visible on GitHub; use a ...@users.noreply.github.com address if you prefer)"
echo
if [ -n "$REPO_SLUG" ]; then
  echo "To publish, review the folder, then run (this creates a PUBLIC repository and pushes):"
  echo "  cd \"$TARGET\" && gh repo create $REPO_SLUG --public --source . --remote origin --push"
else
  echo "To publish, re-run with --repo owner/name to get the exact gh command, or:"
  echo "  cd \"$TARGET\" && gh repo create <owner>/<name> --public --source . --remote origin --push"
fi
