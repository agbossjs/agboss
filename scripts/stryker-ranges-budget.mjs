// The `budget-*` shards of #1366: the functions that refuse a step, a call or a reply for a budget, and count the spend a
// refusal travels with — in files with other code (split from stryker-ranges.mjs for max-lines).
import { wholeFile } from "./stryker-ranges-whole.mjs";

/**
 * The `budget-loop` shard (#1366): an agent's loop and its budgets — the check before each model call and the one
 * after it with what it cost, the model-call and tool-call limits, the exhausted signal on the calls in flight, the
 * spend of a tool, of the input's guardrails and files and of the judges counted at once (#338), the check before a
 * question is asked and the mesh budget a tool call hands on.
 */
export function budgetLoopShard() {
  return {
    configFile: "vitest.mutation-budget-loop.config.ts",
    mutate: [
      "src/graph/agent-loop/model-node.ts",
      "src/graph/agent-loop/tools-node.ts",
      "src/graph/agent-loop/input-node.ts",
      "src/graph/agent-loop/approval-node.ts",
      // the calls prepared before any approval (#1295c): the spend of their PII search and of the hooks' services
      "src/graph/agent-loop/prepare-node.ts",
      "src/graph/agent-loop/question-ask.ts",
      // what a move's call ids keep and the call that never reaches a tool (#1295c)
      "src/graph/agent-loop/move-entries.ts",
      "src/graph/agent-loop/call-output.ts",
      "src/graph/agent-loop/limits.ts",
      "src/graph/agent-loop/judge-budget.ts",
      // what a judge reads of the answer is left out: it is not spend, and its checks are those of the answer's shape
      ...wholeFile("src/graph/agent-loop/judge-node.ts", {
        answeredClassesOf:
          "names the class each value of the answer was given with, by the position of its answer tool: no number, limit, deadline, step count, spend, ledger id, fence or cancel is decided there",
        classAt:
          "picks one item's class out of that list: no number, limit, deadline, step count, spend, ledger id, fence or cancel is decided there",
        itemValuesOf:
          "takes the values out of a list answer's items for the judge: no number, limit, deadline, step count, spend, ledger id, fence or cancel is decided there",
        listClassOf:
          "names the one class a list judge reads its items as: no number, limit, deadline, step count, spend, ledger id, fence or cancel is decided there",
        judgedInputOf:
          "shapes the input one judge reads (the answer, its class, the task, the attempt number and the visit's tool calls, as the judge's own handler sees them): no limit is checked and no spend is counted there",
      }),
      "src/graph/agent-loop/mesh-call.ts",
    ],
  };
}

/**
 * The `budget-flow` shard (#1366): the flow's visits and its launches' budgets — the limits a visit checks and the
 * spend it and its owed undo carry, the exhausted signal a branch watches, the check before an arbiter's model
 * call and the spend of a guardrail on an answer's files.
 */
export function budgetFlowShard() {
  return {
    configFile: "vitest.mutation-budget-flow.config.ts",
    mutate: [
      "src/flow/runtime/visit-write.ts",
      "src/flow/runtime/visit.ts",
      "src/flow/runtime/launch/branch-view.ts",
      "src/flow/runtime/launch/arbiters.ts",
      "src/flow/runtime/launch/arbiter-call.ts",
      "src/flow/runtime/launch/arbiter-live.ts",
      "src/flow/runtime/runners/answer-guard.ts",
    ],
  };
}

/**
 * The `budget-reply` shard (#1366): the reading of a free-text reply against the tree's budgets (#267 PR 3) — the
 * meter it is counted in, the check before its model call and the record of what it cost.
 */
export function budgetReplyShard() {
  return {
    configFile: "vitest.mutation-budget-reply.config.ts",
    mutate: ["src/app/reply-answer.ts", "src/channels/reply-reading.ts"],
  };
}

/**
 * The `assembly-rules` shard (#1366, round 4 of acceptance X): the assembly's rules on a limit or a price — the
 * limits of the application and its providers' timeouts and prices, a workflow's step and concurrency limits, the
 * count limits of a flow and of a question tool, a question's deadline and working time, a limit handler that spends,
 * a tool's expiry and the health check's timers — and the list that wires them in. Every file is mutated whole.
 */
export function assemblyRulesShard() {
  return {
    configFile: "vitest.mutation-assembly-rules.config.ts",
    mutate: [
      "src/models/provider-mode-rules.ts",
      "src/application/application-rules.ts",
      "src/application/limit-rules.ts",
      "src/channels/channel-rules.ts",
      "src/channels/pause-target-rules.ts",
      "src/channels/pause-setting-rules.ts",
      "src/components/tool-expiry-rules.ts",
      "src/flow/analyse/rules/options.ts",
      "src/flow/analyse/rules/limit-handlers.ts",
      "src/flow/analyse/question-expiry.ts",
      "src/channels/working-time-rules.ts",
      "src/flow/analyse/rules/recursion.ts",
      "src/flow/analyse/steps.ts",
      "src/flow/analyse/steps-default.ts",
      "src/flow/analyse/strongly-connected.ts",
      "src/health/health-check.ts",
      // #1321: which storage holds the leases, the idempotency keys and the retention
      "src/storage/storage-assembly.ts",
      "src/storage/storage-rules.ts",
      "src/storage/storage-secret-rules.ts",
      "src/storage/ttl-problem.ts",
      // #1286b: which database the forks of an IsolatedWorker child share
      "src/application/isolated-storage.ts",
      // #1324e: the tenant gate of App — a call that names no tenant is refused before any store is read
      "src/app/tenant-gate.ts",
      "src/application/tenant-gated-app.ts",
      "src/application/execution-listing.ts",
    ],
  };
}
