#!/usr/bin/env bash
# Docs live in the GitHub Wiki = a separate git repo <repo>.wiki.git.
# Its working copy sits next to the project: ../<project>.wiki (never inside the repo).
#
#   scripts/wiki.sh pull                  clone or update ../<project>.wiki
#   scripts/wiki.sh publish "<message>" [page…]
#                                         commit (only the given pages, when any) and push to the Wiki,
#                                         then fast-forward this repo's docs/wiki-pending to the same commit
#   scripts/wiki.sh seed <owner/repo>     copy another repo's wiki (e.g. the template) and publish
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
DIR="${ROOT}/../$(basename "${ROOT}").wiki"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
URL="https://github.com/${REPO}.wiki.git"
gh auth setup-git >/dev/null 2>&1 || true

first_page_hint() {
  echo "GitHub creates the wiki repo only after the first page is saved in the UI:" >&2
  echo "  open https://github.com/${REPO}/wiki/_new, save any page, then rerun this command." >&2
  exit 1
}

case "${1:-}" in
  pull)
    if [[ -d "${DIR}/.git" ]]; then
      git -C "${DIR}" pull --ff-only
    else
      git clone -q "${URL}" "${DIR}" || first_page_hint
    fi
    ;;
  publish)
    MESSAGE="${2:?commit message required, e.g. 'docs(#12): update Routers'}"
    if [[ ! -d "${DIR}/.git" ]]; then
      git -C "${DIR}" init -q -b master
      git -C "${DIR}" remote add origin "${URL}"
    fi
    shift 2
    # pages given → only those are committed (the shared checkout may hold other agents' edits)
    if [[ $# -gt 0 ]]; then git -C "${DIR}" add -- "$@"; else git -C "${DIR}" add -A; fi
    git -C "${DIR}" diff --cached --quiet || git -C "${DIR}" commit -q -m "${MESSAGE}"
    # Never synced with the remote yet → our history replaces the placeholder page from the UI.
    PUSH_ARGS=(origin HEAD:master)
    git -C "${DIR}" rev-parse -q --verify refs/remotes/origin/master >/dev/null || PUSH_ARGS=(--force "${PUSH_ARGS[@]}")
    git -C "${DIR}" push -q "${PUSH_ARGS[@]}" || first_page_hint
    git -C "${DIR}" fetch -q origin master
    # keep docs/wiki-pending equal to the Wiki, so Sync Wiki finds nothing diverged (fast-forward only)
    git -C "${DIR}" push -q "https://github.com/${REPO}.git" HEAD:refs/heads/docs/wiki-pending ||
      echo "warning: docs/wiki-pending not fast-forwarded (it holds pages not in the Wiki yet); Sync Wiki will report the divergence" >&2
    echo "Wiki published: https://github.com/${REPO}/wiki"
    ;;
  seed)
    SOURCE="${2:?source repo required, e.g. agbossjs/agboss}"
    TMP="$(mktemp -d)"
    git clone -q "https://github.com/${SOURCE}.wiki.git" "${TMP}"
    rm -rf "${DIR}" && mkdir -p "${DIR}"
    rsync -a --exclude .git "${TMP}/" "${DIR}/" && rm -rf "${TMP}"
    exec "$0" publish "docs: seed wiki from ${SOURCE}"
    ;;
  *)
    sed -n '2,8p' "$0" && exit 1
    ;;
esac
