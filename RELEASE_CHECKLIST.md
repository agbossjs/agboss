# AGBoss v0.1.0 — Manual Release Runbook & Pre-Publication Checklist

> **Strict Pre-Release Embargo:** No automation or AI agent may publish packages to npm, create git tags, create GitHub Releases, merge pull requests into `main`, or switch the production documentation site (`agboss.dev`) to published mode without explicit manual execution by the repository owner.
>
> **Selected Release Version (`v0.1.0`):** `0.1.0` is the first substantive public framework and CLI release. Earlier `0.0.1` entries on `registry.npmjs.org` (`agboss@0.0.1`, `agboss-cli@0.0.1`, `@agboss/core@0.0.1`, `@agboss/cli@0.0.1`) were initial package-name reservation placeholders containing no framework code, and `v0.0.2` appeared only in early pre-release website drafts before the v2 architecture was consolidated into `0.1.0`.

---

## Local Directory Layout Convention

All commands in this runbook use `$WORKSPACE_ROOT` to avoid hardcoded path assumptions. Before starting, set `$WORKSPACE_ROOT` to the parent directory containing all four repositories (`agboss`, `agboss-examples`, `agboss.dev`, `.github`):

```bash
export WORKSPACE_ROOT="/Users/pavelravvich/projects/agboss"
ls -d "$WORKSPACE_ROOT/agboss" "$WORKSPACE_ROOT/agboss-examples" "$WORKSPACE_ROOT/agboss.dev" "$WORKSPACE_ROOT/.github"
```

---

# OWNER MANUAL RELEASE — START HERE

Execute the eight phases below **in strict chronological order**. Stop immediately if any phase hits its **Failure / Stop Condition**.

---

## Phase 1 — Merge (`agboss#465` First, Pin `FINAL_MAIN_FRAMEWORK_SHA`, Then Downstream PRs)

> **Why order matters:** `agboss-examples` and `agboss.dev` pin the framework commit in `.agboss-version.json` and validate it in CI with `VERIFY_PINNED_FRAMEWORK_SHA=1`. If `agboss#465` is squash-merged or rebase-merged into `main`, GitHub creates a new commit SHA on `main`. Therefore, merge `agboss#465` first, read the resulting `main` SHA (`FINAL_MAIN_FRAMEWORK_SHA`), pin it in `agboss-examples` and `agboss.dev`, let their PR CI pass against `FINAL_MAIN_FRAMEWORK_SHA`, and then merge the remaining PRs.

### Step 1.1 — ⚠️ [PUBLIC / IRREVERSIBLE] Merge `agbossjs/agboss` PR #465 into `main` & Record `FINAL_MAIN_FRAMEWORK_SHA`

- **Working directory:** `$WORKSPACE_ROOT/agboss`
- **Exact command:**
  ```bash
  cd "$WORKSPACE_ROOT/agboss"
  # After merging https://github.com/agbossjs/agboss/pull/465 in the GitHub UI (or via gh pr merge 465):
  git checkout main
  git pull --ff-only origin main
  export FINAL_MAIN_FRAMEWORK_SHA="$(git rev-parse HEAD)"
  echo "FINAL_MAIN_FRAMEWORK_SHA=$FINAL_MAIN_FRAMEWORK_SHA"
  git log -1 --oneline
  ```
- **Expected outcome:** `FINAL_MAIN_FRAMEWORK_SHA` prints a 40-character hexadecimal SHA representing the merged `HEAD` of `agbossjs/agboss` `main` (whether created via merge commit, squash merge, or rebase merge).
- **Failure / stop condition:** Stop if `git pull --ff-only origin main` fails, if `FINAL_MAIN_FRAMEWORK_SHA` is empty, or if `agbossjs/agboss` `main` CI fails.

### Step 1.2 — Update `.agboss-version.json` in `agboss-examples` (PR #21) and `agboss.dev` (PR #2)

- **Working directory:** `$WORKSPACE_ROOT/agboss-examples` and `$WORKSPACE_ROOT/agboss.dev`
- **Exact command:**
  ```bash
  # 1. Pin FINAL_MAIN_FRAMEWORK_SHA in agboss-examples PR #21
  cd "$WORKSPACE_ROOT/agboss-examples"
  git checkout chore/pre-release-remediation
  git pull --ff-only origin chore/pre-release-remediation
  node scripts/pin-framework-sha.mjs --sha "$FINAL_MAIN_FRAMEWORK_SHA" --branch main
  git add .agboss-version.json
  git diff --cached --quiet || (git commit -m "chore(release): pin .agboss-version.json to agboss main SHA $FINAL_MAIN_FRAMEWORK_SHA" && git push origin chore/pre-release-remediation)

  # 2. Pin FINAL_MAIN_FRAMEWORK_SHA in agboss.dev PR #2
  cd "$WORKSPACE_ROOT/agboss.dev"
  git checkout chore/pre-release-remediation
  git pull --ff-only origin chore/pre-release-remediation
  node scripts/pin-framework-sha.mjs --sha "$FINAL_MAIN_FRAMEWORK_SHA" --branch main
  git add .agboss-version.json
  git diff --cached --quiet || (git commit -m "chore(release): pin .agboss-version.json to agboss main SHA $FINAL_MAIN_FRAMEWORK_SHA" && git push origin chore/pre-release-remediation)
  ```
- **Expected outcome:** Both `.agboss-version.json` files contain `"frameworkCommit": "<FINAL_MAIN_FRAMEWORK_SHA>"` and `"branch": "main"`, and both PR branches are pushed.
- **Failure / stop condition:** Stop if `pin-framework-sha.mjs` exits non-zero or if pushing to either PR branch fails.

### Step 1.3 — Verify Downstream CI on `FINAL_MAIN_FRAMEWORK_SHA` & ⚠️ [PUBLIC / IRREVERSIBLE] Merge Remaining PRs

- **Working directory:** `$WORKSPACE_ROOT`
- **Exact command:**
  ```bash
  gh pr checks 21 -R agbossjs/agboss-examples --watch
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
  for repo in agboss agboss-examples agboss.dev .github; do
    git -C "$WORKSPACE_ROOT/$repo" checkout main
    git -C "$WORKSPACE_ROOT/$repo" pull --ff-only origin main
  done

  cd "$WORKSPACE_ROOT/agboss"
  npm ci
  make check
  npm audit --omit=dev -w agboss
  ```
- **Expected outcome:** `make check` passes (`0` lint/type/test/doc/root-allowlist errors) and `npm audit --omit=dev -w agboss` reports `found 0 vulnerabilities`.
- **Failure / stop condition:** Stop if `make check` or `npm audit --omit=dev -w agboss` fails.

### Step 2.2 — Pack Final Release Tarballs & Run Full RC Verification Suite (`01`..`07`)

- **Working directory:** `$WORKSPACE_ROOT/agboss-examples`
- **Exact command:**
  ```bash
  cd "$WORKSPACE_ROOT/agboss-examples"
  npm ci
  VERIFY_PINNED_FRAMEWORK_SHA=1 AGBOSS_REPO_DIR="$WORKSPACE_ROOT/agboss" npm run pack:framework
  npm run verify:package
  npm run verify:published -- --from-packed --version 0.1.0
  npm run install:packed
  node scripts/run-all.mjs --provenance rc --include-p1 --reset --mode check
  node scripts/run-all.mjs --provenance rc --include-p1 --mode test
  AGBOSS_OFFLINE_VERIFY=1 node scripts/run-all.mjs --provenance rc --include-p1 --mode demo
  node scripts/collect-results.mjs --provenance rc --require-p1
  npm run install:packed:restore
  cat .packed/manifest.json
  ```
- **Expected outcome:**
  - `verify:package` prints `All package verification checks PASSED`.
  - `verify:published -- --from-packed --version 0.1.0` prints `SOURCE: LOCAL_PACKED_RELEASE_CANDIDATE` and `Clean environment verification PASSED`.
  - `collect-results.mjs --provenance rc --require-p1` prints `Overall Gate: PASSED, P0: PASSED, P1: PASSED, Package: PASSED`.
  - `.packed/manifest.json` displays the final `frameworkCommit` (`FINAL_MAIN_FRAMEWORK_SHA`) and the final `sha256` and `sha512` (`integrity`) hashes for `agboss-0.1.0.tgz` and `agboss-cli-0.1.0.tgz`.
- **Failure / stop condition:** Stop immediately if any gate in `proof-results.json` is not `PASSED` or if `git status --short` in `agboss-examples` is dirty after `install:packed:restore`.

---

## Phase 3 — Tag (`v0.1.0` on `agbossjs/agboss` `main`)

### Step 3.1 — ⚠️ [PUBLIC / IRREVERSIBLE] Create and Push Annotated Tag `v0.1.0`

- **Working directory:** `$WORKSPACE_ROOT/agboss`
- **Exact command:**
  ```bash
  cd "$WORKSPACE_ROOT/agboss"
  test "$(git rev-parse HEAD)" = "$FINAL_MAIN_FRAMEWORK_SHA"
  git status --short # Must be empty
  git tag -a v0.1.0 -m "Release v0.1.0"
  git push origin v0.1.0
  ```
- **Expected outcome:** Annotated tag `v0.1.0` pointing to `$FINAL_MAIN_FRAMEWORK_SHA` is pushed to `origin` (`agbossjs/agboss`).
- **Failure / stop condition:** Stop if `HEAD` does not match `$FINAL_MAIN_FRAMEWORK_SHA`, if the working tree is dirty, or if tag `v0.1.0` already exists on `origin`.

---

## Phase 4 — Publish (`agboss@0.1.0` First, Then `agboss-cli@0.1.0`)

> **Why `agboss` must be published before `agboss-cli`:** `packages/agboss-cli/package.json` declares `"agboss": "0.1.0"` in `dependencies`. Publishing `agboss` first ensures `agboss@0.1.0` is resolvable on `registry.npmjs.org` as soon as `agboss-cli@0.1.0` is installed by consumers.

### Step 4.1 — Verify npm Account Identity, Permissions, Registry State & Dry-Run

- **Working directory:** `$WORKSPACE_ROOT/agboss`
- **Exact command:**
  ```bash
  cd "$WORKSPACE_ROOT/agboss"
  # 1. Confirm npm account identity & collaborator write permissions on both unscoped packages
  npm whoami
  npm access list collaborators agboss
  npm access list collaborators agboss-cli

  # 2. Inspect existing registry versions & dist-tags (confirm 0.1.0 is NOT yet published)
  npm view agboss versions dist-tags deprecated --json
  npm view agboss-cli versions dist-tags deprecated --json

  # 3. Run dry-run publish for both workspaces to verify tarball contents & flags without mutating npm
  npm publish --workspace=agboss --access public --tag latest --dry-run
  npm publish --workspace=agboss-cli --access public --tag latest --dry-run
  ```
- **Expected outcome:**
  - `npm whoami` prints the authorized maintainer username with read-write access to both `agboss` and `agboss-cli`.
  - `versions` lists `["0.0.0-stage", "0.0.1"]` and does **not** contain `"0.1.0"`.
  - Both `--dry-run` commands exit `0` and list `agboss@0.1.0` (`668` files) and `agboss-cli@0.1.0` (`228` files).
- **Failure / stop condition:** Stop if `npm whoami` fails (run `npm login`), if collaborator permissions are missing, if `0.1.0` already exists on npm, or if `--dry-run` reports unexpected files or errors.

### Step 4.2 — ⚠️ [PUBLIC / IRREVERSIBLE] Publish `agboss@0.1.0` First & Confirm Registry Availability

- **Working directory:** `$WORKSPACE_ROOT/agboss`
- **Exact command:**
  ```bash
  cd "$WORKSPACE_ROOT/agboss"
  # If your npm account requires a 2FA OTP code, append --otp=<code> or authenticate via web prompt:
  npm publish --workspace=agboss --access public --tag latest

  # Confirm agboss@0.1.0 is live and undeprecated on registry.npmjs.org before publishing agboss-cli:
  npm view agboss@0.1.0 version dist-tags deprecated --json
  ```
- **Expected outcome:** `npm view agboss@0.1.0 version` returns `"0.1.0"`, `dist-tags.latest` is `"0.1.0"`, and `deprecated` is undefined/empty on `0.1.0`.
- **Failure / stop condition:** **STOP IMMEDIATELY** if `npm publish --workspace=agboss` fails, if `npm view agboss@0.1.0 version` does not resolve to `"0.1.0"`, or if `deprecated` is non-empty on `agboss@0.1.0`. Do **not** publish `agboss-cli` until `agboss@0.1.0` is live.

### Step 4.3 — ⚠️ [PUBLIC / IRREVERSIBLE] Publish `agboss-cli@0.1.0` Second & Verify Both Packages

- **Working directory:** `$WORKSPACE_ROOT/agboss`
- **Exact command:**
  ```bash
  cd "$WORKSPACE_ROOT/agboss"
  npm publish --workspace=agboss-cli --access public --tag latest

  # Verify exact versions, dist-tags, and non-deprecated status for both packages:
  npm view agboss@0.1.0 version
  npm view agboss-cli@0.1.0 version
  npm view agboss dist-tags --json
  npm view agboss-cli dist-tags --json
  npm view agboss@0.1.0 deprecated
  npm view agboss-cli@0.1.0 deprecated
  ```
- **Expected outcome:**
  - Both `npm view agboss@0.1.0 version` and `npm view agboss-cli@0.1.0 version` output `0.1.0`.
  - Both `dist-tags` objects show `"latest": "0.1.0"`.
  - Both `deprecated` checks on `@0.1.0` return empty output.
- **Failure / stop condition:** **STOP IMMEDIATELY** if `agboss-cli@0.1.0` fails to publish, if `dist-tags.latest` is not `0.1.0` on both packages, or if either `0.1.0` version is marked deprecated.

> **Optional Legacy Placeholder Note (`0.0.1` / `@agboss/core` / `@agboss/cli`):**
> In npm, deprecation metadata is **per-version**. Publishing `agboss@0.1.0` and `agboss-cli@0.1.0` automatically makes `latest` (`0.1.0`) undeprecated, while `agboss@0.0.1` retains its historical per-version deprecation notice. No `npm deprecate` command is required for `agboss@0.1.0` or `agboss-cli@0.1.0`. If the owner optionally wishes to update the deprecation message on the legacy scoped placeholders `@agboss/core@0.0.1` and `@agboss/cli@0.0.1` so they point to unscoped `agboss` and `agboss-cli`, the owner may manually run:
> ```bash
> npm deprecate "@agboss/core@*" "Deprecated placeholder: install unscoped 'agboss' instead (npm install agboss)."
> npm deprecate "@agboss/cli@*" "Deprecated placeholder: install unscoped 'agboss-cli' instead (npm install -D agboss-cli)."
> ```

---

## Phase 5 — Registry Smoke (Live npm Consumer & 7-Example Verification)

### Step 5.1 — Run Isolated Live-Registry Consumer & CLI Scaffold Smoke Test

- **Working directory:** `$WORKSPACE_ROOT/agboss-examples`
- **Exact command:**
  ```bash
  cd "$WORKSPACE_ROOT/agboss-examples"
  npm run verify:published -- --live-registry --version 0.1.0
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
  cd "$WORKSPACE_ROOT/agboss-examples"
  npm run install:published -- --live-registry --version 0.1.0
  node scripts/run-all.mjs --provenance published --include-p1 --reset --mode check
  node scripts/run-all.mjs --provenance published --include-p1 --mode test
  AGBOSS_OFFLINE_VERIFY=1 node scripts/run-all.mjs --provenance published --include-p1 --mode demo
  npm run collect:published
  cat published-proof-report.md
  ```
- **Expected outcome:**
  - `install:published` installs `agboss@0.1.0` and `agboss-cli@0.1.0` from `https://registry.npmjs.org/` across all 7 examples (`01`..`07`), confirms zero `file:`/tarball/symlink/workspace links, and writes `.packed/published-manifest.json`.
  - `npm run collect:published` writes `published-proof-results.json` and `published-proof-report.md` (`Provenance Type: PUBLISHED_NPM_REGISTRY`) with `Overall Release Readiness Gate: PASSED`.
- **Failure / stop condition:** **STOP IMMEDIATELY** if any of the 7 examples fails `check`, `test`, or `demo`, or if `collect:published` exits non-zero.

---

## Phase 6 — Website Activation (Switch `agboss.dev` to Published Mode & Deploy)

### Step 6.1 — ⚠️ [PUBLIC / IRREVERSIBLE] Switch `agboss.dev` to Published Mode (`v0.1.0` / `latest`), Verify & Push to `main`

- **Working directory:** `$WORKSPACE_ROOT/agboss.dev`
- **Exact command:**
  ```bash
  cd "$WORKSPACE_ROOT/agboss.dev"
  git checkout main
  git pull --ff-only origin main

  # 1. Switch RELEASE_META and documentation callouts from pre-release (v0.1.0-rc) to published (v0.1.0 / latest):
  npm run release:mode -- --published

  # 2. Validate release metadata, compile all 413 documentation snippets, build static HTML, and re-verify dist/:
  npm run verify:release-meta
  VERIFY_PINNED_FRAMEWORK_SHA=1 AGBOSS_REPO_DIR="$WORKSPACE_ROOT/agboss" npm run check:docs
  npm run build
  npm run verify:release-meta

  # 3. Commit and push to main (triggers .github/workflows/deploy.yml to deploy https://agboss.dev):
  git add src/config/release.ts src/content/docs/index.mdx src/content/docs/getting-started/installation.md src/content/docs/getting-started/quick-start.md src/content/docs/changelog.md src/content/docs/community.mdx src/content/docs/examples/job-scout.md SECURITY.md
  git commit -m "chore(release): activate v0.1.0 published mode on agboss.dev"
  git push origin main
  ```
- **Expected outcome:**
  - `npm run release:mode -- --published` updates `RELEASE_META` (`isPublishedToRegistry: true`, `displayVersion: 'v0.1.0'`, `releaseChannelLabel: 'latest'`, `softwareVersion: '0.1.0'`), header badges, homepage install cards, quickstart/installation callouts, changelog, and security policy.
  - `verify:release-meta`, `check:docs`, and `build` all pass with zero `v0.1.0-rc` strings in `dist/`.
  - Pushing to `main` triggers the `Deploy` workflow on `agbossjs/agboss.dev`.
- **Failure / stop condition:** Stop and do not push if `verify:release-meta`, `check:docs`, or `build` fails.

### Step 6.2 — Watch Production Website Deployment Workflow

- **Working directory:** `$WORKSPACE_ROOT/agboss.dev`
- **Exact command:**
  ```bash
  # Watch the website deployment workflow on main to completion:
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
  cd "$WORKSPACE_ROOT/agboss"
  gh release create v0.1.0 \
    --repo agbossjs/agboss \
    --verify-tag \
    --title "AGBoss v0.1.0" \
    --notes-file .github/RELEASE_NOTES_v0.1.0.md \
    "$WORKSPACE_ROOT/agboss-examples/published-proof-report.md" \
    "$WORKSPACE_ROOT/agboss-examples/published-proof-results.json"
  ```
  *(Alternatively, create the release manually at `https://github.com/agbossjs/agboss/releases/new?tag=v0.1.0`, paste the contents of `.github/RELEASE_NOTES_v0.1.0.md` reproduced in the appendix below, and attach `published-proof-report.md` and `published-proof-results.json`.)*
- **Expected outcome:** `https://github.com/agbossjs/agboss/releases/tag/v0.1.0` is published with release notes and the attached `published-proof-report.md` and `published-proof-results.json` evidence files.
- **Failure / stop condition:** Stop if tag `v0.1.0` does not exist on `origin` or if `published-proof-report.md` was not generated from `--provenance published`.

---

## Phase 8 — Final Public Verification

### Step 8.1 — End-to-End Public Endpoints & Clean `npx agboss@0.1.0 create` Check

- **Working directory:** Temporary directory outside `$WORKSPACE_ROOT`
- **Exact command:**
  ```bash
  # 1. Verify live npm registry metadata
  npm view agboss@0.1.0 version dist-tags.latest deprecated
  npm view agboss-cli@0.1.0 version dist-tags.latest deprecated

  # 2. Verify live GitHub Release
  gh release view v0.1.0 -R agbossjs/agboss

  # 3. Verify live website headers and version badge
  curl -fsSL https://agboss.dev | grep -E 'data-release-mode="published"|v0\.1\.0'

  # 4. Run a clean end-user scaffold test from the public npm registry
  TMP_PUBLIC_TEST="$(mktemp -d)"
  cd "$TMP_PUBLIC_TEST"
  npx --yes agboss@0.1.0 create public-verify-app --yes
  cd public-verify-app
  npm run check
  rm -rf "$TMP_PUBLIC_TEST"
  ```
- **Expected outcome:**
  - `npm view` shows `0.1.0` (`latest`) with empty `deprecated` for both packages.
  - `gh release view v0.1.0` displays the published GitHub Release.
  - `https://agboss.dev` serves `data-release-mode="published"` and `v0.1.0`.
  - `npx --yes agboss@0.1.0 create public-verify-app --yes && cd public-verify-app && npm run check` succeeds end to end from the public npm registry.
- **Failure / stop condition:** If any check fails, investigate immediately before announcing the release externally.

---

# Appendix — Proposed `v0.1.0` GitHub Release Draft (`.github/RELEASE_NOTES_v0.1.0.md`)

The following Markdown is saved in `.github/RELEASE_NOTES_v0.1.0.md` and can be copy-pasted directly into the GitHub Release UI:

```markdown
# AGBoss v0.1.0 — First Public Framework & CLI Release

**AGBoss** ([agboss.dev](https://agboss.dev)) is an open-source TypeScript framework and static graph compiler for building multi-agent workflows on top of [LangGraph](https://www.langchain.com/langgraph). It combines constructor dependency injection (`@Application`, `@Injectable`), narrow `@Dto` data contracts (`agboss/dto`), compile-time Path Scope workflow verification (`agboss check`), declarative saga compensation (`compensateWith` / `committedBy`), pre-call FinOps budgets (`@Budget`), deterministic testing (`agboss/testing`), and 13 bundled AI coding-agent skill guides (`SKILL.md` + `references/01..13`).

---

## Versioning & Package Note (`0.0.1` → `0.1.0`)

- **`0.1.0` is the first substantive public release** of the `agboss` runtime and `agboss-cli` command-line toolkit.
- Earlier `0.0.1` entries on `registry.npmjs.org` were initial package-name reservation placeholders containing no framework code, and `v0.0.2` appeared only in early pre-release documentation drafts before the v2 architecture was consolidated into `0.1.0`.
- Canonical packages on npm are unscoped **`agboss`** (`dependencies`) and **`agboss-cli`** (`devDependencies`).

---

## Requirements

- **Node.js:** `>= 22.13.0` (tested on Node.js 22.13+ and Node.js 24 LTS)
- **TypeScript:** `>= 5.8` (`^5.9.3` recommended, with `experimentalDecorators: true` and `emitDecoratorMetadata: false`)
- **License:** Apache License 2.0 ([`LICENSE`](https://github.com/agbossjs/agboss/blob/main/LICENSE), [`NOTICE`](https://github.com/agbossjs/agboss/blob/main/NOTICE))

---

## Installation

### Option 1 — Create a new project

npx agboss create my-app
cd my-app
npm install

### Option 2 — Add to an existing project

npm install agboss
npm install -D agboss-cli
npx agboss check

---

## Key Capabilities in `v0.1.0`

- **Application Container & Constructor DI (`agboss`):** `@Application` wires workflows, typed environment contracts (`secret()`, `env()`, `env.optional()`), custom DI providers, mandatory `@Budget` classes (`Application`, `Tenant`, and `Execution` scopes), `@PiiPolicy`, `@InputGuardrail` / `@OutputGuardrail`, `@ToolInterceptor`, `@HealthCheck` (`app.checkLiveness()` / `app.checkReadiness()`), and `createApp(App)` lifecycle hooks.
- **Path Scope Flow DSL & Static Compiler (`agboss check`):** Chain-per-line `HarnessDSL` (`start(Start).returns(Dto).toAgent(Agent).toFinish(Finish)`, `.chooseOne(route())`, `.switch(caseOf())`, `.toParallelAgents()`, `.joinQuorum()`) backed by generated `.agboss/types.d.ts` (`Produced<Dto, Producer>`). Catches missing inputs (`[input.missing-on-path]`), stale review-loop values (`[input.outdated-on-path]`), sibling invalidation (`[launch.branch-outdates-sibling]`), and uncompensated side effects (`[flow.uncompensated-action]`) before any model call executes.
- **Declarative Sagas, Quorums & Human Pauses:** `@Action({ compensateWith, committedBy })` with automatic LIFO rollback on failure, cancellation, or quorum `Surplus`; `@Arbiter` quorum joins; and durable two-phase human-in-the-loop pauses (`@ChannelRole`, `@ReplyInterpreter`, `@Channel`, `app.resume({ pauseId, decision })`).
- **Multi-Instance Durability & Distributed Work-Stealing:** 10 pluggable repository contracts with built-in in-memory and SQLite WAL implementations (`Sqlite*Repository`), 30-second fenced execution leases, crash recovery sweeps, cross-instance `app.cancel(threadId)`, and `ChildPlacement.AnyInstance` distributed child workflow work-stealing.
- **MCP, RAG & Signed Agent Mesh (`agboss/mcp`, `agboss/rag`, `agboss/a2a`):** Typed `@McpServer` / `@McpTool` wrappers, `@Rag` knowledge bases, `@A2AExpose` / `@A2AAgent` cross-service calls with signed JWS envelopes (`agboss-mesh`), `agboss check --federation`, and the read-only `agboss hub` visualizer.
- **Testing & Multi-Run Evaluation (`agboss/testing`, `agboss/eval`):** `testWith(App)` with scripted models, `VirtualClock`, `TestConcurrency.inOrder`, 10 component unit runners (`testTool`, `testAction`, `testRouter`, `testArbiter`, `testGuardrail`, `testPii`, `testToolInterceptor`, `testRag`, `testJudge`, `testCompaction`), and `@EvalSuite` (`agboss eval run`, `pass@k` / `pass^k`, `--baseline --fail-on-regression`, `--chaos`, `--metamorphic`, Cohen's κ calibration, and `agboss eval show --html` / `agboss eval ui`).
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
