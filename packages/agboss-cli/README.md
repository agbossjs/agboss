# agboss-cli — Official CLI for AGBoss

[![Docs](https://img.shields.io/badge/docs-agboss.dev%2Fcli-258ceb)](https://agboss.dev/cli/)
[![npm](https://img.shields.io/npm/v/agboss-cli?color=258ceb)](https://www.npmjs.com/package/agboss-cli)
[![License](https://img.shields.io/badge/License-Apache_2.0-258ceb.svg)](https://www.apache.org/licenses/LICENSE-2.0)

`agboss-cli` provides the `agboss` (short alias `agb`) command-line interface for the [**AGBoss**](https://agboss.dev) TypeScript AI agent framework on [LangGraph](https://www.langchain.com/langgraph).

## Quick Start

```bash
# Scaffold a new AGBoss project interactively:
npx -p agboss-cli agboss create my-agents

# Or add the CLI to an existing AGBoss project:
npm i -D agboss-cli
```

## Core Commands

| Command                                     | Description                                                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agboss create <name>` (`agb c`)            | Scaffold a new AGBoss project with `@Application`, workflow, environments, `.agboss/types.d.ts`, and Vitest tests                                                                |
| `agboss generate <kind> <name>` (`agb g`)   | Generate and wire an `agent`, `router`, `arbiter`, `tool`, `mcp`, `rag`, `workflow`, or `openapi` client, by full names: `agboss g agent billing-agent --workflow desk-workflow` |
| `agboss check`                              | Generate `.agboss/types.d.ts` and statically verify all Flow DSL paths, DTO slots, and assembly rules without calling models                                                     |
| `agboss check --strict`                     | Treat analyser and assembly warnings as errors in CI                                                                                                                             |
| `agboss check --models`                     | Verify all configured model settings against their resolved `@ModelProvider`                                                                                                     |
| `agboss describe`                           | Print workflow paths, node inputs by producer, `about` / `historyOf` links, model resolution, budgets, and limits                                                                |
| `agboss describe --json`                    | Export the machine-readable declarative revision snapshot (`configHash`, `promptHash`, `schemaHash`)                                                                             |
| `agboss chat` / `agboss run`                | Run interactive multi-turn terminal chat or a single workflow execution                                                                                                          |
| `agboss eval run`                           | Run an `@EvalSuite`: each case `--runs` times, pass@k / pass^k, the artifact (`--report`); `--baseline` + `--fail-on-regression` exit 5                                          |
| `agboss eval show <run.json>`               | Show a saved run artifact — its table, and with `--html` its self-contained HTML report (timelines, the baseline diff, where unstable attempts part ways), running nothing       |
| `agboss eval ui`                            | Serve a folder of run artifacts on 127.0.0.1 behind a printed token: the runs, each run's report, labels and κ                                                                   |
| `agboss eval calibrate --report <run.json>` | Calibrate a saved run's judges against people's labels (`eval/labels/<suite>.jsonl`): Cohen's κ, confusion, disagreements                                                        |
| `agboss eval score` / `agboss compare`      | Score recorded runs with Jev and compare YAML configuration profiles side by side                                                                                                |
| `agboss rag index`                          | Build or update `@Rag` knowledge-base indexes                                                                                                                                    |
| `agboss migrate imports`                    | Rewrite deprecated sub-entry imports to current `agboss` entries                                                                                                                 |

## Documentation & Links

- **CLI Reference:** [https://agboss.dev/cli/](https://agboss.dev/cli/)
- **Full Documentation:** [https://agboss.dev](https://agboss.dev)
- **GitHub Repository:** [https://github.com/agbossjs/agboss](https://github.com/agbossjs/agboss)

## License

Apache License 2.0 — see [`LICENSE`](https://github.com/agbossjs/agboss/blob/main/LICENSE) and [`NOTICE`](https://github.com/agbossjs/agboss/blob/main/NOTICE).
