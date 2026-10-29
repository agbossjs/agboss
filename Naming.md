# Naming

One name lets you guess the others (#127, #268): the same patterns everywhere — in decorators, the
CLI, traces, records, `agboss describe` and errors. What [Components](Components) and the
[CLI](CLI) apply, in one place.

## A name ends with its kind

Every component's `name` is kebab-case, its qualifier in front and its kind last, and unique in the
application (`[name.kind-suffix]`, `[graph.duplicate-node-name]`); its class is the same in
PascalCase:

| Kind | `name` | Class |
| --- | --- | --- |
| `@Application` | `job-scout-application` | `JobScoutApplication` |
| `@Workflow` | `screening-workflow` | `ScreeningWorkflow` |
| `@WorkflowStart` / `@WorkflowFinish` | `chat-workflow-start` / `chat-workflow-finish` | `ChatWorkflowStart` / `ChatWorkflowFinish` |
| `@Agent`, `@Router`, `@Action`, `@Arbiter` | `ranker-agent`, `main-router`, `enrich-company-action`, `in-range-arbiter` | `RankerAgent`, `MainRouter`, … |
| `@Tool`, `@McpTool` | `save-shortlist-tool` | `SaveShortlistTool` |
| `@Rag` | `jobs-rag` (its tool: `search-jobs-rag-tool`) | `JobsRag` |
| `@Budget`, `@ModelProvider`, `@HealthCheck`, … | `tenant-daily-budget`, `openrouter-model-provider`, `crm-health-check` | … |

DTO classes end with `Dto` (`ScoreDto`, `[dto.name]`); an `@Injectable` is named by its role —
`…Service`, `…Repository`, `…Provider` (#280) — and a field holding it after its type
(`private readonly ordersService: OrdersService`).

### The class name too — `@Application` and `@Budget`

`[name.kind-suffix]` checks the `name` of every component and, for the `@Application` and each
`@Budget`, the class name as well: it must end with the kind in PascalCase (`…Application`,
`…Budget`). The classes of other kinds follow the same convention (`RankerAgent`, `MainRouter`)
without a check. A budget class named by what it limits but not by its kind fails assembly, with the
name to use:

```ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

// [name.kind-suffix] class DailyLimit — name it DailyLimitBudget
@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class DailyLimit implements BudgetHandler {
  maxSpend(): Usd {
    return usd(40);
  }
}
```

The fix is the class name alone — the `name` was already right:

```ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(40);
  }
}
```

The same for the application: `@Application({ name: "desk-application", … }) class Desk` →
`[name.kind-suffix] class Desk — name it DeskApplication`.

## Tool names

A project's tool follows the kind-suffix rule like every other component: `name:
"save-shortlist-tool"`, kebab-case, checked at assembly with the name to use
(`"save_shortlist" on @Tool — name it "save-shortlist-tool"`). A knowledge base's automatic tool is
`search-<rag name>-tool`; the framework's answer tools are `answer-<dto>`. Tools of an external MCP
server keep the names the server gives (`read_text_file`, in `@McpServer({ tools })`) — the model sees
the `@McpTool` that calls them. Every name a model sees fits the providers' limit (OpenAI, Anthropic,
Gemini): `[a-zA-Z0-9_-]`, at most 64 characters (`[tool.name-too-long]`, `[tool.name-invalid]`).
[Tools](Tools#names).

## `Workflow…` is the definition, `Execution…` one execution

| The definition | One execution |
| --- | --- |
| `@Workflow`, `@WorkflowStart`, `@WorkflowFinish`, `WorkflowRecord` (`name`, `version`), `WorkflowPauseQuestionDto` | `app.execute`, `ExecutionOutput` (`executionId`), `ExecutionContext`, `ExecutionId`, `ExecutionStatus`, `PausedExecution`, `ExecutionRecord` |
| | the hooks `onExecutionStart`, `onExecutionPause`, `onExecutionResume`, `onExecutionEnd`, `onExecutionError`, `onExecutionRejected`; `ExecutionCancelledError` |

Nothing execution-time is named `run…`: `result.executionId` (not `runId`), `IncompatibleResume`
`{ threadId, executionId }`, `executeAgent` / `AgentExecutionDeps` / `AgentExecutionOptions` /
`executionVersions` for the lower-level loop.

## Values with units

A limit reads as what it is — `usd(0.5)`, `seconds(30)`, `minutes(2)` (`@agboss/core/units`), never a bare
number, no `Ms` / `Usd` in names. Every timeout is one: `@Tool({ timeout: seconds(5) })`,
`@ModelProvider({ timeout: minutes(2) })`, `@HealthCheck({ timeout: seconds(2) })`; a join's waiting
limit is a different thing, its `deadline` (`.joinQuorum({ min, deadline: seconds(30) })`).

## Folders: one domain level, kind folders, a folder per workflow (#474)

A file's folder says its kind, as its name does. `src/` holds kind folders (`workflows/`, `agents/`,
`routers/`, `dto/`, `tools/`, `services/`, …), optionally under **one** domain level —
`src/[<domain>/]<kind>/…`, e.g. `src/billing/agents/refund/refund.agent.ts`. A domain is any folder
that is not a kind folder; it holds only kind folders (no loose file, no second domain). The
application file and `environments/` stay at the `src/` root. A workflow's folder is named after it
without its kind (`refund-workflow` → `workflows/refund/refund.workflow.ts`, its starts and finishes
beside it); a prompt-bearing component's after its name likewise (`refund-agent` →
`agents/refund/refund.agent.ts` + `refund.prompt.md`); a DTO's file after its class
(`OrderLineDto` → `dto/order-line.dto.ts`). [Components](Components#project-layout-474).

## The CLI takes full names

The command is `agboss`. Every name it takes is the full, kind-suffixed `name` — `--start
screening-workflow-start`, `--workflow job-scout-workflow`, `agboss generate agent ranker-agent`,
`--rag jobs-rag` — so `grep "screening-workflow-start"` finds every use, CI scripts included. Nothing
is completed or guessed: a name not found is exit 2 with `Did you mean "…"?` and the list, and
nothing runs or is written. [CLI](CLI).

**Standalone examples of canonical `1 class = 1 file` component subfolder layout and symmetric `tests/`:** [`01-hello-agboss`](https://github.com/agbossjs/agboss-examples/tree/main/01-hello-agboss) through [`07-langgraph-migration`](https://github.com/agbossjs/agboss-examples/tree/main/07-langgraph-migration) in [`agbossjs/agboss-examples`](https://github.com/agbossjs/agboss-examples) — see [Example](Example#standalone-verified-applications-agbossjsagboss-examples).
