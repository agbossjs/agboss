/**
 * #727 — a takeover in the middle of an agent's loop on a child on any instance. The loop's first
 * model call is billed ($10, an invalid answer) and its second asks for a tool, whose first run
 * holds; that worker freezes there, and the other instance reclaims the child and continues its
 * loop from its last checkpoint: the tool again, then two more billed model calls ($10 each). The
 * first call is the earlier pass's, kept in the loop's checkpoint with its ledger identity: counted
 * once when it reaches this pass. The two new calls are new spend: each counted. Every counter
 * holds $30.
 */
import { afterEach, describe, expect } from "vitest";
import { BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { counterOf, type ExecutionBudgetRecord } from "../../src/budgets/execution-budgets.js";
import { CostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import {
  callTool,
  replyWith,
  replyWithInvalidAnswer,
  TestConcurrency,
  testWith,
  type ModelRequest,
} from "../../src/testing/index.js";
import { seconds, usd } from "../../src/units/index.js";
import { readyAll } from "../app/fixtures/child-end-freeze.js";
import { instance } from "../app/fixtures/fence-takeover.js";
import { ItemResultDto } from "../flow/runtime/fixtures/fan-out.workflow.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import {
  LoopHoldTool,
  LoopParentWorkflowStart,
  LoopPayAgent,
  LoopTakeoverApplication,
  loopTakeover,
  resetLoopTakeover,
} from "./fixtures/loop-takeover.workflow.js";

const test = testWith(LoopTakeoverApplication, {
  instances: 2,
  concurrency: TestConcurrency.Real,
});

let release = (): void => undefined;

afterEach(() => {
  release();
});

/** The loop's moves by how far it got — an invalid answer, the hold, an invalid answer, the answer. */
const moveOf = (request: ModelRequest) => {
  const made =
    request.kind === "chat"
      ? request.messages.filter((m) => m.role === "ai" || m.role === "assistant")
      : [];
  if (made.length === 0 || made.length === 2)
    return replyWithInvalidAnswer(ItemResultDto, { name: 7 }, { cost: usd(10) });
  if (made.length === 1) return callTool(LoopHoldTool, { name: "a" });
  return replyWith(ItemResultDto, { name: "a" }, { cost: usd(10) });
};

describe("#727: a takeover in the middle of an agent's loop", () => {
  test("the earlier pass's billed call counts once, the new pass's two each once", async ({
    apps,
    clock,
    leases,
    mockLlm,
  }) => {
    ({ release } = resetLoopTakeover());
    mockLlm(LoopPayAgent).thenAnswer(moveOf);
    const byName = await readyAll(apps);
    const app = instance(apps, 0);
    const call = execute(app, LoopParentWorkflowStart, { name: "a", delay: 0, outcome: "ok" });
    await until(() => loopTakeover.holds.length === 1, "the tool holds on the child's worker");
    const worker = byName.get(loopTakeover.holds[0] ?? "");
    if (worker === undefined) throw new Error("no worker ran the tool");
    leases.freeze(worker);
    for (let step = 0; step < 12 && loopTakeover.holds.length < 2; step += 1)
      await clock.advance(seconds(10));
    await until(() => loopTakeover.holds.length === 2, "the other instance runs the tool again");
    const done = await call;
    release();
    leases.thaw(worker);

    expect(done.spend.totalUsd).toBe(30);
    const ledger = app.resolve(CostLedgerRepository);
    const now = clock.now();
    const records: readonly ExecutionBudgetRecord[] = [
      {
        budget: { name: "test-execution-budget" },
        scope: BudgetScope.Execution,
        key: done.executionId,
        maxSpend: 0,
      },
      {
        budget: { name: "test-tenant-daily-budget" },
        scope: BudgetScope.Tenant,
        period: BudgetPeriod.Day,
        key: "default",
        maxSpend: 0,
      },
    ];
    for (const record of records)
      expect(await ledger.findSpentByCounter(counterOf(record, now))).toBe(30);
  });
});
