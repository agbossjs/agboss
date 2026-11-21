// The `budget-*` shards of #1366: the functions that refuse a step, a call or a reply for a budget, and count the spend a
// refusal travels with — in files with other code (split from stryker-ranges.mjs for max-lines).
import { declarationsOf } from "./stryker-ranges-money.mjs";

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
      // the checks around a model call, the model call with the spend a failure of it carries, the limits and the
      // exhausted signal; the tools' definitions and the call's ids are not budget rules
      ...declarationsOf(
        "src/graph/agent-loop/model-node.ts",
        "withExhausted",
        "observedCall",
        "checkBudget",
        "checkSpent",
        "checkModelCalls",
        "makeModelNode",
      ),
      // a tool's own spend counted the moment it is reported, the signal of its call, the spend of its arguments'
      // guardrail and of closing its result, and the update that carries it to the loop
      ...declarationsOf(
        "src/graph/agent-loop/tools-node.ts",
        "guardedCall",
        "runTask",
        "endedTaskOf",
      ),
      // the check before a file's model call, and the input's spend counted at once
      ...declarationsOf(
        "src/graph/agent-loop/input-node.ts",
        "guardedInput",
        "inputFilesOf",
        "makeInputNode",
      ),
      // the checks before a question is asked, the spend a question's expiry or a failed ask carries and the
      // interpreter's spend
      ...declarationsOf(
        "src/graph/agent-loop/approval-node.ts",
        "approvalOf",
        "expiryOf",
        "askedOrFailed",
        "checkBeforeAsking",
        "askQuestion",
      ),
      // the tool-call limit an agent runs under, a value that is no count read as 0 (#1373)
      ...declarationsOf("src/graph/agent-loop/limits.ts", "resolveAgentLimits"),
      // the judges' spend counted at once and what a rejection carries
      ...declarationsOf("src/graph/agent-loop/judge-node.ts", "rejectionsOf", "makeJudgeNode"),
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
      // the edge a visit leaves by, and the spend of a router whose decision names no route of its own
      ...declarationsOf("src/flow/runtime/visit-write.ts", "exitOf"),
      ...declarationsOf(
        "src/flow/runtime/visit.ts",
        "failedCompensations",
        "withOwnCompensations",
        "succeeded",
        "visitNode",
      ),
      ...declarationsOf(
        "src/flow/runtime/launch/branch-view.ts",
        "branchStateOf",
        "budgetStopOf",
        "withBudgetStop",
        "branchFrameOf",
      ),
      ...declarationsOf(
        "src/flow/runtime/launch/arbiters.ts",
        "byCode",
        "byModel",
        "judgeOnce",
        "judgeAnswer",
      ),
      ...declarationsOf(
        "src/flow/runtime/runners/answer-guard.ts",
        "answerFilesViewed",
        "guardedAnswer",
      ),
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
    mutate: [
      ...declarationsOf("src/app/reply-answer.ts", "treeMeterOf", "replyAnsweringOf"),
      ...declarationsOf("src/channels/reply-reading.ts", "byModel", "readReplyBy"),
    ],
  };
}
