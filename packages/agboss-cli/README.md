# agboss-cli — Official CLI for AGBoss

[![Docs](https://img.shields.io/badge/docs-agboss.dev%2Fcli-258ceb)](https://agboss.dev/cli/)
[![npm](https://img.shields.io/npm/v/agboss-cli?color=258ceb)](https://www.npmjs.com/package/agboss-cli)
[![License](https://img.shields.io/badge/License-Apache_2.0-258ceb.svg)](https://www.apache.org/licenses/LICENSE-2.0)

`agboss-cli` provides the `agboss` (short alias `agb`) command-line interface for the [**AGBoss**](https://agboss.dev) TypeScript AI agent framework on [LangGraph](https://www.langchain.com/langgraph).

## Quick Start

### Option 1 — Create a new project

```bash
npx agboss create my-app
cd my-app
npm install
```

`npx agboss create my-app` (also available via `npx agboss-cli create my-app`, short alias `agb c`) creates a project with `agboss` in `dependencies`, `agboss-cli` in `devDependencies`, `AGENTS.md`, and `CLAUDE.md` (`@AGENTS.md`). Running `npm install` triggers `"postinstall": "npm run types"`, which runs `agboss check`, generates `.agboss/types.d.ts`, and unpacks 13 version-matched reference guides into `.claude/skills/agboss/` (`SKILL.md` + `references/01..13`) for your AI coding agent.

### Option 2 — Add to an existing project

```bash
npm install agboss
npm install -D agboss-cli
npx agboss check
```

Why two packages?

- **`agboss` (`dependencies`)** — lightweight production runtime (decorators, execution graph, DI container, repository contracts, subpaths `agboss/dto`, `agboss/testing`, `agboss/eval`, `agboss/eslint`, schemas, and bundled AI skills) shipped into Docker / Kubernetes.
- **`agboss-cli` (`devDependencies`)** — static graph compiler (`agboss check`), code generator (`agboss generate`), dev watcher (`agboss dev`), Studio bridge (`agboss studio`), and local UI servers (`agboss eval ui`, `agboss hub ui`) that do not bloat production container images.

## Core Commands

| Command                                                       | Description                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agboss create <name>` (`agb c`)                              | Scaffold a new AGBoss project with `@Application`, workflow, environments, `.agboss/types.d.ts`, 13 AI skill modules, and Vitest tests                                                      |
| `agboss generate <kind> <name>` (`agb g`)                     | Generate and wire an `agent`, `router`, `arbiter`, `tool`, `mcp`, `rag`, `workflow`, `openapi` client, or `eval-case` (`--from-execution <id>`) by full name                                |
| `agboss check`                                                | Generate `.agboss/types.d.ts`, sync `.claude/skills/agboss/`, and statically verify all Flow DSL paths, DTO slots, and assembly rules without calling models                                |
| `agboss check --strict` / `--models` / `--cassettes`          | Treat warnings as errors in CI (`--strict`), verify models against `@ModelProvider` (`--models`), or detect stale VCR cassettes (`--cassettes`)                                             |
| `agboss check --federation <path...>`                         | Verify cross-service `@A2AAgent` / `@McpServer` contracts against `agboss describe --json` snapshots before deployment                                                                      |
| `agboss dev` / `agboss studio`                                | Watch `src/` to regenerate `.agboss/types.d.ts` on save (`dev`), or launch LangGraph Studio for all workflows and child subgraphs (`studio`)                                                |
| `agboss describe [--json]`                                    | Print workflow paths, node inputs by producer, `about` / `historyOf` links, model resolution, budgets, and limits (or export the JSON snapshot with `configHash`/`promptHash`/`schemaHash`) |
| `agboss chat` / `agboss run`                                  | Run interactive multi-turn terminal chat or a single workflow execution                                                                                                                     |
| `agboss eval run`                                             | Run an `@EvalSuite`: each case `--runs` times, pass@k / pass^k, `--chaos <rate>`, `--metamorphic`, `--report <run.json>`, `--html <file>`, and `--baseline` + `--fail-on-regression`        |
| `agboss eval show <run.json> [--html <file>]`                 | Render a saved run artifact table or self-contained HTML report (timelines, baseline diff, divergence node for unstable cases) without calling models                                       |
| `agboss eval ui`                                              | Serve a folder of run artifacts on `127.0.0.1` behind a printed token: runs, reports, human labels, Cohen's κ, and golden cases                                                             |
| `agboss eval calibrate --report <run.json>`                   | Calibrate a saved run's judges against human labels (`eval/labels/<suite>.jsonl`): Cohen's κ, confusion matrix, and disagreements                                                           |
| `agboss eval score` / `agboss compare`                        | Score recorded runs with Jev and compare YAML configuration profiles side by side                                                                                                           |
| `agboss records export`                                       | Export stored `ExecutionRecord`s (`ExecutionHistoryRepository`) for `--tenant <id>` or `--all-tenants` to `--out <file.jsonl>` (`--since`, `--until`)                                       |
| `agboss hub show <path...> [--html <file>]` / `agboss hub ui` | Stitch `describe --json` snapshots and `.jsonl` execution records into a global Agent Mesh graph, cross-service execution trees, Progressive Crystallization Radar, and Blast Radius        |
| `agboss rag index`                                            | Build or update `@Rag` knowledge-base indexes                                                                                                                                               |
| `agboss migrate imports`                                      | Rewrite deprecated sub-entry imports to current `agboss` entries                                                                                                                            |

## Documentation & Links

- **CLI Reference:** [https://agboss.dev/cli/](https://agboss.dev/cli/)
- **Full Documentation:** [https://agboss.dev](https://agboss.dev)
- **Verified Examples Repository:** [https://github.com/agbossjs/agboss-examples](https://github.com/agbossjs/agboss-examples)
- **GitHub Repository:** [https://github.com/agbossjs/agboss](https://github.com/agbossjs/agboss)

## License

Apache License 2.0 — see [`LICENSE`](https://github.com/agbossjs/agboss/blob/main/LICENSE) and [`NOTICE`](https://github.com/agbossjs/agboss/blob/main/NOTICE).
