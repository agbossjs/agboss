# AGBoss

[![CI](https://github.com/agbossjs/agboss/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/agbossjs/agboss/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/agbossjs/agboss/badges/coverage.json)](https://github.com/agbossjs/agboss)

Typed agent workflows on LangGraph, in TypeScript. Agents, tools, MCP servers and knowledge bases are
**Angular-style components** — annotated classes, wired by a `@Workflow` module, dependencies through
the constructor, every link checked by the compiler. Routing and judging by decision models (Jev, …),
FinOps on every call, Terns and evaluation, profiles and comparisons, tracing.

The repository holds two things:

1. **The framework** — the npm package `agboss` (`packages/agboss`), its CLI `agboss`
   (`packages/agboss-cli`) and the example `examples/job-scout`.
2. **The delivery conveyor** — how the code is built with Claude Code: tickets move
   **Triage → Backlog → In progress → Test → Done** on the repo's board. See
   [Delivery Pipeline](Delivery-Pipeline).

Every ` ```ts ` block of this wiki compiles against the current package: CI clones the wiki and runs
`node scripts/check-docs.mjs --wiki wiki` (the same check as the repo's docs).

---

## Quick start

```bash
npx -p agboss-cli agboss create my-agents   # questionnaire → a working project (see [CLI](CLI))
cd my-agents && cp .env.example .env && npm run chat
```

Or add it to a project: `npm i agboss` and `npm i -D agboss-cli`, then write the
components ([Components](Components)).

## Agent Core

```mermaid
flowchart LR
  T([message]) --> B{daily limit left?}
  B -- no --> X([LimitExceededError, no calls])
  B -- yes --> E[workflow start]
  E --> R{router · Jev<br/>input guardrails}
  R -- profiler / scout / … --> A[agent · Kimi<br/>input + output guardrails]
  A --> C[workflow finish]
  C --> O([answer + path + cost report])
```

The workflow file is the graph: **paths** through a **workflow start**, **routers**, **agents**,
**actions** and **workflow finishes**, each step's result written on the edge ([Workflow](Workflow)).
A message enters at the workflow start; a **router** chooses one of its routes, an **agent** reads
its typed input from the path and answers, and the path goes on to a **workflow finish** — loops are
explicit and bounded by `maxVisits`. Limits (steps, visits, spend per run and per day) fail the run
instead of letting it loop, unless the path's `.onError(…)` takes the failure. The result
(`ExecutionOutput`) is the finish's output, the path taken and an itemised cost report.

### What makes it a framework, not an example

| Property                        | How                                                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Components**                  | Agents, tools and MCP servers are annotated classes in folders; a `@Workflow` module wires them by class reference ([Components](Components))                                                                                           |
| **Routing by a decision model** | Routers default to **Jev** (TypeSafe) via the OpenRouter Decisions API: calibrated probabilities over the options and exact cost per call, instead of parsing free text. Any `@Router` can name a chat model instead → [Routers](Routers) |
| **Routers are isolated**        | A router engine sees only `{ input, options }` and returns `decided \| failed`; inside the framework it cannot import the graph or agents (ESLint-enforced) and has its own tests                                                       |
| **Model providers**             | Every model comes from a `@ModelProvider` (OpenRouter and the Decisions API built in): timeouts, retries, circuit breakers, costs, reasoning and caching per provider → [Model providers](Model-providers)                              |
| **FinOps built in**             | Every call is recorded (tokens, cache hits, USD, source of the price). Money is capped by `@Budget` components — per execution, per tenant and for the whole application per day / week / month (UTC), counted call by call in the application's ledger → [FinOps](FinOps)       |
| **Typed end to end**            | Strict TypeScript, DTO classes at every boundary, deps checked against constructors, scripted test turns typed by the tool's input                                                                                                    |
| **Tested without spending**     | `agboss/testing` runs a whole workflow with scripted models and the network blocked ([Testing](Testing)); real calls only in `make smoke`                                                                                         |

### Run the example

```bash
npm install && npm run build          # at the repo root
cd examples/job-scout && npm run chat # "my resume src/data/sample-resume.md"
npm run describe                      # agents, tools, dependencies — no API key
```

More: [Example](Example). `npm run studio` (repo root) opens job-scout in LangGraph Studio —
`agboss studio` in any project, no `studio.ts` or `langgraph.json` of its own ([CLI](CLI#watch-mode-and-studio-268)).

### Public entries

`agboss` (decorators, DI, flow DSL, settings, environments, observers, judges and decisions,
`createApp`, errors, types), `agboss/dto`, `/units`, `/models`, `/testing` (+
`/testing/setup`), and the integrations `/mcp`, `/rag`, `/a2a`, `/memory`. The older entries are
deprecated re-exports; `agboss migrate imports` rewrites them.

### Code map (`packages/agboss/src/`)

| Path          | What lives there                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `application/`, `app/` | `@Application`, `createApp(App)` → `app.execute` / `resume` / `cancel` / `close`; wiring |
| `components/` | `@Tool` `@Agent` `@Injectable` `@Workflow` …, the DI container, assembly                     |
| `graph/`      | the flow DSL, assembly rules, LangGraph build, the agent loop, limits, settings             |
| `dto/`        | field decorators, DTO validation, the standard DTOs                                          |
| `routers/`    | isolated routing engines (Jev, LLM); public inside the framework only via `index.ts`         |
| `models/`     | model providers                                                                              |
| `finops/`     | usage records, cost, daily ledger                                                            |
| `testing/`    | `testWith(App)`, scripted gateway, matchers, VCR                                             |
| `index.ts`    | the root entry `agboss`                                                                |

Module dependency rules: [Architecture](Architecture).

---

## Working in this repo

| Kind of knowledge                                      | Place                                                  |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Tickets, discussion, **specs, implementation plans**   | GitHub Issues                                          |
| How the system works **now**                           | this Wiki                                              |
| Why a significant decision was made                    | Wiki pages `ADR-NNNN-…` → [ADR](ADR)                   |
| Rules for code, types, agents, FinOps, tests · process | `QUALITY.md` · `WORKFLOW.md` · `CLAUDE.md` in the repo |
| The truth                                              | the code                                               |

No specs, plans or docs are stored as files in the repository.

**Board**: [Project](https://github.com/users/PavelRavvich/projects/5) — stage of every ticket; Done is set by a human.

**Branches**: `production ← staging ← dev ← <type>-<issue>` (e.g. `feature-12`). Work starts and
ends in `dev` through a PR; the gate is `make check` (build, API reports, compiled docs, format,
lint, types, tests with coverage).

**Try it:** [Example](Example).
