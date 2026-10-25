# AGBoss Release Process & Verification Checklist

This document specifies the reproducible pre-publication verification pipeline and the post-publication registry verification procedure for releasing `agboss` and `agboss-cli`.

> **Important:** Do not publish packages (`npm publish`), create release tags, or update production dist-tags until every Pre-Publication Gate (Steps 1–12) passes and the project owner explicitly authorizes publication.

---

## Canonical Package Identities

| Package      | Role                                                                                                                                                                                                                                                                                                                                                       | Target Registry                         | License      | Node Engine |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------ | ----------- |
| `agboss`     | Production runtime (`dependencies`) — decorators, DI container, workflow graph compiler/runtime, storage contracts, subpath exports (`agboss/dto`, `agboss/models`, `agboss/units`, `agboss/testing`, `agboss/eval`, `agboss/mcp`, `agboss/rag`, `agboss/a2a`, `agboss/memory`, `agboss/eslint`), schemas, and bundled AI coding skills (`skills/agboss/`) | `https://registry.npmjs.org/agboss`     | `Apache-2.0` | `>=20`      |
| `agboss-cli` | Developer & CI companion (`devDependencies`) — `agboss` / `agb` CLI binary (`create`, `generate`, `check`, `describe`, `dev`, `studio`, `chat`, `run`, `eval`, `records`, `hub`, `rag`, `migrate`)                                                                                                                                                         | `https://registry.npmjs.org/agboss-cli` | `Apache-2.0` | `>=20`      |

> **Historical Registry Note:** `0.0.1` entries on npm (`agboss@0.0.1`, `agboss-cli@0.0.1`, `@agboss/core@0.0.1`, `@agboss/cli@0.0.1`) were initial setup placeholders. The canonical packages for v0.1.0+ are unscoped `agboss` and `agboss-cli`. When `agboss@0.1.0` is published by the owner, publishing a new version clears the legacy deprecation notice on `agboss@0.0.1`.

---

## Phase 1 — Pre-Publication Verification Gate (Release Candidate)

Run all steps from a clean checkout of the candidate commit in `agbossjs/agboss` and `agbossjs/agboss-examples`.

### 1. Record Exact Source Commit & Environment

```bash
git -C ../agboss rev-parse HEAD
node --version
npm --version
```

### 2. Clean Installation & Full Framework CI Gate (`agbossjs/agboss`)

```bash
cd ../agboss
npm ci
make check
node scripts/check-docs.mjs --wiki ../agboss.wiki
```

`make check` verifies:

- Clean build of `packages/agboss` and `packages/agboss-cli`
- Public API surface reports (`packages/agboss/api/*.api.md`)
- Documentation code block compilation (`scripts/check-docs.mjs`)
- Prettier formatting (`npm run format:check`)
- ESLint (`npm run lint`)
- TypeScript strict typechecking (`npm run typecheck`)
- Full Vitest suite with coverage thresholds (`npm run test:coverage`)

### 3. Build & Pack Release-Candidate Tarballs (`npm pack`)

From `agbossjs/agboss-examples`:

```bash
cd ../agboss-examples
AGBOSS_REPO_DIR=../agboss npm run pack:framework
```

This builds `agboss` and `agboss-cli`, runs `npm pack --json`, moves `agboss-<version>.tgz` and `agboss-cli-<version>.tgz` into `.packed/`, and writes `.packed/manifest.json` containing:

- `sourceCommit`
- `packedAt`
- `agboss` (`name`, `version`, `filename`, `sha256`, `shasum`, `integrity`, `entryCount`)
- `agbossCli` (`name`, `version`, `filename`, `sha256`, `shasum`, `integrity`, `entryCount`)

### 4. Tarball Contents, Isolated Consumer & Clean Scaffold Verification

```bash
cd ../agboss-examples
npm run verify:package
```

`scripts/verify-package.mjs` validates:

1. **Tarball inventory:** `dist/index.js`, `dist/index.d.ts`, `schemas/profile.schema.json`, `skills/agboss/SKILL.md`, and all 13 reference guides (`01-overview-and-mental-model.md` .. `13-migrating-from-langgraph.md`) in `agboss-<version>.tgz`, plus `dist/bin.js` in `agboss-cli-<version>.tgz`.
2. **Isolated consumer project (outside both repositories in OS temp dir):** installs only the packed `.tgz` tarballs, resolves `agboss`, `agboss/dto`, `agboss/models`, `agboss/units`, `agboss/testing`, `agboss/eval`, `agboss/mcp`, `agboss/rag`, `agboss/a2a`, `agboss/memory`, `agboss/eslint`, and executes `npx agboss --version` and `npx agboss --help`.
3. **Clean `agboss create` scaffold (outside both repositories in OS temp dir):** runs `agboss create verify-app --no-install`, verifies generated `package.json` (`agboss` in `dependencies`, `agboss-cli` in `devDependencies`), `AGENTS.md`, `CLAUDE.md`, installs the packed tarballs, runs `npx agboss check` (verifying `.agboss/types.d.ts` and `.claude/skills/agboss/.agboss-skills.json`), runs `npx tsc --noEmit`, and runs `npm test` (Vitest deterministic suite).
4. Writes `.packed/package-verification.json` with machine-readable verification evidence.

### 5. Standalone Examples Verification (P0 + P1 Check, Test, and Offline Demo)

Temporarily install packed tarballs into `01`..`07`, run all static checks, tests, and offline deterministic demos, collect the proof report, and restore public `package.json` specs:

```bash
cd ../agboss-examples
npm run install:packed
node scripts/run-all.mjs --include-p1 --mode check
node scripts/run-all.mjs --include-p1 --mode test
node scripts/run-all.mjs --include-p1 --mode demo
npm run collect:results
npm run install:packed -- --restore
```

Alternatively, trigger the manual GitHub Actions workflow **Packed Release Candidate** (`packed-release.yml`) in `agbossjs/agboss-examples` with the target `agboss_ref` commit SHA.

### 6. Website & Documentation Validation (`agbossjs/agboss.dev`)

```bash
cd ../agboss.dev
npm ci
npm run check:docs
npm run build
```

### 7. Security & Supply-Chain Audit

```bash
npm --prefix ../agboss audit --audit-level=moderate
npm --prefix ../agboss-examples audit --audit-level=moderate
npm --prefix ../agboss.dev audit --audit-level=moderate
```

---

## Phase 2 — Owner-Approved Publication (Manual Only)

> **DO NOT EXECUTE IN AUTOMATED AUDITS.** Only the project owner executes these commands after Phase 1 sign-off.

1. Tag the verified commit in `agbossjs/agboss`:
   ```bash
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push origin v0.1.0
   ```
2. Publish `agboss` and `agboss-cli` from `agbossjs/agboss`:
   ```bash
   npm publish --workspace=agboss --access public
   npm publish --workspace=agboss-cli --access public
   ```
3. Verify registry metadata (`npm view agboss@0.1.0`, `npm view agboss-cli@0.1.0`) and deprecate legacy scoped placeholders (`@agboss/core`, `@agboss/cli`) if needed.

---

## Phase 3 — Post-Publication Registry Verification

Once `0.1.0` is live in the public npm registry, run the post-publication smoke check from `agbossjs/agboss-examples`:

```bash
cd ../agboss-examples
npm run verify:published -- --version 0.1.0
```

This creates an isolated temporary directory, runs `npx --yes agboss-cli@0.1.0 create published-smoke-app --no-install`, installs `agboss@0.1.0` and `agboss-cli@0.1.0` directly from the public npm registry without local tarballs, and verifies `npx agboss check` + `.agboss/types.d.ts` + `.claude/skills/agboss/` synchronization.
