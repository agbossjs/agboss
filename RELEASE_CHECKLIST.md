# AGBoss Release Process & Verification Checklist

This document specifies the reproducible pre-publication verification pipeline, owner-controlled publication steps, and post-publication registry verification procedure for releasing `agboss` and `agboss-cli`.

> **Important:** Do not publish packages (`npm publish`), create release tags, or update production dist-tags until every Pre-Publication Gate (Phase A, Steps A.1–A.8) passes and the project owner explicitly authorizes publication.

---

## Canonical Package Identities

| Package      | Role                                                                                                                                                                                                                                                                                                                                                                                                                  | Target Registry                         | License      | Node Engine (`engines.node`) | Recommended CI/Dev Node (`.nvmrc`) |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------ | ---------------------------- | ---------------------------------- |
| `agboss`     | Production runtime (`dependencies`) — decorators, DI container, workflow graph compiler/runtime, storage contracts, subpath exports (`agboss/dto`, `agboss/models`, `agboss/units`, `agboss/testing`, `agboss/testing/setup`, `agboss/eval`, `agboss/mcp`, `agboss/rag`, `agboss/a2a`, `agboss/memory`, `agboss/eslint`), JSON Schema (`schema/profile.schema.json`), and bundled AI coding skills (`skills/agboss/`) | `https://registry.npmjs.org/agboss`     | `Apache-2.0` | `>=22.13`                    | `24`                               |
| `agboss-cli` | Developer & CI companion (`devDependencies`) — `agboss` / `agboss-cli` CLI binary (`bin/agboss.js` → `dist/cli.js`: `create`, `generate`, `check`, `describe`, `dev`, `studio`, `chat`, `run`, `eval`, `records`, `hub`, `rag`, `migrate`)                                                                                                                                                                            | `https://registry.npmjs.org/agboss-cli` | `Apache-2.0` | `>=22.13`                    | `24`                               |

> **Registry & Deprecation Metadata Note:** `0.0.1` entries on npm (`agboss@0.0.1`, `agboss-cli@0.0.1`, `@agboss/core@0.0.1`, `@agboss/cli@0.0.1`) were initial setup placeholders. The canonical packages for v0.1.0+ are unscoped `agboss` and `agboss-cli`. In npm, deprecation metadata is **per-version**: publishing `agboss@0.1.0` and `agboss-cli@0.1.0` publishes new undeprecated versions pointed to by the `latest` dist-tag, while `agboss@0.0.1` retains its historical per-version deprecation metadata unless explicitly altered with `npm deprecate`. Always verify `npm view agboss@0.1.0 deprecated` (must be empty) after publication.

---

## Phase A — Pre-Publication Verification Gate (Steps A.1–A.8)

Run all steps from a clean checkout of the candidate commits in `agbossjs/agboss`, `agbossjs/agboss-examples`, and `agbossjs/agboss.dev`.

### Step A.1 — Record Exact Source Commits & Environment

```bash
git -C ../agboss rev-parse HEAD
git -C ../agboss-examples rev-parse HEAD
git -C ../agboss.dev rev-parse HEAD
node --version   # Must satisfy >=22.13 (.nvmrc specifies 24)
npm --version
```

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
AGBOSS_REPO_DIR=../agboss npm run pack:framework
```

This builds `agboss` and `agboss-cli`, runs `npm pack --json`, moves `agboss-<version>.tgz` and `agboss-cli-<version>.tgz` into `.packed/`, and writes `.packed/manifest.json` containing:

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
   - `agboss-<version>.tgz`: `bin/agboss.js`, `dist/index.js`, `dist/index.d.ts`, `schema/profile.schema.json`, `skills/agboss/SKILL.md`, and all 13 reference guides (`skills/agboss/references/01-overview-and-mental-model.md` .. `13-migrating-from-langgraph.md`).
   - `agboss-cli-<version>.tgz`: `bin/agboss.js`, `dist/cli.js`, and `templates/`.
2. **Isolated consumer project (outside both repositories in OS temp dir):** installs only the packed `.tgz` tarballs, resolves `agboss`, `agboss/dto`, `agboss/models`, `agboss/units`, `agboss/testing`, `agboss/testing/setup`, `agboss/eval`, `agboss/mcp`, `agboss/rag`, `agboss/a2a`, `agboss/memory`, `agboss/eslint`, and executes `npx agboss --version` and `npx agboss --help`.
3. **Clean `agboss create` scaffold (outside both repositories in OS temp dir):** runs `agboss create verify-app --skip-install`, verifies generated `package.json` (`agboss` in `dependencies`, `agboss-cli` in `devDependencies`), `AGENTS.md`, `CLAUDE.md`, installs the packed tarballs, runs `npx agboss check` (verifying `.agboss/types.d.ts` and `.claude/skills/agboss/.agboss-skills.json` with 13 reference files), runs `npx tsc --noEmit`, runs `npm test` (Vitest deterministic suite), and runs `npx agboss describe --json`.
4. Writes `.packed/package-verification.json` with machine-readable verification evidence tied to `sourceCommit` and tarball integrity hashes.

### Step A.5 — Standalone Examples Verification (P0 + P1 Check, Test, and Offline Demo)

Temporarily install packed tarballs into `01`..`07`, run all static checks, tests, and offline deterministic demos (`AGBOSS_OFFLINE_VERIFY=1`), collect the proof report, and restore public `package.json` specs:

```bash
cd ../agboss-examples
npm run install:packed
node scripts/run-all.mjs --include-p1 --reset --mode check
node scripts/run-all.mjs --include-p1 --mode test
node scripts/run-all.mjs --include-p1 --mode demo
node scripts/collect-results.mjs --require-p1
npm run install:packed -- --restore
```

`collect-results.mjs --require-p1` fails closed if any project directory is missing, if any P0 or P1 check/test/demo is `FAILED`, `SKIPPED`, or `NOT_RUN`, if `.packed/package-verification.json` has failed checks, or if `.packed/last-run.json` provenance does not match the current `sourceCommit`, `examplesSourceCommit`, and tarball hashes.

### Step A.6 — Cross-Repository GitHub Actions CI Gate (`agbossjs/agboss-examples`)

Push the candidate commits (or open PRs) so `.github/workflows/smoke.yml` / `.github/workflows/packed-release.yml` executes the 12-step packed release-candidate pipeline in GitHub Actions against the exact pinned `framework_sha` in `.agboss-version.json` and uploads `.packed/manifest.json`, `.packed/package-verification.json`, `.packed/last-run.json`, `proof-results.json`, and `proof-report.md` as CI workflow artifacts.

### Step A.7 — Website & Documentation Compilation Gate (`agbossjs/agboss.dev`)

```bash
cd ../agboss.dev
npm ci
npm run check:docs
npm run build
```

Verify that `.github/workflows/deploy.yml` in `agbossjs/agboss.dev` checks out the pinned `agbossjs/agboss` commit from `.agboss-version.json`, builds the framework, runs `npm run check:docs`, and builds the Astro/Starlight site cleanly.

### Step A.8 — Security & Supply-Chain Audit

```bash
npm --prefix ../agboss audit --audit-level=moderate
npm --prefix ../agboss-examples audit --audit-level=moderate
npm --prefix ../agboss.dev audit --audit-level=moderate
```

Confirm `0` production runtime vulnerabilities in `packages/agboss` (`npm --prefix ../agboss audit --omit=dev`).

---

## Phase B — Owner-Controlled Publication (Steps B.1–B.5, Manual Only)

> **DO NOT EXECUTE IN AUTOMATED AUDITS.** Only the project owner executes these commands after Phase A sign-off.

### Step B.1 — Merge Verified Remediation PRs to `main`

Merge the verified release-candidate PRs into `main` across `agbossjs/agboss`, `agbossjs/agboss-examples`, `agbossjs/agboss.dev`, and `agbossjs/.github`, and verify clean `HEAD` on `agbossjs/agboss`:

```bash
cd ../agboss
git checkout main
git pull --ff-only origin main
make check
```

### Step B.2 — Tag the Verified Release Commit in `agbossjs/agboss`

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

### Step B.3 — Publish `agboss` and `agboss-cli` to npm

```bash
npm publish --workspace=agboss --access public
npm publish --workspace=agboss-cli --access public
```

### Step B.4 — Verify npm Registry Dist-Tags and Per-Version Deprecation State

Verify that `latest` resolves to `0.1.0` for both packages and that `0.1.0` has no deprecation warning:

```bash
npm view agboss dist-tags --json
npm view agboss-cli dist-tags --json
npm view agboss@0.1.0 version deprecated
npm view agboss-cli@0.1.0 version deprecated
```

Ensure legacy scoped placeholders (`@agboss/core@0.0.1`, `@agboss/cli@0.0.1`) point users to unscoped `agboss` and `agboss-cli`:

```bash
npm deprecate "@agboss/core@*" "Deprecated placeholder: install unscoped 'agboss' instead (npm install agboss)."
npm deprecate "@agboss/cli@*" "Deprecated placeholder: install unscoped 'agboss-cli' instead (npm install -D agboss-cli)."
```

### Step B.5 — Switch `agboss.dev` Release Flag & Create GitHub Release

In `agbossjs/agboss.dev/src/config/release.ts`, set `isPreRelease: false` and `displayVersion: 'v0.1.0'` so the homepage and installation cards switch from pre-release RC instructions to live npm registry commands, then push to `main` and create the `v0.1.0` GitHub Release on `agbossjs/agboss`.

---

## Phase C — Post-Publication Smoke & Registry Verification (Steps C.1–C.3)

### Step C.1 — Run Automated Post-Publication Smoke Verification

Once `0.1.0` is live in the public npm registry, run the post-publication smoke check from `agbossjs/agboss-examples` with `--live-registry`:

```bash
cd ../agboss-examples
npm run verify:published -- --live-registry --version 0.1.0
```

This script:

1. Queries `npm view agboss@0.1.0 --json` and `npm view agboss-cli@0.1.0 --json` to confirm registry availability and that `deprecated` is unset on `0.1.0`.
2. Creates an isolated temporary directory outside all repositories.
3. Runs `npx --yes --package=agboss-cli@0.1.0 agboss create published-smoke-app --skip-install`.
4. Installs `agboss@0.1.0` and `agboss-cli@0.1.0` directly from `https://registry.npmjs.org` without local tarballs.
5. Verifies `npx agboss check`, `.agboss/types.d.ts`, `.claude/skills/agboss/` (13 reference guides), `npx tsc --noEmit`, and `npm test`.
6. Writes `.packed/published-verification.json`.

### Step C.2 — Verify Example Projects Against Live Registry Packages

In a clean checkout of `agbossjs/agboss-examples` (without `.packed/` tarballs):

```bash
cd ../agboss-examples
npm run install:all
node scripts/run-all.mjs --include-p1 --reset --mode all
node scripts/collect-results.mjs --require-p1
```

### Step C.3 — Verify Production Website & Endpoints

Verify `https://agboss.dev`, `https://agboss.dev/features/`, `https://agboss.dev/llms.txt`, `https://agboss.dev/llms-full.txt`, and `https://agboss.dev/sitemap-index.xml`.
