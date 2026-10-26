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

```bash
npm exec --yes --package=@agboss/cli -- agboss create my-app
cd my-app
npm install
```

`npm exec --yes --package=@agboss/cli -- agboss create my-app` (also available via `npx --yes --package=@agboss/cli agboss create my-app`) scaffolds a complete TypeScript project with `@agboss/core` in `dependencies`, `@agboss/cli` in `devDependencies`, `AGENTS.md`, and `CLAUDE.md`. Running `npm install` triggers `"postinstall": "npm run types"`, which runs `agboss check`, generates `.agboss/types.d.ts`, and unpacks 13 version-matched reference guides into `.claude/skills/agboss/` (`SKILL.md` + `references/01..13`).

### Option 2 — Add to an existing project

```bash
npm install @agboss/core
npm install -D @agboss/cli
npx agboss check
```

---

## Key Capabilities in `v0.1.0`

- **Application Container & Constructor DI (`@agboss/core`):** `@Application` wires workflows, typed environment contracts (`secret()`, `env()`, `env.optional()`), custom DI providers, mandatory `@Budget` classes (`Application`, `Tenant`, and `Execution` scopes), `@PiiPolicy`, `@InputGuardrail` / `@OutputGuardrail`, `@ToolInterceptor`, `@HealthCheck` (`app.checkLiveness()` / `app.checkReadiness()`), and `createApp(App)` lifecycle hooks.
- **Path Scope Flow DSL & Static Compiler (`agboss check`):** Chain-per-line `HarnessDSL` (`start(Start).returns(Dto).toAgent(Agent).toFinish(Finish)`, `.chooseOne(route())`, `.switch(caseOf())`, `.toParallelAgents()`, `.joinQuorum()`) backed by generated `.agboss/types.d.ts` (`Produced<Dto, Producer>`). Catches missing inputs (`[input.missing-on-path]`), stale review-loop values (`[input.outdated-on-path]`), sibling invalidation (`[launch.branch-outdates-sibling]`), and uncompensated side effects (`[flow.uncompensated-action]`) before any model call executes.
- **Declarative Sagas, Quorums & Human Pauses:** `@Action({ compensateWith, committedBy })` with automatic LIFO rollback on failure, cancellation, or quorum `Surplus`; `@Arbiter` quorum joins; and durable two-phase human-in-the-loop pauses (`@ChannelRole`, `@ReplyInterpreter`, `@Channel`, `app.resume({ pauseId, decision })`).
- **Multi-Instance Durability & Distributed Work-Stealing:** 10 pluggable repository contracts with built-in in-memory and SQLite WAL implementations (`Sqlite*Repository`), 30-second fenced execution leases, crash recovery sweeps, cross-instance `app.cancel(threadId)`, and `ChildPlacement.AnyInstance` distributed child workflow work-stealing.
- **MCP, RAG & Signed Agent Mesh (`@agboss/core/mcp`, `@agboss/core/rag`, `@agboss/core/a2a`):** Typed `@McpServer` / `@McpTool` wrappers, `@Rag` knowledge bases, `@A2AExpose` / `@A2AAgent` cross-service calls with signed JWS envelopes (`agboss-mesh`), `agboss check --federation`, and the read-only `agboss hub` visualizer.
- **Testing & Multi-Run Evaluation (`@agboss/core/testing`, `@agboss/core/eval`):** `testWith(App)` with scripted models, `VirtualClock`, `TestConcurrency.inOrder`, 10 component unit runners (`testTool`, `testAction`, `testRouter`, `testArbiter`, `testGuardrail`, `testPii`, `testToolInterceptor`, `testRag`, `testJudge`, `testCompaction`), and `@EvalSuite` (`agboss eval run`, `pass@k` / `pass^k`, `--baseline --fail-on-regression`, `--chaos`, `--metamorphic`, Cohen's $\kappa$ calibration, and `agboss eval show --html` / `agboss eval ui`).
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

---

## Verification Evidence

- Verified across the `agboss` monorepo test suite (`make check`), isolated tarball consumer and CLI scaffold verification (`verify-package.mjs` and `verify-published.mjs`), all 7 standalone architecture and fault-injection example projects (`01-hello-agboss` through `07-langgraph-migration` in [`agbossjs/agboss-examples`](https://github.com/agbossjs/agboss-examples)), and `413` compiled documentation code blocks across `66` files on [`agboss.dev`](https://github.com/agbossjs/agboss.dev).
- See the attached `published-proof-report.md` and `published-proof-results.json` release assets for exact package `sha512`/`sha256` checksums and per-example verification gates.
