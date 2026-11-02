# AGBoss release runbook — the train (from `0.1.1`)

> **Embargo:** no automation or AI agent publishes to npm, pushes a release tag, creates a GitHub
> Release or switches `agboss.dev` to a new published version. Every step marked
> **⚠️ [PUBLIC / IRREVERSIBLE]** is run by the maintainer, by hand. Everything before them is
> prepared so that each is one command.

A release is a **train** of packages, one version for all, published in this order — each car only
once the one before is on npm (#691):

| #   | Repository          | Tag               | Publishes                          | Rides on                                |
| --- | ------------------- | ----------------- | ---------------------------------- | --------------------------------------- |
| 1   | `agbossjs/agboss`   | `vX.Y.Z`          | `@agboss/core`, then `@agboss/cli` | —                                       |
| 2   | `agbossjs/postgres` | `postgres-vX.Y.Z` | `@agboss/postgres`                 | `@agboss/core@X.Y.Z` from npm (its pin) |
| 3   | `agbossjs/mongodb`  | `mongodb-vX.Y.Z`  | `@agboss/mongodb`                  | `@agboss/core@X.Y.Z` from npm (its pin) |
| 4   | `agbossjs/redis`    | `redis-vX.Y.Z`    | `@agboss/redis`                    | `@agboss/core@X.Y.Z` from npm (its pin) |

Each repository's `.github/workflows/release.yml` publishes on its own tag with
`npm publish --provenance --access public`, and refuses — publishing nothing — when the tag is not
the package's version, the commit is not on `main`, or that repository's CI did not pass on a push of
that exact commit (`scripts/release/ci-gate.mjs` waits while it runs). A car after the core also
refuses unless its `.agboss-version.json` takes the core **from the registry** (`"source":
"registry"`) at a version on npm, the one its peer dependency names (`^X.Y.Z`): it was built and
tested on exactly what users install. A re-run is safe: a version already on npm from the same
commit is left alone, from another commit the run fails. Every pull request that touches a release
workflow runs its dry run (`npm publish --dry-run`), and **Actions → Release → Run workflow** runs it
by hand; neither ever publishes.

Cars 1 and 2 have the workflow today. agbossjs/mongodb and agbossjs/redis
ride once their repository has copied agbossjs/postgres's release path —
`.github/workflows/release.yml`, `scripts/release/release-plan.mjs` and `ci-gate.mjs` (the tag
prefix comes from the package's name), `scripts/pin-framework.mjs` and the registry mode of
`scripts/pack-framework.mjs` — and its 0.1.1 issues are done; a car that is not ready waits for the
next release, it never holds the train.

All commands start with `set -euo pipefail` and use `$WORKSPACE_ROOT`, the folder holding the
clones; scratch work goes under `worktrees.noindex`:

```bash
set -euo pipefail
export WORKSPACE_ROOT="/Users/pavelravvich/projects/agboss"
export RELEASE_VERSION="0.1.1"
export SCRATCH="$WORKSPACE_ROOT/worktrees.noindex/release-$RELEASE_VERSION"
mkdir -p "$SCRATCH"
```

---

## Step 0 — Once per repository: the `npm` environment and its secret

The publish job runs in a GitHub environment named `npm`; its secret `NPM_TOKEN` is the only
credential that can publish.

1. **An npm token.** On npmjs.com (account of a maintainer of the `@agboss` scope, 2FA on): Access
   Tokens → Generate New Token → **Granular Access Token**, permission **Read and write** on the
   **`@agboss` scope** (not on single packages: `@agboss/postgres`, `@agboss/mongodb`,
   `@agboss/redis` do not exist yet, and a token limited to packages cannot
   create them), expiry as short as the release needs (e.g. 7 days). Publishing from CI must not ask
   for an OTP, so the token must be allowed to publish without one.
2. **The environment, per repository** (agbossjs/agboss, agbossjs/postgres, and each later car):
   Settings → Environments → New environment `npm`; **Required reviewers**: the maintainer (each
   publish waits for an approval click); **Deployment branches and tags**: Selected — the tag pattern
   of that repository (`v*`, `postgres-v*`, …).
3. **The secret:**

   ```bash
   set -euo pipefail
   gh secret set NPM_TOKEN --env npm -R agbossjs/agboss      # paste the token when asked
   gh secret set NPM_TOKEN --env npm -R agbossjs/postgres
   gh secret list --env npm -R agbossjs/agboss && gh secret list --env npm -R agbossjs/postgres
   ```

- **Expected:** both listings show `NPM_TOKEN`. Revoke the token on npmjs.com after the train.
- **Stop if** the environment cannot be restricted to the tag pattern.

## Step 1 — Every issue of the release is done

```bash
set -euo pipefail
gh issue list -R agbossjs/agboss --milestone "$RELEASE_VERSION" --state open
gh pr list -R agbossjs/agboss --state open && gh pr list -R agbossjs/postgres --state open
```

- **Expected:** nothing open that the maintainer has not deferred to the next milestone.

## Step 2 — The release-prep PRs: versions and changelogs, merged last

The version bump waits on its branch until everything else is on `main` (#691): `chore/691-version-<version>`
in agbossjs/agboss (`packages/agboss`, `packages/agboss-cli` and the CLI's `@agboss/core`
dependency at the version, the root `package.json`, `package-lock.json`, `CHANGELOG.md` — the
version's section dated).

```bash
set -euo pipefail
cd "$WORKSPACE_ROOT/agboss" && git fetch origin && \
  git switch "chore/691-version-$RELEASE_VERSION" && git rebase origin/main && \
  npm ci && TMPDIR="$(realpath "$TMPDIR")" make check && npm run check:packed && \
  node scripts/release/release-plan.mjs --tag "v$RELEASE_VERSION" && \
  git push --force-with-lease origin HEAD
gh pr create -R agbossjs/agboss --fill --base main   # or the PR already open from the branch
```

- **Expected:** `release-plan` prints `vX.Y.Z: @agboss/core@X.Y.Z, then @agboss/cli@X.Y.Z`; the PR's
  `check` and its `Release / dry run` pass; then squash-merge it.

## Step 3 — The candidate: `main`, the packed packages, the examples

```bash
set -euo pipefail
cd "$WORKSPACE_ROOT/agboss" && git switch main && git pull --ff-only origin main && \
  export RELEASE_SHA="$(git rev-parse HEAD)" && echo "RELEASE_SHA=$RELEASE_SHA" && \
  npm ci && TMPDIR="$(realpath "$TMPDIR")" make check && \
  AGBOSS_NPM_BEFORE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" npm run check:packed && \
  npm audit --omit=dev -w @agboss/core && \
  npm pack --dry-run -w @agboss/core 2>&1 | grep -c ' src/' && \
  gh run list -R agbossjs/agboss --workflow ci.yml --commit "$RELEASE_SHA" --event push
```

- **Expected:** `make check` and `check:packed` pass (the packed packages in a project of their own,
  #497; every source map's sources shipped and a core stack frame that opens, #645 — the tarball
  ships `src/`), `found 0 vulnerabilities`, a non-zero count of `src/` files, and main's `CI` run for
  `$RELEASE_SHA` is `completed success` (or in progress — the release job waits for it).
- Then run **[Examples against the release candidate](#examples-against-the-release-candidate-every-release-from-011-489)**
  below (steps 1 and 2) on `$WORKSPACE_ROOT/agboss` at `$RELEASE_SHA`. **Stop** on any failure.

## Step 4 — ⚠️ [PUBLIC / IRREVERSIBLE] Car 1: tag the core

```bash
set -euo pipefail
cd "$WORKSPACE_ROOT/agboss" && \
  test "$(git rev-parse HEAD)" = "$RELEASE_SHA" && test -z "$(git status --short)" && \
  if npm view "@agboss/core@$RELEASE_VERSION" version > /dev/null 2>&1; then echo "already on npm"; exit 1; fi && \
  git tag -a "v$RELEASE_VERSION" -m "Release v$RELEASE_VERSION" "$RELEASE_SHA" && \
  git push origin "v$RELEASE_VERSION"
gh run watch -R agbossjs/agboss "$(gh run list -R agbossjs/agboss --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

- Approve the `npm` environment's deployment when GitHub asks (Actions → the run → Review
  deployments).
- **Expected:** the run's steps print `ready`, `CI ... passed`, then
  `@agboss/core@X.Y.Z: sha512-…` and `@agboss/cli@X.Y.Z: sha512-…` (the registry serves the tarballs
  that were packed).
- **Stop if** the run fails before publishing: fix on `main`, delete the tag
  (`git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`) and start again at Step 3. If it fails
  between the two packages, re-run the job: the core is left alone, the CLI is published.

## Step 5 — Verify the core from npm

```bash
set -euo pipefail
test "$(npm view "@agboss/core@$RELEASE_VERSION" version)" = "$RELEASE_VERSION"
test "$(npm view "@agboss/cli@$RELEASE_VERSION" version)" = "$RELEASE_VERSION"
test "$(npm view "@agboss/core@$RELEASE_VERSION" gitHead)" = "$RELEASE_SHA"
npm view @agboss/core dist-tags --json && npm view @agboss/cli dist-tags --json
# a project of its own, from the registry (AGBOSS_NPM_BEFORE: this install may take the release minutes old)
rm -rf "$SCRATCH/core-app" && cd "$SCRATCH" && \
  npm exec --yes --package="@agboss/cli@$RELEASE_VERSION" -- agboss create core-app --yes && \
  cd "$SCRATCH/core-app" && npm run check && npm test && npm audit signatures
```

- **Expected:** `latest` is `X.Y.Z` on both; the new project passes `check` and `test`;
  `npm audit signatures` reports verified registry signatures and **attestations** (provenance) for
  `@agboss/core` and `@agboss/cli`.
- Then **[Examples against the release candidate](#examples-against-the-release-candidate-every-release-from-011-489)**
  step 3: the examples against the registry, with one example's live demo
  (`cd "$WORKSPACE_ROOT/agboss-examples/01-"*/ && npm run demo:live`, `OPENROUTER_API_KEY` set).

## Step 6 — ⚠️ [PUBLIC / IRREVERSIBLE] Car 2: `@agboss/postgres` on the published core

```bash
set -euo pipefail
cd "$WORKSPACE_ROOT/postgres" && git fetch origin && \
  git switch "chore/691-version-$RELEASE_VERSION" && git rebase origin/main && \
  node scripts/pin-framework.mjs --registry "$RELEASE_VERSION" && \
  test "$(node -p "require('./.agboss-version.json').source")" = registry && \
  npm ci && npm run pack:framework && npm run install:packed && \
  AGBOSS_POSTGRES_TEST_URL="${AGBOSS_POSTGRES_TEST_URL:?a PostgreSQL for the tests}" VITEST_MAX_FORKS=3 npm run check && \
  git commit -am "chore(agbossjs/agboss#691): pin @agboss/core $RELEASE_VERSION from npm" && \
  git push --force-with-lease origin HEAD
gh pr create -R agbossjs/postgres --fill --base main   # or the PR already open from the branch
```

- **Expected:** `pack:framework` prints `downloaded @agboss/core@X.Y.Z … (sha512-…)`; the PR's CI
  (`check` and the three fault-suite shards, all on the registry's core) and its `Release / dry run`
  pass. Squash-merge it, then tag the merged commit:

```bash
set -euo pipefail
cd "$WORKSPACE_ROOT/postgres" && git switch main && git pull --ff-only origin main && \
  export POSTGRES_SHA="$(git rev-parse HEAD)" && \
  node scripts/release/release-plan.mjs --tag "postgres-v$RELEASE_VERSION" && \
  git tag -a "postgres-v$RELEASE_VERSION" -m "Release @agboss/postgres $RELEASE_VERSION" "$POSTGRES_SHA" && \
  git push origin "postgres-v$RELEASE_VERSION"
gh run watch -R agbossjs/postgres "$(gh run list -R agbossjs/postgres --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

- Approve the `npm` deployment. **Expected:** `@agboss/postgres@X.Y.Z: sha512-…`. The job waits for
  main's CI on that commit (the fault suite's shards, ~45 min).
- **Verify** in a project of its own, against a PostgreSQL:

```bash
set -euo pipefail
rm -rf "$SCRATCH/pg-app" && mkdir -p "$SCRATCH/pg-app" && cd "$SCRATCH/pg-app" && npm init -y >/dev/null && \
  npm install "@agboss/core@$RELEASE_VERSION" "@agboss/postgres@$RELEASE_VERSION" && \
  npx agboss-postgres migrate --url "$AGBOSS_POSTGRES_TEST_URL" && \
  npx agboss-postgres migrate --url "$AGBOSS_POSTGRES_TEST_URL" | grep -q "nothing to apply" && \
  node --input-type=module -e 'import("@agboss/postgres").then((m) => console.log(Object.keys(m).length, "exports"))' && \
  npm audit signatures
```

- **Expected:** the first migration applies every file (on a fresh database) or nothing, the second
  prints `nothing to apply`; the import lists the stores; signatures and attestations verified.
- Back to a commit pin for development, in a PR: `node scripts/pin-framework.mjs --sha <agboss main sha>`.

## Step 7 — ⚠️ [PUBLIC / IRREVERSIBLE] The next cars

For each of agbossjs/mongodb and agbossjs/redis that has the release path (see the top) and
whose issues are done: Step 6 in its repository, with its tag prefix (`mongodb-v`, `redis-v`) and its own store for the verification. Skip a car that is
not ready; say so in the release notes.

## Step 8 — The release notes and the site

- ⚠️ [PUBLIC] A GitHub Release per tag, from the version's `CHANGELOG.md` section:
  `gh release create "v$RELEASE_VERSION" -R agbossjs/agboss --verify-tag --title "AGBoss v$RELEASE_VERSION" --notes-file <the section>`,
  the same with `postgres-v$RELEASE_VERSION` in agbossjs/postgres.
- agbossjs/agboss.dev: its release metadata to the version, in a PR there (its own `release:mode`
  and `verify:release-meta` scripts), merged once npm serves the train.
- agbossjs/agboss-examples: `.agboss-version.json` pinned to `$RELEASE_SHA` (examples step 3), in a
  PR there.

## Rollback — deprecate, never unpublish

`npm unpublish` is not a rollback: within 72 h it breaks every lockfile that already resolved the
version and every car pinned to it; after 72 h npm refuses it, and a version number is never
reusable. Instead:

```bash
set -euo pipefail
# 1. warn every install of the bad version (the message names the fix)
npm deprecate "@agboss/core@$RELEASE_VERSION" "broken: <why>; use <good version>"
npm deprecate "@agboss/cli@$RELEASE_VERSION" "broken: <why>; use <good version>"
npm deprecate "@agboss/postgres@$RELEASE_VERSION" "broken: <why>; use <good version>"
# 2. point `latest` back at the last good version (a first release, as @agboss/postgres 0.1.1, has none: deprecate only)
npm dist-tag add "@agboss/core@<good version>" latest
npm dist-tag add "@agboss/cli@<good version>" latest
# 3. fix forward: the next patch version through this runbook; then lift the deprecation if wanted
npm deprecate "@agboss/core@$RELEASE_VERSION" ""
```

- A car after the core that is broken is deprecated alone; the core stays.
- A core that is broken after a car was published on it: deprecate both, release the fixed core and
  the car again at the next patch version (each car rides on the core of its own version).
- A tag pushed by mistake **before** anything was published: cancel the run
  (`gh run cancel <id> -R <repo>`, or reject the `npm` deployment) and delete the tag
  (`git push origin :refs/tags/<tag> && git tag -d <tag>`).
- A leaked or misused token: revoke it on npmjs.com at once, then check
  `npm view <package> time --json` for versions nobody released.

---

## Examples against the release candidate (every release from `0.1.1`, #489)

The examples live in [`agbossjs/agboss-examples`](https://github.com/agbossjs/agboss-examples), not in this repository (Wiki → ADR-0025-Examples-live-in-agbossjs-agboss-examples): `01`..`07` and [`08-job-scout`](https://github.com/agbossjs/agboss-examples/tree/main/08-job-scout), which left `agbossjs/agboss` in #489. Their CI (`smoke` on every push, `nightly` against the pinned framework commit) runs offline, without models and without any token of this repository; **before every release the maintainer runs every example locally against the release candidate with real models.** Nothing is published until all three steps pass.

1. **Pack the candidate and install it into every example.** `AGBOSS_REPO_DIR` points at a checkout of the release commit of `agbossjs/agboss`:

   ```bash
   set -euo pipefail
   cd "$WORKSPACE_ROOT/agboss-examples" && \
     npm ci && \
     AGBOSS_REPO_DIR="$WORKSPACE_ROOT/agboss" npm run pack:framework && \
     npm run install:packed
   ```

2. **Run every example with real models** — `check`, `test`, then `demo:live` where the example has it (`01`, `08`), else its `demo` — with `OPENROUTER_API_KEY` set:

   ```bash
   set -euo pipefail
   test -n "${OPENROUTER_API_KEY:-}"
   cd "$WORKSPACE_ROOT/agboss-examples"
   for example in [0-9][0-9]-*/; do
     (
       cd "$example"
       npm run check && npm test
       if node -e 'process.exit(require("./package.json").scripts?.["demo:live"] ? 0 : 1)'; then
         npm run demo:live
       else
         npm run demo
       fi
     )
   done
   npm run install:packed:restore && test -z "$(git status --short | grep -v '/.claude/skills/agboss/')"
   ```

   `agboss check` syncs each example's `.claude/skills/agboss/` to the candidate's skills: those
   files, and only those, differ after the restore; they are committed with step 3's pin PR.

   - **Expected outcome:** every example, `08-job-scout` included, passes `check`, `test` and its live demo against the packed candidate; `08`'s demo prints a ranked shortlist and its cost report.
   - **Failure / stop condition:** stop if a step is unclear, if an example fails, or if an example passes only offline — fix the framework or the example first, never release around it.

3. **After publishing**, check the examples against the registry (`RELEASE_VERSION` is the version just published, e.g. `0.1.1`) and pin them to the release commit:

   ```bash
   set -euo pipefail
   cd "$WORKSPACE_ROOT/agboss-examples" && \
     AGBOSS_NPM_BEFORE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     npm run verify:published -- --live-registry --version "$RELEASE_VERSION"
   # then pin .agboss-version.json (frameworkSha) to the release commit — Step 1.2 — in a PR there
   ```

   `AGBOSS_NPM_BEFORE` lets this one install take the release published minutes ago (the policy below).

---

## Dependency installs: lockfiles and the minimum release age (#523)

No install in CI or in a release script takes a dependency version nobody reviewed. A release a few minutes old is what a registry mirror may not have yet (a flaky 404, `@langchain/langgraph-sdk@1.12.9` in #522) and what nobody has looked at yet — the window in which a malicious release is usually caught and pulled. The policy, in `agbossjs/agboss`, `agbossjs/postgres` and `agbossjs/agboss-examples` alike:

- **A lockfile where there is one: `npm ci`.** Every workflow step installs with `npm ci` (`npm --prefix <dir> ci` for a checked-out repository). `npm run check:installs` (in `make check`, so in CI; the same check in the other two repositories) fails on a workflow's `npm install` / `npm i` / `npm add` / `npm update` without `--before`.
- **A minimum release age of 3 days where ranges must be resolved:** a probe project built from the packed tarballs (`npm run check:packed` here; `install:packed`, `install:published`, `verify:package`, `verify:published` in the other two), whose dependencies have no lockfile of their own. The scripts install with `npm install --before=<now − 3 days>`, computed when they run (`scripts/packed/npm-before.mjs` here, `npm-before.mjs` in the scripts of the other two; `check:installs` fails on a script that passes `install` to npm any other way). `@agboss/*` tarballs installed by path are exempt — `--before` filters registry versions, never a file.
- **`npx` only for a package pinned to an exact version** (`npx tsx@4.20.3`); a project's own tool runs from its `node_modules/.bin`. `check:installs` fails on an unpinned `npx` / `npm exec` in a workflow and on any `npx` in a script.
- **`AGBOSS_NPM_BEFORE=<ISO 8601 date>`** overrides the date — only by the maintainer, locally, at release time: to verify the candidate against the very latest dependencies (`AGBOSS_NPM_BEFORE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"`, then `npm run check:packed` here, or `install:packed` in agbossjs/agboss-examples), and for the install right after publishing (step 3 above), which must reach a release minutes old. Never in a workflow; a date that does not parse stops the script.

Real-time thresholds go with it (#509, #523): no test asserts a real elapsed duration against a fixed number — it asserts on the `Clock` (a `VirtualClock` it advances) or on the order of events; `npm run check:real-time` (in `make check`) fails on one, and `scripts/flaky-probe.mjs` proves a rewritten test at 50 runs out of 50.

---

The 0.1.0 runbook (the hand-published tarballs of agbossjs/agboss-examples, the site's first
activation) is in the history: `git show v0.1.0:RELEASE_CHECKLIST.md`.
