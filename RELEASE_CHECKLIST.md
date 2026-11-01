# AGBoss v0.1.0 — Manual Release Runbook & Pre-Publication Checklist

> **Strict Pre-Release Embargo:** No automation or AI agent may publish packages to npm, create git tags, create GitHub Releases, merge pull requests into `main`, or switch the production documentation site (`agboss.dev`) to published mode without explicit manual execution by the repository owner.
>
> **Selected Release Version (`v0.1.0`):** `0.1.0` is the first substantive public framework and CLI release. Earlier `0.0.1` entries on `registry.npmjs.org` (`agboss@0.0.1`, `agboss-cli@0.0.1`, `@agboss/core@0.0.1`, `@agboss/cli@0.0.1`) were initial package-name reservation placeholders containing no framework code, and `v0.0.2` appeared only in early pre-release website drafts before the v2 architecture was consolidated into `0.1.0`.

---

## Local Directory Layout & CI Artifact Provenance Convention

All commands in this runbook use `$WORKSPACE_ROOT` to avoid hardcoded path assumptions and start with `set -euo pipefail` so any failed command immediately aborts execution. Before starting, set `$WORKSPACE_ROOT` to the parent directory containing all four repositories (`agboss`, `agboss-examples`, `agboss.dev`, `.github`):

```bash
set -euo pipefail
export WORKSPACE_ROOT="/Users/pavelravvich/projects/agboss"
ls -d "$WORKSPACE_ROOT/agboss" "$WORKSPACE_ROOT/agboss-examples" "$WORKSPACE_ROOT/agboss.dev" "$WORKSPACE_ROOT/.github"
```

### CI Artifact vs. Local Tarball Provenance (`agbossjs/agboss-examples`)

- **Candidate validation workflow (`Smoke CI` — `.github/workflows/smoke.yml`):** Validates all 7 example projects (`01`..`07`), `verify:package`, and `verify:published -- --from-packed` on every PR/push and uploads the lightweight JSON/Markdown proof artifact `agboss-release-proof-<framework_sha>` (`.packed/manifest.json`, `.packed/package-verification.json`, `.packed/published-verification.json`, `.packed/last-run.json`, `proof-results.json`, `proof-report.md`; does not include `.packed/*.tgz`).
- **Downloadable tarball archive workflow (`Packed Release Candidate Verification` — `.github/workflows/packed-release.yml`):** Uploads `packed-release-proof-<framework_sha>`, which includes all JSON/Markdown proof files **plus** the downloadable `.packed/agboss-core-0.1.0.tgz` and `.packed/agboss-cli-0.1.0.tgz` archives.
- **Exact tarballs published by the owner in Phase 4:** In Phase 2 Step 2.2, the owner packs and verifies `$WORKSPACE_ROOT/agboss-examples/.packed/agboss-core-0.1.0.tgz` and `$WORKSPACE_ROOT/agboss-examples/.packed/agboss-cli-0.1.0.tgz` directly from `FINAL_MAIN_FRAMEWORK_SHA` (`sourceCommit` in `.packed/manifest.json`), and in Phase 4 publishes those exact verified `.tgz` files (rather than re-packing via `npm publish --workspace=...`).

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
   npm run install:packed:restore && test -z "$(git status --short)"
   ```

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

# OWNER MANUAL RELEASE — START HERE

Execute the eight phases below **in strict chronological order**. Every command block uses `set -euo pipefail` so execution stops immediately on any non-zero exit code.

---

## Phase 1 — Merge (`agboss#465` First, Pin `FINAL_MAIN_FRAMEWORK_SHA`, Then Downstream PRs)

> **Why order matters:** `agboss-examples` and `agboss.dev` pin the framework commit in `.agboss-version.json` under the field `"frameworkSha"` and validate it in CI with `VERIFY_PINNED_FRAMEWORK_SHA=1`. If `agboss#465` is squash-merged or rebase-merged into `main`, GitHub creates a new commit SHA on `main`. Therefore, merge `agboss#465` first, read the resulting `main` SHA (`FINAL_MAIN_FRAMEWORK_SHA`), pin it in `agboss-examples` and `agboss.dev`, let their PR CI pass against `FINAL_MAIN_FRAMEWORK_SHA`, and then merge the remaining PRs.

### Step 1.1 — ⚠️ [PUBLIC / IRREVERSIBLE] Merge `agbossjs/agboss` PR #465 into `main` & Record `FINAL_MAIN_FRAMEWORK_SHA`

- **Working directory:** `$WORKSPACE_ROOT/agboss`
- **Exact command:**
  ```bash
  set -euo pipefail
  cd "$WORKSPACE_ROOT/agboss" && \
    git checkout main && \
    git pull --ff-only origin main && \
    export FINAL_MAIN_FRAMEWORK_SHA="$(git rev-parse HEAD)" && \
    test -n "$FINAL_MAIN_FRAMEWORK_SHA" && \
    echo "FINAL_MAIN_FRAMEWORK_SHA=$FINAL_MAIN_FRAMEWORK_SHA" && \
    git log -1 --oneline
  ```
- **Expected outcome:** `FINAL_MAIN_FRAMEWORK_SHA` prints a 40-character hexadecimal SHA representing the merged `HEAD` of `agbossjs/agboss` `main` (whether created via merge commit, squash merge, or rebase merge).
- **Failure / stop condition:** Stop if `git pull --ff-only origin main` fails, if `FINAL_MAIN_FRAMEWORK_SHA` is empty, or if `agbossjs/agboss` `main` CI fails.

### Step 1.2 — Update `.agboss-version.json` (`frameworkSha`) in `agboss-examples` (PR #21) and `agboss.dev` (PR #2)

- **Working directory:** `$WORKSPACE_ROOT/agboss-examples` and `$WORKSPACE_ROOT/agboss.dev`
- **Exact command:**
  ```bash
  set -euo pipefail
  test -n "${FINAL_MAIN_FRAMEWORK_SHA:-}"

  # 1. Pin FINAL_MAIN_FRAMEWORK_SHA in agboss-examples PR #21 and assert .agboss-version.json.frameworkSha
  cd "$WORKSPACE_ROOT/agboss-examples" && \
    git checkout chore/pre-release-remediation && \
    git pull --ff-only origin chore/pre-release-remediation && \
    node scripts/pin-framework-sha.mjs --sha "$FINAL_MAIN_FRAMEWORK_SHA" --branch main && \
    test "$(node -p "require('./.agboss-version.json').frameworkSha")" = "$FINAL_MAIN_FRAMEWORK_SHA" && \
    git add .agboss-version.json && \
    (git diff --cached --quiet || (git commit -m "chore(release): pin .agboss-version.json to agboss main SHA $FINAL_MAIN_FRAMEWORK_SHA" && git push origin chore/pre-release-remediation))

  # 2. Pin FINAL_MAIN_FRAMEWORK_SHA in agboss.dev PR #2 and assert .agboss-version.json.frameworkSha
  cd "$WORKSPACE_ROOT/agboss.dev" && \
    git checkout chore/pre-release-remediation && \
    git pull --ff-only origin chore/pre-release-remediation && \
    node scripts/pin-framework-sha.mjs --sha "$FINAL_MAIN_FRAMEWORK_SHA" --branch main && \
    test "$(node -p "require('./.agboss-version.json').frameworkSha")" = "$FINAL_MAIN_FRAMEWORK_SHA" && \
    git add .agboss-version.json && \
    (git diff --cached --quiet || (git commit -m "chore(release): pin .agboss-version.json to agboss main SHA $FINAL_MAIN_FRAMEWORK_SHA" && git push origin chore/pre-release-remediation))
  ```
- **Expected outcome:** Both `.agboss-version.json` files contain `"frameworkSha": "<FINAL_MAIN_FRAMEWORK_SHA>"` and `"branch": "main"`, both `node -p "require('./.agboss-version.json').frameworkSha"` assertions pass, and both PR branches are pushed.
- **Failure / stop condition:** Stop if `pin-framework-sha.mjs` exits non-zero, if `.agboss-version.json.frameworkSha` does not equal `$FINAL_MAIN_FRAMEWORK_SHA`, or if pushing to either PR branch fails.

### Step 1.3 — Verify Downstream CI on `FINAL_MAIN_FRAMEWORK_SHA` & ⚠️ [PUBLIC / IRREVERSIBLE] Merge Remaining PRs

- **Working directory:** `$WORKSPACE_ROOT`
- **Exact command:**
  ```bash
  set -euo pipefail
  gh pr checks 21 -R agbossjs/agboss-examples --watch && \
    gh pr checks 2 -R agbossjs/agboss.dev --watch
  # Once both PR checks pass, merge PR #21 (agboss-examples), PR #2 (agboss.dev), and PR #2 (.github) in the GitHub UI.
  # Note: Merging agboss.dev PR #2 deploys the site in PRE-RELEASE mode (isPublishedToRegistry: false),
  # which remains accurate until npm publication completes in Phase 4–5.
  ```
- **Expected outcome:** Both `Smoke CI` (`agboss-examples#21`) and `Build & Verify Docs` (`agboss.dev#2`) complete with `pass`, and all four PRs (`agboss#465`, `agboss-examples#21`, `agboss.dev#2`, `.github#2`) are merged into `main`.
- **Failure / stop condition:** Stop if any check on `agboss-examples#21` or `agboss.dev#2` fails. Do not merge broken PRs.

---

## Phase 2 — Final Source Verification (Pack & Verify Final Release Tarballs from `main`)

### Step 2.1 — Checkout Integrated `main` Across All Repositories & Run `make check`

- **Working directory:** `$WORKSPACE_ROOT/agboss`
- **Exact command:**
  ```bash
  set -euo pipefail
  for repo in agboss agboss-examples agboss.dev .github; do
    git -C "$WORKSPACE_ROOT/$repo" checkout main && \
      git -C "$WORKSPACE_ROOT/$repo" pull --ff-only origin main
  done

  cd "$WORKSPACE_ROOT/agboss" && \
    test "$(git rev-parse HEAD)" = "$FINAL_MAIN_FRAMEWORK_SHA" && \
    npm ci && \
    make check && \
    npm run check:packed && \
    npm audit --omit=dev -w @agboss/core
  ```
- **Expected outcome:** `make check` passes (`0` lint/type/test/doc/root-allowlist errors), `npm run check:packed` passes (the packed `@agboss/core` / `@agboss/cli` in a project of their own: `workflowOf`, `testWith`, `agboss describe` / `check`, and the `TestSetupError` without `agbossTest()`, #497; every source map's sources shipped, no "points to missing source files", a core stack frame that opens, #645) and `npm audit --omit=dev -w @agboss/core` reports `found 0 vulnerabilities`.
- **Failure / stop condition:** Stop if `make check`, `npm run check:packed` or `npm audit --omit=dev -w @agboss/core` fails.

### Step 2.2 — Pack Final Release Tarballs, Assert `sourceCommit`, & Run Full RC Verification Suite (`01`..`07`)

- **Working directory:** `$WORKSPACE_ROOT/agboss-examples`
- **Exact command:**
  ```bash
  set -euo pipefail
  cd "$WORKSPACE_ROOT/agboss-examples" && \
    npm ci && \
    VERIFY_PINNED_FRAMEWORK_SHA=1 AGBOSS_REPO_DIR="$WORKSPACE_ROOT/agboss" npm run pack:framework && \
    test "$(node -p "require('./.agboss-version.json').frameworkSha")" = "$FINAL_MAIN_FRAMEWORK_SHA" && \
    test "$(node -p "require('./.packed/manifest.json').sourceCommit")" = "$FINAL_MAIN_FRAMEWORK_SHA" && \
    npm run verify:package && \
    npm run verify:published -- --from-packed --version 0.1.0 && \
    npm run install:packed && \
    node scripts/run-all.mjs --provenance rc --include-p1 --reset --mode check && \
    node scripts/run-all.mjs --provenance rc --include-p1 --mode test && \
    AGBOSS_OFFLINE_VERIFY=1 node scripts/run-all.mjs --provenance rc --include-p1 --mode demo && \
    node scripts/collect-results.mjs --provenance rc --require-p1 && \
    npm run install:packed:restore && \
    test -z "$(git status --short)" && \
    cat .packed/manifest.json
  ```
- **Expected outcome:**
  - Both `node -p "require('./.agboss-version.json').frameworkSha"` and `node -p "require('./.packed/manifest.json').sourceCommit"` equal `$FINAL_MAIN_FRAMEWORK_SHA`.
  - `verify:package` prints `All package verification checks PASSED`.
  - `verify:published -- --from-packed --version 0.1.0` prints `SOURCE: LOCAL_PACKED_RELEASE_CANDIDATE` and `Clean environment verification PASSED`.
  - `collect-results.mjs --provenance rc --require-p1` prints `Overall Gate: PASSED, P0: PASSED, P1: PASSED, Package: PASSED`.
  - `.packed/manifest.json` records `sourceCommit` (`$FINAL_MAIN_FRAMEWORK_SHA`), `examplesSourceCommit`, and the exact `sha256` and `sha512` (`integrity`) hashes for `.packed/agboss-core-0.1.0.tgz` (`packages.agboss`) and `.packed/agboss-cli-0.1.0.tgz` (`packages.agbossCli`).
- **Failure / stop condition:** Stop immediately if `sourceCommit` does not match `$FINAL_MAIN_FRAMEWORK_SHA`, if any gate in `proof-results.json` is not `PASSED`, or if `git status --short` in `agboss-examples` is non-empty after `install:packed:restore`.

---

## Phase 3 — Tag (`v0.1.0` on `agbossjs/agboss` `main`)

### Step 3.1 — ⚠️ [PUBLIC / IRREVERSIBLE] Create and Push Annotated Tag `v0.1.0`

- **Working directory:** `$WORKSPACE_ROOT/agboss`
- **Exact command:**
  ```bash
  set -euo pipefail
  cd "$WORKSPACE_ROOT/agboss" && \
    test "$(git rev-parse HEAD)" = "$FINAL_MAIN_FRAMEWORK_SHA" && \
    test -z "$(git status --short)" && \
    git tag -a v0.1.0 -m "Release v0.1.0" && \
    git push origin v0.1.0
  ```
- **Expected outcome:** Annotated tag `v0.1.0` pointing to `$FINAL_MAIN_FRAMEWORK_SHA` is pushed to `origin` (`agbossjs/agboss`).
- **Failure / stop condition:** Stop if `HEAD` does not match `$FINAL_MAIN_FRAMEWORK_SHA`, if the working tree is dirty, or if tag `v0.1.0` already exists on `origin`.

---

## Phase 4 — Publish Exact Verified Tarballs (`agboss-core-0.1.0.tgz` First, Then `agboss-cli-0.1.0.tgz`)

> **Why publish the exact `.packed/*.tgz` files:** Publishing `$WORKSPACE_ROOT/agboss-examples/.packed/agboss-core-0.1.0.tgz` and `$WORKSPACE_ROOT/agboss-examples/.packed/agboss-cli-0.1.0.tgz` guarantees byte-for-byte identity (`sha256` and `sha512` `integrity`) between the tarballs validated across all 7 examples in Phase 2 and the artifacts uploaded to `registry.npmjs.org`.
>
> **Why `@agboss/core` must be published before `@agboss/cli`:** `packages/agboss-cli/package.json` declares `"@agboss/core": "0.1.0"` in `dependencies`. Publishing `agboss-core-0.1.0.tgz` first ensures `@agboss/core@0.1.0` is resolvable on `registry.npmjs.org` as soon as `@agboss/cli@0.1.0` is installed by consumers.

### Step 4.1 — Verify npm Account Identity, Tarball Provenance/Checksums & Dry-Run

- **Working directory:** `$WORKSPACE_ROOT/agboss-examples`
- **Exact command:**
  ```bash
  set -euo pipefail
  cd "$WORKSPACE_ROOT/agboss-examples"

  # 1. Confirm npm account identity & collaborator write permissions on both scoped packages
  npm whoami && \
    npm access list collaborators @agboss/core && \
    npm access list collaborators @agboss/cli

  # 2. Confirm 0.1.0 is NOT yet published on registry.npmjs.org
  npm view @agboss/core versions dist-tags deprecated --json && \
    npm view @agboss/cli versions dist-tags deprecated --json

  # 3. Verify .packed/manifest.json provenance (sourceCommit, examplesSourceCommit, name, version) and recompute sha256 + sha512 integrity of both .tgz files
  node -e '
    const assert = require("node:assert/strict");
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(".packed/manifest.json", "utf8"));
    const expectedSha = process.env.FINAL_MAIN_FRAMEWORK_SHA;
    assert.equal(manifest.sourceCommit, expectedSha, "manifest.sourceCommit mismatch");
    assert.ok(manifest.examplesSourceCommit && manifest.examplesSourceCommit.length === 40, "manifest.examplesSourceCommit missing");
    for (const [key, expectedName, tgzPath] of [
      ["agboss", "@agboss/core", ".packed/agboss-core-0.1.0.tgz"],
      ["agbossCli", "@agboss/cli", ".packed/agboss-cli-0.1.0.tgz"],
    ]) {
      const pkg = manifest.packages[key];
      assert.equal(pkg.name, expectedName);
      assert.equal(pkg.version, "0.1.0");
      const buf = fs.readFileSync(tgzPath);
      const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
      const integrity = "sha512-" + crypto.createHash("sha512").update(buf).digest("base64");
      assert.equal(sha256, pkg.sha256, `${tgzPath} sha256 mismatch`);
      assert.equal(integrity, pkg.integrity, `${tgzPath} sha512 integrity mismatch`);
      console.log(`VERIFIED ${tgzPath}: name=${pkg.name}@${pkg.version} sha256=${sha256} integrity=${integrity}`);
    }
  '

  # 4. Run dry-run publish against the exact verified .tgz files
  npm publish "$WORKSPACE_ROOT/agboss-examples/.packed/agboss-core-0.1.0.tgz" --access public --tag latest --dry-run && \
    npm publish "$WORKSPACE_ROOT/agboss-examples/.packed/agboss-cli-0.1.0.tgz" --access public --tag latest --dry-run
  ```
- **Expected outcome:**
  - `npm whoami` prints the authorized maintainer username with read-write access to both `@agboss/core` and `@agboss/cli`.
  - `versions` lists `["0.0.0-stage", "0.0.1"]` and does **not** contain `"0.1.0"`.
  - The provenance/checksum script prints `VERIFIED .packed/agboss-core-0.1.0.tgz` and `VERIFIED .packed/agboss-cli-0.1.0.tgz` with matching `sourceCommit`, `sha256`, and `sha512` `integrity`.
  - Both `npm publish ... --dry-run` commands exit `0` against the `.packed/*.tgz` archives.
- **Failure / stop condition:** Stop if `npm whoami` fails (run `npm login`), if collaborator permissions are missing, if `0.1.0` already exists on npm, if any checksum/provenance assertion fails, or if `--dry-run` reports errors.

### Step 4.2 — ⚠️ [PUBLIC / IRREVERSIBLE] Publish `agboss-core-0.1.0.tgz` First & Verify Registry `dist.integrity`

- **Working directory:** `$WORKSPACE_ROOT/agboss-examples`
- **Exact command:**
  ```bash
  set -euo pipefail
  cd "$WORKSPACE_ROOT/agboss-examples"

  # If your npm account requires a 2FA OTP code, append --otp=<code> or authenticate via web prompt:
  npm publish "$WORKSPACE_ROOT/agboss-examples/.packed/agboss-core-0.1.0.tgz" --access public --tag latest && \
    test "$(npm view @agboss/core@0.1.0 version)" = "0.1.0" && \
    test "$(npm view @agboss/core@0.1.0 dist.integrity)" = "$(node -p "require('./.packed/manifest.json').packages.agboss.integrity")" && \
    npm view @agboss/core@0.1.0 version dist-tags dist.integrity deprecated --json
  ```
- **Expected outcome:**
  - `npm view @agboss/core@0.1.0 version` returns `"0.1.0"` and `dist-tags.latest` is `"0.1.0"`.
  - `npm view @agboss/core@0.1.0 dist.integrity` exactly matches `packages.agboss.integrity` in `.packed/manifest.json`.
  - `deprecated` is undefined/empty on `@agboss/core@0.1.0`.
- **Failure / stop condition:** **STOP IMMEDIATELY** if `npm publish "$WORKSPACE_ROOT/agboss-examples/.packed/agboss-core-0.1.0.tgz"` fails, if `npm view @agboss/core@0.1.0 version` does not resolve to `"0.1.0"`, if `dist.integrity` does not match `.packed/manifest.json`, or if `deprecated` is non-empty on `@agboss/core@0.1.0`. Do **not** publish `agboss-cli-0.1.0.tgz` until `@agboss/core@0.1.0` is confirmed live with matching integrity.

### Step 4.3 — ⚠️ [PUBLIC / IRREVERSIBLE] Publish `agboss-cli-0.1.0.tgz` Second & Verify Registry `dist.integrity`

- **Working directory:** `$WORKSPACE_ROOT/agboss-examples`
- **Exact command:**
  ```bash
  set -euo pipefail
  cd "$WORKSPACE_ROOT/agboss-examples"

  npm publish "$WORKSPACE_ROOT/agboss-examples/.packed/agboss-cli-0.1.0.tgz" --access public --tag latest && \
    test "$(npm view @agboss/core@0.1.0 version)" = "0.1.0" && \
    test "$(npm view @agboss/cli@0.1.0 version)" = "0.1.0" && \
    test "$(npm view @agboss/core@0.1.0 dist.integrity)" = "$(node -p "require('./.packed/manifest.json').packages.agboss.integrity")" && \
    test "$(npm view @agboss/cli@0.1.0 dist.integrity)" = "$(node -p "require('./.packed/manifest.json').packages.agbossCli.integrity")" && \
    test -z "$(npm view @agboss/core@0.1.0 deprecated)" && \
    test -z "$(npm view @agboss/cli@0.1.0 deprecated)" && \
    npm view @agboss/core dist-tags --json && \
    npm view @agboss/cli dist-tags --json
  ```
- **Expected outcome:**
  - Both `npm view @agboss/core@0.1.0 version` and `npm view @agboss/cli@0.1.0 version` output `0.1.0`.
  - Both `dist.integrity` values on `registry.npmjs.org` exactly match `.packed/manifest.json` (`packages.agboss.integrity` and `packages.agbossCli.integrity`).
  - Both `dist-tags` objects show `"latest": "0.1.0"`.
  - Both `deprecated` checks on `@0.1.0` return empty output.
- **Failure / stop condition:** **STOP IMMEDIATELY** if `agboss-cli-0.1.0.tgz` fails to publish, if `dist.integrity` does not match `.packed/manifest.json`, if `dist-tags.latest` is not `0.1.0` on both packages, or if either `0.1.0` version is marked deprecated.

> **Cleanup of Legacy Unscoped Packages (`agboss` / `agboss-cli`):**
> After `@agboss/core@0.1.0` and `@agboss/cli@0.1.0` are published and verified, unpublish `agboss@0.1.0` and `agboss-cli@0.1.0` (within npm's 72-hour window) and deprecate any remaining unscoped versions so consumers are directed to `@agboss/core` and `@agboss/cli`.

---

## Phase 5 — Registry Smoke (Live npm Consumer & 7-Example Verification)

### Step 5.1 — Run Isolated Live-Registry Consumer & CLI Scaffold Smoke Test

- **Working directory:** `$WORKSPACE_ROOT/agboss-examples`
- **Exact command:**
  ```bash
  set -euo pipefail
  cd "$WORKSPACE_ROOT/agboss-examples" && \
    npm run verify:published -- --live-registry --version 0.1.0 && \
    cat .packed/published-verification.json
  ```
- **Expected outcome:**
  - Prints `SOURCE: PUBLIC_NPM_REGISTRY` first.
  - Queries `npm view`, installs `agboss@0.1.0` and `agboss-cli@0.1.0` from `https://registry.npmjs.org/` in an isolated temporary directory, verifies all 11 subpath exports, CLI binary resolution (`agboss --help`, `agboss help --json`, `agboss-cli --help`), `agboss create published-smoke-app --yes --skip-install`, 13 AI skill reference files, `.agboss/types.d.ts`, `agboss check`, `tsc --noEmit`, `npm test`, and `agboss describe --json`.
  - `.packed/published-verification.json` records `"status": "PASSED"`, `"source": "PUBLIC_NPM_REGISTRY"`, and `"registryVerified": true`.
- **Failure / stop condition:** **STOP IMMEDIATELY** if `verify:published -- --live-registry --version 0.1.0` exits non-zero. Do **not** activate the production website or announce the release until live-registry verification passes.

### Step 5.2 — Run All 7 Examples (`01`..`07`) Against Live npm Packages & Collect Published Proof Report

- **Working directory:** `$WORKSPACE_ROOT/agboss-examples`
- **Exact command:**
  ```bash
  set -euo pipefail
  cd "$WORKSPACE_ROOT/agboss-examples" && \
    npm run install:published -- --live-registry --version 0.1.0 && \
    node scripts/run-all.mjs --provenance published --include-p1 --reset --mode check && \
    node scripts/run-all.mjs --provenance published --include-p1 --mode test && \
    AGBOSS_OFFLINE_VERIFY=1 node scripts/run-all.mjs --provenance published --include-p1 --mode demo && \
    npm run collect:published && \
    cat published-proof-report.md
  ```
- **Expected outcome:**
  - `install:published` installs `agboss@0.1.0` and `agboss-cli@0.1.0` from `https://registry.npmjs.org/` across all 7 examples (`01`..`07`), confirms zero `file:`/tarball/symlink/workspace links, and writes `.packed/published-manifest.json`.
  - `npm run collect:published` writes `published-proof-results.json` and `published-proof-report.md` (`Provenance Type: PUBLISHED_NPM_REGISTRY`) with `Overall Release Readiness Gate: PASSED`.
- **Failure / stop condition:** **STOP IMMEDIATELY** if any of the 7 examples fails `check`, `test`, or `demo`, or if `collect:published` exits non-zero.

---

## Phase 6 — Website Activation (Switch `agboss.dev` to Published Mode & Deploy)

### Step 6.1 — ⚠️ [PUBLIC / IRREVERSIBLE] Switch `agboss.dev` to Published Mode (`v0.1.0` / `latest`), Verify (`--source` & `--dist`) & Push to `main`

- **Working directory:** `$WORKSPACE_ROOT/agboss.dev`
- **Exact command:**
  ```bash
  set -euo pipefail
  cd "$WORKSPACE_ROOT/agboss.dev" && \
    git checkout main && \
    git pull --ff-only origin main && \
    npm run release:mode -- --published && \
    npm run test:release-meta && \
    npm run verify:release-meta -- --source && \
    VERIFY_PINNED_FRAMEWORK_SHA=1 AGBOSS_REPO_DIR="$WORKSPACE_ROOT/agboss" npm run check:docs && \
    npm run build && \
    npm run verify:release-meta -- --dist && \
    git add src/config/release.ts src/content/docs/index.mdx src/content/docs/getting-started/installation.md src/content/docs/getting-started/quick-start.md src/content/docs/changelog.md src/content/docs/community.mdx src/content/docs/examples/job-scout.md SECURITY.md && \
    git commit -m "chore(release): activate v0.1.0 published mode on agboss.dev" && \
    git push origin main
  ```
- **Expected outcome:**
  - `npm run release:mode -- --published` updates `RELEASE_META` (`isPublishedToRegistry: true`, `displayVersion: 'v0.1.0'`, `releaseChannelLabel: 'latest'`, `softwareVersion: '0.1.0'`), header badges, homepage install cards, quickstart/installation callouts, changelog, and security policy.
  - `npm run verify:release-meta -- --source` validates the switched source files **before** `npm run build` (without failing on any pre-existing `dist/` directory).
  - `npm run build` generates fresh production HTML in `dist/`, and `npm run verify:release-meta -- --dist` confirms that all rendered HTML pages in `dist/` carry `data-release-mode="published"` with zero `0.1.0-rc` strings.
  - Pushing to `main` triggers the `Deploy` workflow on `agbossjs/agboss.dev`.
- **Failure / stop condition:** Stop and do not push if `verify:release-meta -- --source`, `check:docs`, `build`, or `verify:release-meta -- --dist` fails.

### Step 6.2 — Watch Production Website Deployment Workflow

- **Working directory:** `$WORKSPACE_ROOT/agboss.dev`
- **Exact command:**
  ```bash
  set -euo pipefail
  gh run list -R agbossjs/agboss.dev -b main -L 1
  ```
- **Expected outcome:** The `Deploy` workflow run on `agbossjs/agboss.dev` `main` finishes with `conclusion: success`.
- **Failure / stop condition:** If deployment fails, inspect `gh run view -R agbossjs/agboss.dev --log-failed` before proceeding.

---

## Phase 7 — GitHub Release (`v0.1.0` on `agbossjs/agboss`)

### Step 7.1 — ⚠️ [PUBLIC / IRREVERSIBLE] Create the `v0.1.0` GitHub Release with Verification Artifacts

- **Working directory:** `$WORKSPACE_ROOT/agboss`
- **Exact command:**
  ```bash
  set -euo pipefail
  cd "$WORKSPACE_ROOT/agboss" && \
    gh release create v0.1.0 \
      --repo agbossjs/agboss \
      --verify-tag \
      --title "AGBoss v0.1.0" \
      --notes-file .github/RELEASE_NOTES_v0.1.0.md \
      "$WORKSPACE_ROOT/agboss-examples/published-proof-report.md" \
      "$WORKSPACE_ROOT/agboss-examples/published-proof-results.json"
  ```
  _(Alternatively, create the release manually at `https://github.com/agbossjs/agboss/releases/new?tag=v0.1.0`, paste the contents of `.github/RELEASE_NOTES_v0.1.0.md` reproduced in the appendix below, and attach `published-proof-report.md` and `published-proof-results.json`.)_
- **Expected outcome:** `https://github.com/agbossjs/agboss/releases/tag/v0.1.0` is published with release notes and the attached `published-proof-report.md` and `published-proof-results.json` evidence files.
- **Failure / stop condition:** Stop if tag `v0.1.0` does not exist on `origin` or if `published-proof-report.md` was not generated from `--provenance published`.

---

## Phase 8 — Final Public Verification

### Step 8.1 — End-to-End Public Endpoints & Clean `npx agboss@0.1.0 create` Check

- **Working directory:** Temporary directory outside `$WORKSPACE_ROOT`
- **Exact command:**
  ```bash
  set -euo pipefail

  # 1. Verify live npm registry metadata and integrity
  test "$(npm view @agboss/core@0.1.0 version)" = "0.1.0" && \
    test "$(npm view @agboss/cli@0.1.0 version)" = "0.1.0" && \
    test "$(npm view @agboss/core dist-tags.latest)" = "0.1.0" && \
    test "$(npm view @agboss/cli dist-tags.latest)" = "0.1.0" && \
    test -z "$(npm view @agboss/core@0.1.0 deprecated)" && \
    test -z "$(npm view @agboss/cli@0.1.0 deprecated)"

  # 2. Verify live GitHub Release
  gh release view v0.1.0 -R agbossjs/agboss

  # 3. Verify live website headers and version badge
  curl -fsSL https://agboss.dev | grep -E 'data-release-mode="published"|v0\.1\.0'

  # 4. Run a clean end-user scaffold test from the public npm registry with guarded temp directory cleanup
  TMP_PUBLIC_TEST="$(mktemp -d "${TMPDIR:-/tmp}/agboss-public-verify.XXXXXX")" && \
    test -n "$TMP_PUBLIC_TEST" && \
    test -d "$TMP_PUBLIC_TEST" && \
    case "$TMP_PUBLIC_TEST" in *agboss-public-verify.*) ;; *) echo "Unsafe temp path: $TMP_PUBLIC_TEST" >&2; exit 1 ;; esac && \
    cd "$TMP_PUBLIC_TEST" && \
    npm exec --yes --package=@agboss/cli@0.1.0 -- agboss create public-verify-app --yes && \
    cd "$TMP_PUBLIC_TEST/public-verify-app" && \
    npm run check && \
    cd /tmp && \
    rm -rf "$TMP_PUBLIC_TEST"
  ```
- **Expected outcome:**
  - `npm view` confirms `0.1.0` (`latest`) with empty `deprecated` for both packages.
  - `gh release view v0.1.0` displays the published GitHub Release.
  - `https://agboss.dev` serves `data-release-mode="published"` and `v0.1.0`.
  - `npm exec --yes --package=@agboss/cli@0.1.0 -- agboss create public-verify-app --yes && cd public-verify-app && npm run check` succeeds end to end from the public npm registry, and the guarded temporary directory is cleanly removed.
- **Failure / stop condition:** If any check fails, execution halts immediately (`set -euo pipefail`); investigate before announcing the release externally.

---

# Appendix — Proposed `v0.1.0` GitHub Release Draft (`.github/RELEASE_NOTES_v0.1.0.md`)

The following Markdown is saved in `.github/RELEASE_NOTES_v0.1.0.md` and can be copy-pasted directly into the GitHub Release UI:

```markdown
# AGBoss v0.1.0 — First Public Framework & CLI Release

**AGBoss** ([agboss.dev](https://agboss.dev)) is an open-source TypeScript framework and static graph compiler for building multi-agent workflows on top of [LangGraph](https://www.langchain.com/langgraph). It combines constructor dependency injection (`@Application`, `@Injectable`), narrow `@Dto` data contracts (`@agboss/core/dto`), compile-time Path Scope workflow verification (`agboss check`), declarative saga compensation (`compensateWith` / `committedBy`), pre-call FinOps budgets (`@Budget`), deterministic testing (`@agboss/core/testing`), and 13 bundled AI coding-agent skill guides (`SKILL.md` + `references/01..13`).

---

## Versioning & Package Note (`0.0.1` → `0.1.0`)

- **`0.1.0` is the first substantive public release** of the `@agboss/core` runtime and `@agboss/cli` command-line toolkit.
- Earlier `0.0.1` entries on `registry.npmjs.org` were initial package-name reservation placeholders containing no framework code, and `v0.0.2` appeared only in early pre-release documentation drafts before the v2 architecture was consolidated into `0.1.0`.
- Canonical packages on npm are scoped **`@agboss/core`** (`dependencies`) and **`@agboss/cli`** (`devDependencies`) under the official `agboss` npm organization.

---

## Requirements

- **Node.js:** `>= 22.13.0` (tested on Node.js 22.13+ and Node.js 24 LTS)
- **TypeScript:** `>= 5.8` (`^5.9.3` recommended, with `experimentalDecorators: true` and `emitDecoratorMetadata: false`)
- **License:** Apache License 2.0 ([`LICENSE`](https://github.com/agbossjs/agboss/blob/main/LICENSE), [`NOTICE`](https://github.com/agbossjs/agboss/blob/main/NOTICE))

---

## Installation

### Option 1 — Create a new project

npm exec --yes --package=@agboss/cli -- agboss create my-app
cd my-app
npm install

### Option 2 — Add to an existing project

npm install @agboss/core
npm install -D @agboss/cli
npx agboss check

---

## Key Capabilities in `v0.1.0`

- **Application Container & Constructor DI (`@agboss/core`):** `@Application` wires workflows, typed environment contracts (`secret()`, `env()`, `env.optional()`), custom DI providers, mandatory `@Budget` classes (`Application`, `Tenant`, and `Execution` scopes), `@PiiPolicy`, `@InputGuardrail` / `@OutputGuardrail`, `@ToolInterceptor`, `@HealthCheck` (`app.checkLiveness()` / `app.checkReadiness()`), and `createApp(App)` lifecycle hooks.
- **Path Scope Flow DSL & Static Compiler (`agboss check`):** Chain-per-line `HarnessDSL` (`start(Start).returns(Dto).toAgent(Agent).toFinish(Finish)`, `.chooseOne(route())`, `.switch(caseOf())`, `.toParallelAgents()`, `.joinQuorum()`) backed by generated `.agboss/types.d.ts` (`Produced<Dto, Producer>`). Catches missing inputs (`[input.missing-on-path]`), stale review-loop values (`[input.outdated-on-path]`), sibling invalidation (`[launch.branch-outdates-sibling]`), and uncompensated side effects (`[flow.uncompensated-action]`) before any model call executes.
- **Declarative Sagas, Quorums & Human Pauses:** `@Action({ compensateWith, committedBy })` with automatic LIFO rollback on failure, cancellation, or quorum `Surplus`; `@Arbiter` quorum joins; and durable two-phase human-in-the-loop pauses (`@ChannelRole`, `@ReplyInterpreter`, `@Channel`, `app.resume({ pauseId, decision })`).
- **Multi-Instance Durability & Distributed Work-Stealing:** 10 pluggable repository contracts with built-in in-memory and SQLite WAL implementations (`Sqlite*Repository`), 30-second fenced execution leases, crash recovery sweeps, cross-instance `app.cancel(threadId)`, and `ChildPlacement.AnyInstance` distributed child workflow work-stealing.
- **MCP, RAG & Signed Agent Mesh (`@agboss/core/mcp`, `@agboss/core/rag`, `@agboss/core/a2a`):** Typed `@McpServer` / `@McpTool` wrappers, `@Rag` knowledge bases, `@A2AExpose` / `@A2AAgent` cross-service calls with signed JWS envelopes (`agboss-mesh`), `agboss check --federation`, and the read-only `agboss hub` visualizer.
- **Testing & Multi-Run Evaluation (`@agboss/core/testing`, `@agboss/core/eval`):** `testWith(App)` with scripted models, `VirtualClock`, `TestConcurrency.inOrder`, 10 component unit runners (`testTool`, `testAction`, `testRouter`, `testArbiter`, `testGuardrail`, `testPii`, `testToolInterceptor`, `testRag`, `testJudge`, `testCompaction`), and `@EvalSuite` (`agboss eval run`, `pass@k` / `pass^k`, `--baseline --fail-on-regression`, `--chaos`, `--metamorphic`, Cohen's κ calibration, and `agboss eval show --html` / `agboss eval ui`).
- **13 Bundled AI Coding-Agent Skills:** Auto-synced into `.claude/skills/agboss/` on `agboss check` (`01-composition-and-architecture.md` through `13-migrating-from-langgraph.md`).

---

## Known Limitations & Scope Boundaries (`v0.1.0`)

- **Pre-1.0 Semantic Versioning:** Minor releases (`0.x`) may introduce breaking API or DSL changes prior to `1.0.0` (documented in [`CHANGELOG.md`](https://github.com/agbossjs/agboss/blob/main/CHANGELOG.md)).
- **Built-in Persistence Adapters:** `v0.1.0` ships with in-memory (`InMemory*Repository`) and single-node/shared-volume SQLite WAL (`Sqlite*Repository`) implementations of the 10 repository contracts. External distributed database adapters (such as PostgreSQL or Redis) require implementing the exported repository interfaces until official adapter packages ship on the roadmap.
- **Static Verification Scope:** `agboss check` proves structural graph properties, DTO path availability, review-loop freshness, and declared saga compensation paths at compile time; it does not prove arbitrary runtime business logic inside custom TypeScript handler methods or external HTTP APIs.

---

## Documentation & Verified Examples

- **Documentation & Guides:** [https://agboss.dev](https://agboss.dev)
- **Quick Start:** [https://agboss.dev/getting-started/quick-start/](https://agboss.dev/getting-started/quick-start/)
- **CLI Reference:** [https://agboss.dev/cli/](https://agboss.dev/cli/)
- **Executable Examples & Reliability Proofs (`01`–`07`):** [https://github.com/agbossjs/agboss-examples](https://github.com/agbossjs/agboss-examples)
- **Changelog:** [`CHANGELOG.md`](https://github.com/agbossjs/agboss/blob/main/CHANGELOG.md)
```
