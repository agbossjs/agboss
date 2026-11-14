#!/usr/bin/env bash
# Publishes the Wiki pages of merged PRs (#1026) — what `.github/workflows/sync-wiki.yml` runs once
# main's CI has passed. A PR carries its pages in a `wiki/` folder; here, after the merge, they
# are written to the Wiki's `master` and `docs/wiki-pending` is fast-forwarded to the same commit.
#
# Run from a full-history checkout of main. Environment:
#   WIKI_URL   the Wiki repo (…/<repo>.wiki.git, with credentials)
#   REPO_URL   this repository (…/<repo>.git, with credentials): holds the branch docs/wiki-pending
#   UPTO       the main commit to publish up to (default HEAD: the commit CI passed on)
#
# Exactly once, with no need to empty `wiki/`: a Wiki commit that publishes a main commit's pages
# carries the trailer `Wiki-Overlay-Source: <main sha>`. The newest such trailer in the Wiki's
# history says "published up to here"; the first-parent commits after it, oldest first, each add a
# Wiki commit with the files they added or changed under `wiki/` (an empty marker commit when the
# Wiki already holds them). Both pushes are fast-forward only; a rerun finds the marker and does
# nothing; a crash between the two pushes is completed by the next run. No marker yet → start at
# the commit that added this script.
#
# The base is the Wiki's `master` or `docs/wiki-pending`, whichever contains the other (a direct
# `scripts/wiki.sh publish` moves both); diverged → stop, never force (a page edited in the Wiki's
# web UI and missing from the branch is not lost).
#
# A push the remote refuses because it moved meanwhile (a direct publish, another Sync) is retried:
# fetch again, overlay again, push — at most 5 attempts (WIKI_SYNC_ATTEMPTS), a short backoff
# (WIKI_SYNC_BACKOFF seconds x attempt, default 3), never --force. Other failures are not retried.
# WIKI_SYNC_BEFORE_PUSH: a command run right before each push (a test seam: it plays the publisher
# that wins the race).
# (Plain bash 3.2 on purpose: the tests run it on macOS too.)
set -euo pipefail

if [[ -z "${WIKI_SYNC_INNER:-}" ]]; then
  MAX="${WIKI_SYNC_ATTEMPTS:-5}"
  for ((attempt = 1; attempt <= MAX; attempt++)); do
    status=0
    WIKI_SYNC_INNER=1 "$0" || status=$?
    [[ "${status}" -eq 75 ]] || exit "${status}"
    echo "The Wiki moved while publishing (attempt ${attempt} of ${MAX}); retrying from its new state."
    [[ "${attempt}" -lt "${MAX}" ]] && sleep $((attempt * ${WIKI_SYNC_BACKOFF:-3}))
  done
  echo "::error::The Wiki kept moving: ${MAX} attempts, nothing was forced; rerun Sync Wiki."
  exit 1
fi

: "${WIKI_URL:?}" "${REPO_URL:?}"
CODE="$(pwd)"
UPTO="$(git rev-parse "${UPTO:-HEAD}^{commit}")"
BOT_NAME="${WIKI_BOT_NAME:-github-actions[bot]}"
BOT_EMAIL="${WIKI_BOT_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
EMPTY_TREE="$(git hash-object -t tree /dev/null)"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
w() { git -C "${WORK}" "$@"; }
c() { git -C "${CODE}" "$@"; }
w init -q
w fetch -q "${WIKI_URL}" master:refs/remotes/wiki/master
HAVE_PENDING=0
if git ls-remote --exit-code --heads "${REPO_URL}" docs/wiki-pending > /dev/null 2>&1; then
  w fetch -q "${REPO_URL}" docs/wiki-pending:refs/remotes/pending/head
  HAVE_PENDING=1
fi

# the base: the one of the two that contains the other
BASE=refs/remotes/wiki/master
if [[ "${HAVE_PENDING}" -eq 1 ]] && ! w merge-base --is-ancestor refs/remotes/pending/head refs/remotes/wiki/master; then
  if w merge-base --is-ancestor refs/remotes/wiki/master refs/remotes/pending/head; then
    BASE=refs/remotes/pending/head
  else
    echo "::error::The Wiki's master and docs/wiki-pending diverged; merge the Wiki's commits into docs/wiki-pending (never force):"
    w log --oneline refs/remotes/pending/head..refs/remotes/wiki/master
    exit 1
  fi
fi

# where the last run stopped
MARKER="$(w log -1 --format='%(trailers:key=Wiki-Overlay-Source,valueonly)' --grep='^Wiki-Overlay-Source: ' "${BASE}" | tr -d '[:space:]')"
STARTED=1
INTRO=""
if [[ -n "${MARKER}" ]]; then
  c cat-file -e "${MARKER}^{commit}" 2> /dev/null || { echo "::error::Wiki-Overlay-Source ${MARKER} is not in this checkout (fetch the full history of main)"; exit 1; }
  if c merge-base --is-ancestor "${UPTO}" "${MARKER}"; then
    UPTO="${MARKER}" # CI of an older commit finished after a newer one was published: nothing to add
  elif ! c merge-base --is-ancestor "${MARKER}" "${UPTO}"; then
    echo "::error::Wiki-Overlay-Source ${MARKER} is not an ancestor of ${UPTO}; refusing to guess"
    exit 1
  fi
  RANGE="${MARKER}..${UPTO}"
else
  INTRO="$(c log --first-parent --diff-filter=A --format=%H "${UPTO}" -- scripts/wiki-sync.sh | tail -n 1)"
  [[ -n "${INTRO}" ]] || { echo "::error::scripts/wiki-sync.sh is not in the first-parent history of ${UPTO}"; exit 1; }
  STARTED=0
  RANGE="${UPTO}"
fi

w checkout -q --detach "${BASE}"
PUBLISHED=0
while IFS= read -r sha; do
  [[ -n "${sha}" ]] || continue
  if [[ "${STARTED}" -eq 0 ]]; then
    [[ "${sha}" == "${INTRO}" ]] || continue
    STARTED=1
  fi
  PARENT="$(c rev-parse -q --verify "${sha}^1" 2> /dev/null || echo "${EMPTY_TREE}")"
  PAGES="$(c diff -z --name-only --diff-filter=AM "${PARENT}" "${sha}" -- wiki/ | tr '\0' '\n')"
  [[ -n "${PAGES}" ]] || continue
  NAMES=()
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    name="${path#wiki/}"
    if [[ "${name}" == */* || "${name}" != *.md || "${name}" == .* ]]; then
      echo "::error::${sha}: ${path} is not a flat wiki/<Page>.md page"
      exit 1
    fi
    c show "${sha}:${path}" > "${WORK}/${name}"
    NAMES+=("${name}")
  done <<< "${PAGES}"
  w add -- "${NAMES[@]}"
  SUBJECT="$(c log -1 --format=%s "${sha}")"
  LIST="$(printf '%s\n' "${NAMES[@]}")"
  w -c user.name="${BOT_NAME}" -c user.email="${BOT_EMAIL}" commit -q --allow-empty \
    -m "docs: ${SUBJECT}" -m "Wiki pages of $(c rev-parse --short "${sha}"):
${LIST}" -m "Wiki-Overlay-Source: ${sha}"
  echo "Published the Wiki pages of $(c rev-parse --short "${sha}"): ${NAMES[*]}"
  PUBLISHED=$((PUBLISHED + 1))
done < <(c rev-list --first-parent --reverse "${RANGE}")
[[ "${STARTED}" -eq 1 ]] || { echo "::error::${INTRO} is not on the first-parent history"; exit 1; }

NEW="$(w rev-parse HEAD)"
# a push the remote refused because its ref moved → 75 (the outer loop retries); anything else fails
push() {
  local out
  [[ -z "${WIKI_SYNC_BEFORE_PUSH:-}" ]] || sh -c "${WIKI_SYNC_BEFORE_PUSH}" > /dev/null
  if out="$(w push -q "$1" "${NEW}:$2" 2>&1)"; then return 0; fi
  echo "${out}" >&2
  if [[ "${out}" == *"fetch first"* || "${out}" == *"non-fast-forward"* || "${out}" == *"failed to update ref"* || "${out}" == *"cannot lock ref"* ]]; then exit 75; fi
  exit 1
}
PUSHED=0
if ! w merge-base --is-ancestor "${NEW}" refs/remotes/wiki/master; then
  push "${WIKI_URL}" refs/heads/master
  PUSHED=1
fi
if [[ "${HAVE_PENDING}" -eq 1 ]] && [[ "$(w rev-parse refs/remotes/pending/head)" != "${NEW}" ]]; then
  push "${REPO_URL}" refs/heads/docs/wiki-pending
  PUSHED=1
fi
if [[ "${PUSHED}" -eq 0 ]]; then
  echo "The Wiki already contains docs/wiki-pending and every merged page (${NEW:0:7}); nothing to publish."
fi
