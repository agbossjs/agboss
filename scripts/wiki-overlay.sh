#!/usr/bin/env bash
# A PR carries its Wiki pages in a `wiki/` folder (#1026): flat `<Page>.md` files, reviewed with the
# code. The shared Wiki (`docs/wiki-pending`, else the published Wiki) holds only pages for code
# that is already on main, so a PR is checked against "the shared Wiki + this PR's own pages".
# `scripts/wiki-sync.sh` publishes the pages after the merge.
#
#   scripts/wiki-overlay.sh list [<base-rev>]
#       the pages (names, one per line) this branch adds or changes under wiki/ since
#       merge-base(<base-rev>, HEAD); default base: origin/main. CI passes HEAD^1: the checkout of a
#       pull_request run is the merge commit, so HEAD^1 is main's tip (on a push to main it is the
#       previous main commit, so main's check overlays exactly the commit that landed).
#   scripts/wiki-overlay.sh apply <wiki-dir> [<base-rev>]
#       copy those pages, as in HEAD's tree, over <wiki-dir> (a Wiki checkout)
#
# Deletions under wiki/ are ignored; a path that is not a flat `*.md` page is an error.
# (Plain bash 3.2 on purpose: this runs on macOS too.)
set -euo pipefail

CMD="${1:-}"
case "${CMD}" in
  list) BASE="${2:-origin/main}" ;;
  apply) DEST="${2:?wiki directory required}"; BASE="${3:-origin/main}" ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac

MB="$(git merge-base "${BASE}" HEAD)"
# pages = added or modified files under wiki/ between the merge base and HEAD
PAGES="$(git diff -z --name-only --diff-filter=AM "${MB}" HEAD -- wiki/ | tr '\0' '\n')"

COUNT=0
while IFS= read -r path; do
  [[ -n "${path}" ]] || continue
  name="${path#wiki/}"
  if [[ "${name}" == */* || "${name}" != *.md || "${name}" == .* ]]; then
    echo "::error::${path}: only flat wiki/<Page>.md files are published (no folders, no other file types)" >&2
    exit 1
  fi
  COUNT=$((COUNT + 1))
  if [[ "${CMD}" == "list" ]]; then
    echo "${name}"
  else
    git show "HEAD:${path}" > "${DEST}/${name}"
    echo "overlay: ${name}"
  fi
done <<< "${PAGES}"

if [[ "${CMD}" == "apply" && "${COUNT}" -eq 0 ]]; then echo "overlay: this change has no Wiki pages of its own"; fi
exit 0
