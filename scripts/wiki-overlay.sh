#!/usr/bin/env bash
# A PR carries its Wiki pages in a `wiki/` folder (#1026): flat `<Page>.md` files, reviewed with the
# code. The shared Wiki (`docs/wiki-pending`, else the published Wiki) holds only pages for code
# that is already on main, so a PR is checked against "the shared Wiki + this PR's own pages".
# `scripts/wiki-sync.sh` publishes the pages after the merge.
#
#   scripts/wiki-overlay.sh list [<base-rev>] [--worktree]
#       the pages (names, one per line) this branch adds or changes under wiki/ since
#       merge-base(<base-rev>, HEAD); default base: origin/main. A page that git would call a rename
#       (a change that deletes a similar wiki/ file) is a new page like any other (#1081).
#       CI passes HEAD^1: the checkout of a pull_request run is the merge commit, so HEAD^1 is main's
#       tip (on a push to main it is the previous main commit, so main's check overlays exactly the
#       commit that landed).
#       --worktree: the working tree's pages that differ from the merge base, committed or not (staged,
#       edited, and new untracked pages too): what `scripts/wiki.sh check` uses (#1082).
#   scripts/wiki-overlay.sh apply <wiki-dir> [<base-rev>] [--worktree]
#       copy those pages, as in HEAD's tree (--worktree: as in the working tree), over <wiki-dir>
#       (a Wiki checkout)
#
# Deletions under wiki/ are ignored; a path that is not a flat `*.md` page is an error.
# (Plain bash 3.2 on purpose: this runs on macOS too.)
set -euo pipefail

WORKTREE=0
ARGS=()
for arg in "$@"; do
  if [[ "${arg}" == "--worktree" ]]; then WORKTREE=1; else ARGS+=("${arg}"); fi
done
set -- ${ARGS[@]+"${ARGS[@]}"}

CMD="${1:-}"
case "${CMD}" in
  list) BASE="${2:-origin/main}" ;;
  apply) DEST="${2:?wiki directory required}"; BASE="${3:-origin/main}" ;;
  *) sed -n '2,21p' "$0"; exit 1 ;;
esac

MB="$(git merge-base "${BASE}" HEAD)"
# pages = added or modified files under wiki/ between the merge base and HEAD (or the working tree).
# --no-renames: a new page that git sees as a rename of a deleted wiki/ file is still an added page (#1081).
if [[ "${WORKTREE}" -eq 1 ]]; then
  cd "$(git rev-parse --show-toplevel)"
  PAGES="$( { git diff -z --no-renames --name-only --diff-filter=AM "${MB}" -- wiki/ &&
    git ls-files -z --others --exclude-standard -- wiki/; } | tr '\0' '\n' | sort -u)"
else
  PAGES="$(git diff -z --no-renames --name-only --diff-filter=AM "${MB}" HEAD -- wiki/ | tr '\0' '\n')"
fi

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
    if [[ "${WORKTREE}" -eq 1 ]]; then cp "${path}" "${DEST}/${name}"; else git show "HEAD:${path}" > "${DEST}/${name}"; fi
    echo "overlay: ${name}"
  fi
done <<< "${PAGES}"

if [[ "${CMD}" == "apply" && "${COUNT}" -eq 0 ]]; then echo "overlay: this change has no Wiki pages of its own"; fi
exit 0
