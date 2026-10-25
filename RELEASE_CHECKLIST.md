# AGBoss Release Process & Verification Checklist

This document specifies the reproducible pre-publication verification pipeline, owner-controlled merge & publication sequence, and post-publication public registry verification procedure for releasing `agboss` and `agboss-cli`.

> **Important:** Do not publish packages (`npm publish`), create release tags, merge PRs, or update production dist-tags until every Pre-Publication Gate (Phase A, Steps A.1–A.9) passes and the project owner explicitly authorizes publication.

---

## Canonical Package Identities

| Package      | Role                                                                                                                                                                                                                                                                                                                                                                                                                  | Target Registry                         | License      | Node Engine (`engines.node`) | Recommended CI/Dev Node (`.nvmrc`) |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------ | ---------------------------- | ---------------------------------- |
| `agboss`     | Production runtime (`dependencies`) — decorators, DI container, workflow graph compiler/runtime, storage contracts, subpath exports (`agboss/dto`, `agboss/models`, `agboss/units`, `agboss/testing`, `agboss/testing/setup`, `agboss/eval`, `agboss/mcp`, `agboss/rag`, `agboss/a2a`, `agboss/memory`, `agboss/eslint`), JSON Schema (`schema/profile.schema.json`), and bundled AI coding skills (`skills/agboss/`) | `https://registry.npmjs.org/agboss`     | `Apache-2.0` | `>=22.13`                    | `24`                               |
| `agboss-cli` | Developer & CI companion (`devDependencies`) — `agboss` / `agboss-cli` CLI binary (`bin/agboss.js` → `dist/cli.js`: `create`, `generate`, `check`, `describe`, `dev`, `studio`, `chat`, `run`, `eval`, `records`, `hub`, `rag`, `migrate`). Depends on `"agboss": "0.1.0"`.                                                                                                                                           | `https://registry.npmjs.org/agboss-cli` | `Apache-2.0` | `>=22.13`                    | `24`                               |

> **Registry & Deprecation Metadata Note:** `0.0.1` entries on npm (`agboss@0.0.1`, `agboss-cli@0.0.1`, `@agboss/core@0.0.1`, `@agboss/cli@0.0.1`) were initial setup placeholders. The canonical packages for `v0.1.0+` are unscoped `agboss` and `agboss-cli`. In npm, deprecation metadata is **per-version**: publishing `agboss@0.1.0` and `agboss-cli@0.1.0` publishes new undeprecated versions pointed to by the `latest` dist-tag, while `agboss@0.0.1` retains its historical per-version deprecation metadata unless explicitly altered with `npm deprecate`. Always verify `npm view agboss@0.1.0 deprecated` and `npm view agboss-cli@0.1.0 deprecated` (both must be empty) after publication.

---

## Provenance & Commit Pinning Model

Cross-repository verification distinguishes two commit states and two artifact provenance modes:

1. **Commit States:**
   - **Verified Remediation Branch Candidate (`chore/pre-release-remediation`):** The pre-merge candidate commit in `agbossjs/agboss` pinned in `agboss-examples/.agboss-version.json` and `agboss.dev/.agboss-version.json` during PR verification (Phase A).
   - **Final Integrated `main` Release Commit (`main`):** The commit created on `agbossjs/agboss` `main` when the remediation PR is merged (especially if squash- or rebase-merged). Before merging `agboss-examples` or `agboss.dev` and before tagging/publishing `v0.1.0`, `.agboss-version.json` in downstream repositories must be updated to this final `main` SHA and re-verified (Phase B, Steps B.1–B.4).

2. **Evidence Provenance Modes (`agboss-examples`):**
   - **Release-Candidate Provenance (`--provenance rc`):** Bound to `.packed/manifest.json` (`sourceCommit` + `examplesSourceCommit` + local `.tgz` `sha256` & `integrity`), `.packed/package-verification.json`, and `.packed/last-run.json`. Writes `proof-results.json` and `proof-report.md`.
   - **Published-Package Provenance (`--provenance published`):** Bound to `.packed/published-manifest.json` (`provenanceType: "PUBLIC_NPM_REGISTRY"`, exact published package versions, npm registry `dist.integrity` & `dist.shasum`, `examplesSourceCommit`, and zero `file:`/tarball/symlink/workspace links), `.packed/published-verification.json` (`source: "PUBLIC_NPM_REGISTRY"`), and `.packed/last-run-published.json`. Writes `published-proof-results.json` and `published-proof-report.md`. Published provenance rejects stale RC artifacts and cannot inherit PASS results from an earlier RC run.

---

## Phase A — Pre-Publication Release-Candidate Gate (Steps A.1–A.9)

Run all steps from a clean checkout of the candidate commits in `agbossjs/agboss`, `agbossjs/agboss-examples`, and `agbossjs/agboss.dev`.

### Step A.1 — Record Exact Source Commits & Environment

```bash
git -C ../agboss rev-parse HEAD
git -C ../agboss-examples rev-parse HEAD
git -C ../agboss.dev rev-parse HEAD
node --version   # Must satisfy >=22.13 (.nvmrc specifies 24)
npm --version
```

Verify that `.agboss-version.json` in both `agboss-examples` and `agboss.dev` matches `git -C ../agboss rev-parse HEAD`.

### Step A.2 — Clean Installation & Full Framework CI Gate (`agbossjs/agboss`)

```bash
cd ../agboss
npm ci
make check
node scripts/check-docs.mjs --wiki ../agboss.wiki
```

`make check` (`npm run check`) executes:

- Root workspace boundary & suppression checks (`npm run check:root`, `npm run check:suppressions`, `npm run check:types`)
- Clean build of `packages/agboss` and `packages/agboss-cli` (`npm run build`)
- In-repo example verification (`npm run types -w job-scout-example`, `npm run check -w flow-patterns-example`, `npm run check:models`)
- Public API surface reports (`npm run check:api` against `packages/agboss/api/*.api.md`)
- Documentation code block compilation (`npm run check:docs` via `scripts/check-docs.mjs`)
- Prettier formatting (`npm run format:check`), ESLint (`npm run lint`), and Knip unused-export checks (`npm run check:knip`)
- TypeScript strict typechecking (`npm run typecheck`)
- Full Vitest suite with coverage thresholds (`npm run coverage`)

### Step A.3 — Build & Pack Release-Candidate Tarballs (`npm pack`)

From `agbossjs/agboss-examples`:

```bash
cd ../agboss-examples
VERIFY_PINNED_FRAMEWORK_SHA=1 AGBOSS_REPO_DIR=../agboss npm run pack:framework
```

This verifies that `../agboss` HEAD matches `.agboss-version.json`, builds `agboss` and `agboss-cli`, runs `npm pack --json`, moves `agboss-<version>.tgz` and `agboss-cli-<version>.tgz` into `.packed/`, and writes `.packed/manifest.json` containing:

- `sourceCommit` and `examplesSourceCommit`
- `packedAt`
- `packages.agboss` (`name`, `version`, `filename`, `sha256`, `shasum`, `integrity`, `size`, `entryCount`)
- `packages.agbossCli` (`name`, `version`, `filename`, `sha256`, `shasum`, `integrity`, `size`, `entryCount`)

### Step A.4 — Tarball Inventory, Isolated Consumer & Clean Scaffold Verification

```bash
cd ../agboss-examples
npm run verify:package
```

`scripts/verify-package.mjs` validates:

1. **Tarball inventory:**
   - `agboss-<version>.tgz`: `bin/agboss.js`, `dist/index.js`, `dist/index.d.ts`, `schema/profile.schema.json`, `skills/agboss/SKILL.md`, and all 13 reference guides (`skills/agboss/references/01-composition-and-architecture.md` .. `13-migrating-from-langgraph.md`).
   - `agboss-cli-<version>.tgz`: `bin/agboss.js`, `dist/cli.js`, and `templates/`.
2. **Isolated consumer project (outside both repositories in OS temp dir):** installs only the packed `.tgz` tarballs, resolves `agboss`, `agboss/dto`, `agboss/models`, `agboss/units`, `agboss/testing`, `agboss/testing/setup`, `agboss/eval`, `agboss/mcp`, `agboss/rag`, `agboss/a2a`, `agboss/memory`, `agboss/eslint`, and executes `npx agboss --help`, `npx agboss help --json`, and `npx agboss-cli --help`.
3. **Clean `agboss create` scaffold (outside both repositories in OS temp dir):** runs `agboss create verify-app --skip-install`, verifies generated `package.json` (`agboss` in `dependencies`, `agboss-cli` in `devDependencies`), `AGENTS.md`, `CLAUDE.md`, installs the packed tarballs, runs `npx agboss check` (verifying `.agboss/types.d.ts` and `.claude/skills/agboss/.agboss-skills.json` with 13 reference files), runs `npx tsc --noEmit`, runs `npm test` (Vitest deterministic suite), and runs `npx agboss describe --json`.
4. Writes `.packed/package-verification.json` with machine-readable verification evidence tied to `sourceCommit` and tarball integrity hashes.

### Step A.5 — Pre-Release Verification of the Post-Publication Smoke Harness (`--from-packed`)

Verify the exact consumer & scaffold harness used after publication (`scripts/verify-published.mjs`) in explicit `--from-packed` mode:

```bash
cd ../agboss-examples
npm run verify:published -- --from-packed --version 0.1.0
```

This prints `SOURCE: LOCAL_PACKED_RELEASE_CANDIDATE`, verifies all 11 public subpath exports (`agboss`, `agboss/dto`, `agboss/units`, `agboss/models`, `agboss/testing`, `agboss/testing/setup`, `agboss/eval`, `agboss/mcp`, `agboss/rag`, `agboss/a2a`, `agboss/eslint`), CLI binary resolution (`agboss --help`, `agboss help --json`, `agboss-cli --help`), `agboss create published-smoke-app --yes --skip-install`, `npx agboss check`, `npx tsc --noEmit`, `npm test`, and `npx agboss describe --json`, and writes `.packed/published-verification.json` with `source: "LOCAL_PACKED_RELEASE_CANDIDATE"` (never claiming that live npm registry verification passed).

### Step A.6 — Standalone Examples Verification (P0 + P1 Check, Test, and Offline Demo)

Temporarily install packed tarballs into `01`..`07`, run harness unit tests and all static checks, tests, and offline deterministic demos (`AGBOSS_OFFLINE_VERIFY=1`), collect the RC proof report, and restore public `package.json` specs:

```bash
cd ../agboss-examples
npm run test:harness
npm run install:packed
node scripts/run-all.mjs --provenance rc --include-p1 --reset --mode check
node scripts/run-all.mjs --provenance rc --include-p1 --mode test
AGBOSS_OFFLINE_VERIFY=1 node scripts/run-all.mjs --provenance rc --include-p1 --mode demo
node scripts/collect-results.mjs --provenance rc --require-p1
npm run install:packed -- --restore
```

`collect-results.mjs --provenance rc --require-p1` fails closed if any project directory is missing, if any P0 or P1 check/test/demo is `FAILED`, `SKIPPED`, or `NOT_RUN`, if `.packed/package-verification.json` has failed checks, or if `.packed/last-run.json` provenance does not match the current `sourceCommit`, `examplesSourceCommit`, and tarball hashes.

### Step A.7 — Cross-Repository GitHub Actions CI Gate (`agbossjs/agboss-examples`)

Push the candidate commits to the open PR branches so `.github/workflows/smoke.yml` / `.github/workflows/packed-release.yml` executes the packed release-candidate pipeline in GitHub Actions against the exact pinned `frameworkSha` in `.agboss-version.json` and uploads `.packed/manifest.json`, `.packed/package-verification.json`, `.packed/published-verification.json`, `.packed/last-run.json`, `proof-results.json`, and `proof-report.md` as CI workflow artifacts.

### Step A.8 — Website & Documentation Compilation Gate (`agbossjs/agboss.dev`)

```bash
cd ../agboss.dev
npm ci
npm run verify:release-meta
npm run check:docs
npm run build
```

Verify that:

- `npm run verify:release-meta` confirms `src/config/release.ts` (`RELEASE_META`) cleanly drives both pre-release mode (`isPublishedToRegistry: false`) and published mode (`isPublishedToRegistry: true`) without leaving mixed prerelease/published labels across `nav.ts`, `Header.astro`, `Head.astro`, `InstallCards.astro`, or `index.mdx`.
- `.github/workflows/deploy.yml` in `agbossjs/agboss.dev` checks out the pinned `agbossjs/agboss` commit from `.agboss-version.json`, builds the framework, runs `npm run verify:release-meta`, `npm run check:docs`, and `npm run build` cleanly.

### Step A.9 — Security & Supply-Chain Audit

```bash
npm --prefix ../agboss audit --omit=dev
npm --prefix ../agboss audit --audit-level=moderate
npm --prefix ../agboss-examples audit --audit-level=moderate
npm --prefix ../agboss.dev audit --audit-level=moderate
```

Confirm `0` production runtime vulnerabilities in `packages/agboss` (`npm --prefix ../agboss audit --workspace=agboss --omit=dev`) and verify that every remaining workspace/CLI advisory is documented with a full reachability and mitigation assessment in `PRE_RELEASE_READINESS_REPORT.md`.

---

## Phase B — Owner-Approved Merge, Final SHA Pinning & Publication (Steps B.1–B.8, Manual Only)

> **DO NOT EXECUTE IN AUTOMATED AUDITS.** Only the project owner executes these commands after Phase A sign-off.

### Step B.1 — Merge `agbossjs/agboss` PR to `main` First & Record `FINAL_MAIN_FRAMEWORK_SHA`

Because squash or rebase merging produces a new commit SHA on `agbossjs/agboss` `main`, merge the `agbossjs/agboss` PR (#465) **first**, then pull `main` and record the exact integrated commit SHA:

```bash
cd ../agboss
git checkout main
git pull --ff-only origin main
FINAL_MAIN_FRAMEWORK_SHA="$(git rev-parse HEAD)"
echo "FINAL_MAIN_FRAMEWORK_SHA=${FINAL_MAIN_FRAMEWORK_SHA}"
make check
```

### Step B.2 — Pin `FINAL_MAIN_FRAMEWORK_SHA` in `agboss-examples` and `agboss.dev` Before Merging Their PRs

Update `.agboss-version.json` in `agbossjs/agboss-examples` and `agbossjs/agboss.dev` to `FINAL_MAIN_FRAMEWORK_SHA` so no repository merges to `main` with a pre-squash branch SHA:

```bash
cd ../agboss-examples
node scripts/pin-framework-sha.mjs --sha "${FINAL_MAIN_FRAMEWORK_SHA}" --branch main
git commit -am "chore(release): pin .agboss-version.json to final agboss main SHA ${FINAL_MAIN_FRAMEWORK_SHA}"
git push origin chore/pre-release-remediation

cd ../agboss.dev
node scripts/pin-framework-sha.mjs --sha "${FINAL_MAIN_FRAMEWORK_SHA}" --branch main
git commit -am "chore(release): pin .agboss-version.json to final agboss main SHA ${FINAL_MAIN_FRAMEWORK_SHA}"
git push origin chore/pre-release-remediation
```

Wait for the GitHub Actions PR workflows in `agbossjs/agboss-examples` (`Smoke CI`) and `agbossjs/agboss.dev` (`Build & Verify Docs`) to complete with status `success` against `FINAL_MAIN_FRAMEWORK_SHA`.

### Step B.3 — Merge Downstream PRs into `main`

Once CI is green on `FINAL_MAIN_FRAMEWORK_SHA`:

1. Merge `agbossjs/agboss-examples` PR (#21) into `main`.
2. Merge `agbossjs/agboss.dev` PR (#2) into `main` (note: `src/config/release.ts` still has `isPublishedToRegistry: false` at this stage so `agboss.dev` does not advertise live npm installation until Phase C completes).
3. Merge `agbossjs/.github` PR (#2) into `main`.

### Step B.4 — Final Integrated `main` Tarball Build & Verification

Checkout `main` in both `agbossjs/agboss` and `agbossjs/agboss-examples`, rebuild the release tarballs from `FINAL_MAIN_FRAMEWORK_SHA`, and verify all checks before tagging or publishing:

```bash
cd ../agboss-examples
git checkout main
git pull --ff-only origin main

VERIFY_PINNED_FRAMEWORK_SHA=1 AGBOSS_REPO_DIR=../agboss npm run pack:framework
npm run verify:package
npm run verify:published -- --from-packed --version 0.1.0
npm run install:packed
node scripts/run-all.mjs --provenance rc --include-p1 --reset --mode check
node scripts/run-all.mjs --provenance rc --include-p1 --mode test
AGBOSS_OFFLINE_VERIFY=1 node scripts/run-all.mjs --provenance rc --include-p1 --mode demo
node scripts/collect-results.mjs --provenance rc --require-p1
npm run install:packed -- --restore
```

Record the final tarball `sha256` and `integrity` checksums from `.packed/manifest.json`.

### Step B.5 — Tag the Verified Release Commit in `agbossjs/agboss`

```bash
cd ../agboss
git checkout main
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

### Step B.6 — Publish `agboss` First, Then `agboss-cli` to npm

Because `agboss-cli@0.1.0` declares `"agboss": "0.1.0"` in `dependencies`, publish `agboss` **first**, verify its availability in the public npm registry, and then publish `agboss-cli`:

```bash
cd ../agboss
npm publish --workspace=agboss --access public

# Confirm agboss@0.1.0 is resolvable before publishing agboss-cli:
npm view agboss@0.1.0 version

npm publish --workspace=agboss-cli --access public
```

### Step B.7 — Verify npm Registry Metadata, Dist-Tags & Deprecation State

Verify that `latest` resolves to `0.1.0` for both packages, that `dist.integrity` is populated, and that `0.1.0` has no deprecation flag:

```bash
npm view agboss dist-tags --json
npm view agboss-cli dist-tags --json
npm view agboss@0.1.0 version dist.integrity deprecated
npm view agboss-cli@0.1.0 version dist.integrity deprecated
```

Ensure legacy scoped placeholders (`@agboss/core@0.0.1`, `@agboss/cli@0.0.1`) direct users to unscoped `agboss` and `agboss-cli`:

```bash
npm deprecate "@agboss/core@*" "Deprecated placeholder: install unscoped 'agboss' instead (npm install agboss)."
npm deprecate "@agboss/cli@*" "Deprecated placeholder: install unscoped 'agboss-cli' instead (npm install -D agboss-cli)."
```

---

## Phase C — Post-Publication Live Registry Verification & Website Activation (Steps C.1–C.4)

### Step C.1 — Run Live Registry Isolated Consumer & Scaffold Verification (`--live-registry`)

Once `agboss@0.1.0` and `agboss-cli@0.1.0` are live on `https://registry.npmjs.org`, run `scripts/verify-published.mjs` in explicit `--live-registry` mode:

```bash
cd ../agboss-examples
npm run verify:published -- --live-registry --version 0.1.0
```

`scripts/verify-published.mjs --live-registry --version 0.1.0` enforces:

1. Prints `SOURCE: PUBLIC_NPM_REGISTRY` (never falls back to `.packed/*.tgz`).
2. Queries `npm view agboss@0.1.0 --json`, `npm view agboss-cli@0.1.0 --json`, `npm view agboss dist-tags --json`, and `npm view agboss-cli dist-tags --json`, verifying exact version `0.1.0`, `latest` dist-tag alignment, and that `deprecated` is unset.
3. Creates a fresh temporary consumer directory outside all repositories, installs `agboss@0.1.0` and `agboss-cli@0.1.0` directly from the public npm registry, confirms `node_modules` resolution with zero `file:`, tarball, symlink, or workspace links, and verifies all 11 public subpath exports (`agboss`, `agboss/dto`, `agboss/units`, `agboss/models`, `agboss/testing`, `agboss/testing/setup`, `agboss/eval`, `agboss/mcp`, `agboss/rag`, `agboss/a2a`, `agboss/eslint`) plus CLI binary resolution (`agboss --help`, `agboss help --json`, `agboss-cli --help`).
4. Runs `agboss create published-smoke-app --yes --skip-install` in a clean temp directory, verifies `package.json`, `AGENTS.md`, `CLAUDE.md`, installs `agboss@0.1.0` and `agboss-cli@0.1.0` from the public npm registry, and runs and validates:
   - `npx agboss check` (verifies `.agboss/types.d.ts` and `.claude/skills/agboss/SKILL.md` + 13 reference files)
   - `npx tsc --noEmit`
   - `npm test`
   - `npx agboss describe --json`
5. Writes `.packed/published-verification.json` with `status: "PASSED"` and `source: "PUBLIC_NPM_REGISTRY"`.

### Step C.2 — Install Published Packages Across All 7 Examples & Collect Published Proof Report

Install `agboss@0.1.0` and `agboss-cli@0.1.0` from the public npm registry across all 7 standalone examples (`01`..`07`), run all static checks, tests, and offline deterministic demos under `--provenance published`, and generate the published proof report:

```bash
cd ../agboss-examples
npm run install:published -- --live-registry --version 0.1.0
node scripts/run-all.mjs --provenance published --include-p1 --reset --mode check
node scripts/run-all.mjs --provenance published --include-p1 --mode test
AGBOSS_OFFLINE_VERIFY=1 node scripts/run-all.mjs --provenance published --include-p1 --mode demo
npm run collect:published
```

What this pipeline guarantees:

- `npm run install:published -- --live-registry --version 0.1.0` (`scripts/install-published.mjs`) verifies registry metadata, installs `agboss@0.1.0` and `agboss-cli@0.1.0` from `https://registry.npmjs.org` into `01`..`07` (removing any `.tgz` or `file:` specs), verifies that every installed package in `01`..`07/node_modules` resolves to version `0.1.0` from the registry tarball integrity hash with zero local symlinks or workspace links, and writes `.packed/published-manifest.json` (`provenanceType: "PUBLIC_NPM_REGISTRY"`).
- `run-all.mjs --provenance published` verifies that every example's `node_modules` matches `.packed/published-manifest.json` before executing each check/test/demo, and writes `.packed/last-run-published.json`.
- `npm run collect:published` (`node scripts/collect-results.mjs --provenance published --require-p1`) validates `.packed/published-manifest.json`, `.packed/published-verification.json` (`source === "PUBLIC_NPM_REGISTRY"`), and `.packed/last-run-published.json`, fails closed on any missing/skipped/failed P0 or P1 check, test, or demo, and writes `published-proof-results.json` and `published-proof-report.md`.

### Step C.3 — Switch `agboss.dev` to Published Mode & Deploy Website

Only after Steps C.1 and C.2 pass against the live npm registry, update `agbossjs/agboss.dev/src/config/release.ts`:

```ts
export const RELEASE_META = {
  isPublishedToRegistry: true,
  displayVersion: 'v0.1.0',
  releaseChannelLabel: 'latest',
  softwareVersion: '0.1.0',
  // ...
} as const;
```

Validate and push to `agbossjs/agboss.dev` `main`:

```bash
cd ../agboss.dev
git checkout main
git pull --ff-only origin main
# Update src/config/release.ts to isPublishedToRegistry: true, displayVersion: 'v0.1.0', releaseChannelLabel: 'latest', softwareVersion: '0.1.0'
npm run verify:release-meta
npm run check:docs
npm run build
git commit -am "chore(release): activate v0.1.0 published registry mode"
git push origin main
```

Then verify live production endpoints:

- `https://agboss.dev`
- `https://agboss.dev/installation/`
- `https://agboss.dev/quick-start/`
- `https://agboss.dev/features/`
- `https://agboss.dev/llms.txt`
- `https://agboss.dev/llms-full.txt`
- `https://agboss.dev/sitemap-index.xml`

### Step C.4 — Create the `v0.1.0` GitHub Release on `agbossjs/agboss`

Create the GitHub Release from tag `v0.1.0` and attach the post-publication verification report (`published-proof-report.md` and `published-proof-results.json`):

```bash
cd ../agboss
gh release create v0.1.0 \
  --verify-tag \
  --title "AGBoss v0.1.0" \
  --notes-file ../agboss-examples/published-proof-report.md \
  ../agboss-examples/published-proof-report.md \
  ../agboss-examples/published-proof-results.json
```
