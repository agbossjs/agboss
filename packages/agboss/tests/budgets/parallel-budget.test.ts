/**
 * #338: a budget crossed inside a parallel launch stops the launch's siblings at once. The pass's
 * live tally (`BudgetMeter.tally`) counts every call as it is made, so a branch sees its siblings'
 * spend while they run; a tally that exhausts a budget aborts the in-flight calls of every branch
 * through their `executionContext.signal`; the launch fails with `BudgetExceededError` — into a
 * code-only `.onJoinError(…)`, else the execution fails —, its spend counted once.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { BranchStatus, BudgetExceededError } from "../../src/index.js";
import { counterOf, meterOf, type BudgetMeter } from "../../src/budgets/execution-budgets.js";
import { recordToolCost, type UsageRecord } from "../../src/finops/usage.js";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { systemClock } from "../../src/infrastructure/clock.js";
import { BudgetScope } from "../../src/budgets/budget.js";
import { callTool, replyWith, step, TestConcurrency, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import type { ExecutionOutput } from "../../src/app/types.js";
import {
  BudgetStoppedWorkflowFinish,
  HoldForWaiterTool,
  NoteBudgetStopAction,
  NoteDto,
  NotesWorkflowFinish,
  ParallelBudgetApplication,
  ParallelBudgetWorkflowStart,
  parallelBudgetLog,
  parallelLedgers,
  QuorumBudgetApplication,
  resetParallelBudget,
  SpenderAgent,
  TaskAgent,
  TaskAction,
  TaskActionsBudgetApplication,
  TasksBudgetApplication,
  TaskWorkflow,
  TasksWorkflowStart,
  TenantBudgetApplication,
  UnhandledBudgetApplication,
  WaitForAbortTool,
  WaiterAgent,
} from "./fixtures/parallel-budget.workflow.js";

/** The spender's answer completes first, the waiter's (stopped) second: one order on every run. */
const SPENDER_FIRST = {
  concurrency: TestConcurrency.inOrder([step(SpenderAgent), step(WaiterAgent)]),
};

const TASK = { text: "do it" };
const hold = callTool(HoldForWaiterTool, { reason: "the waiter" });
const wait = callTool(WaitForAbortTool, { reason: "a slow service" });
const spend = (cost: number) => replyWith(NoteDto, { text: "spent" }, { cost: usd(cost) });

/** What the execution budget's counter holds for the execution in the test's ledger. */
async function executionCounter(result: ExecutionOutput): Promise<number> {
  const ledger = parallelLedgers.at(-1);
  if (ledger === undefined) throw new Error("the application has not started");
  const record = {
    budget: { name: "tight-execution-budget" },
    scope: BudgetScope.Execution,
    key: result.runId,
    maxSpend: 0.05,
  };
  return ledger.findSpentByCounter(counterOf(record, new Date(0)));
}

beforeEach(resetParallelBudget);

describe("AC1: a budget crossed in a launch aborts the in-flight siblings", () => {
  testWith(ParallelBudgetApplication, SPENDER_FIRST)(
    "toParallelAgents: the spender's call crosses the execution budget, the waiter's tool is aborted",
    async ({ app, mockLlm }) => {
      mockLlm(SpenderAgent).thenReturn(hold, spend(0.06));
      mockLlm(WaiterAgent).thenReturn(wait); // no further turn: its loop never calls again

      const result = await execute(app, ParallelBudgetWorkflowStart, TASK);

      expect(parallelBudgetLog.aborts).toEqual(["BudgetExceededError"]);
      expect(parallelBudgetLog.events).toEqual([
        "waiter waits",
        "spender goes on",
        "waiter aborted",
        "budget stop noted",
      ]);
      expect(result.launches[0]?.branches.map((branch) => branch.status)).toEqual([
        BranchStatus.Finished,
        BranchStatus.Failed,
      ]);
      expect(result).toFinishWith(BudgetStoppedWorkflowFinish, { text: "stopped by the budget" });
    },
  );

  testWith(QuorumBudgetApplication, SPENDER_FIRST)(
    "joinQuorum: the same breach stops the waiter before the quorum is decided",
    async ({ app, mockLlm }) => {
      mockLlm(SpenderAgent).thenReturn(hold, spend(0.06));
      mockLlm(WaiterAgent).thenReturn(wait);

      const result = await execute(app, ParallelBudgetWorkflowStart, TASK);

      expect(parallelBudgetLog.aborts).toEqual(["BudgetExceededError"]);
      expect(result).toFinishWith(BudgetStoppedWorkflowFinish);
      expect(result.launches[0]?.branches[1]?.status).toBe(BranchStatus.Failed);
    },
  );

  testWith(TasksBudgetApplication, {
    concurrency: TestConcurrency.inOrder([
      step(TaskWorkflow, { "task-workflow-start": { name: "spend" } }),
      step(TaskWorkflow, { "task-workflow-start": { name: "wait" } }),
    ]),
  })(
    "toParallelWorkflows: one child's call crosses the root's budget, its sibling child is aborted",
    async ({ app, mockLlm }) => {
      mockLlm(TaskAgent)
        .when({ task: { name: "spend" } })
        .thenReturn(hold, spend(0.06));
      mockLlm(TaskAgent)
        .when({ task: { name: "wait" } })
        .thenReturn(wait);

      const result = await execute(app, TasksWorkflowStart, [{ name: "spend" }, { name: "wait" }]);

      expect(parallelBudgetLog.aborts).toEqual(["BudgetExceededError"]);
      expect(result).toFinishWith(BudgetStoppedWorkflowFinish, { text: "stopped by the budget" });
    },
  );

  testWith(TaskActionsBudgetApplication, {
    concurrency: TestConcurrency.inOrder([
      step(TaskAction, { task: { name: "spend" } }),
      step(TaskAction, { task: { name: "wait" } }),
    ]),
  })(
    "toParallelActions: one action's service spend crosses the budget, its sibling's signal aborts",
    async ({ app }) => {
      const result = await execute(app, TasksWorkflowStart, [{ name: "wait" }, { name: "spend" }]);

      expect(parallelBudgetLog.aborts).toEqual(["BudgetExceededError"]);
      expect(result).toFinishWith(BudgetStoppedWorkflowFinish);
      expect(result.spend.totalUsd).toBeCloseTo(0.06);
    },
  );

  testWith(TenantBudgetApplication, SPENDER_FIRST)(
    "a tenant budget crossed only by the siblings together: 3 + 3 cents of 5",
    async ({ app, mockLlm }) => {
      mockLlm(SpenderAgent).thenReturn(hold, spend(0.03));
      mockLlm(WaiterAgent).thenReturn(wait);

      const result = await execute(app, ParallelBudgetWorkflowStart, TASK);

      expect(parallelBudgetLog.aborts).toEqual(["BudgetExceededError"]);
      expect(result).toFinishWith(BudgetStoppedWorkflowFinish);
      expect(result.handledErrors[0]?.error).toMatchObject({
        code: "limit.budget",
        details: { budget: { name: "tight-tenant-daily-budget" }, scope: BudgetScope.Tenant },
      });
    },
  );
});

describe("AC2: the launch fails with BudgetExceededError", () => {
  testWith(ParallelBudgetApplication, SPENDER_FIRST)(
    "into .onJoinError(BudgetExceededError, toAction(…).toFinish(…)): code only, no model after it",
    async ({ app, mockLlm, mockAction }) => {
      mockLlm(SpenderAgent).thenReturn(hold, spend(0.06));
      mockLlm(WaiterAgent).thenReturn(wait);

      const result = await execute(app, ParallelBudgetWorkflowStart, TASK);

      expect(result).toFollowPath([
        ParallelBudgetWorkflowStart,
        SpenderAgent,
        WaiterAgent,
        NoteBudgetStopAction,
        BudgetStoppedWorkflowFinish,
      ]);
      expect(mockAction(NoteBudgetStopAction)).toHaveBeenCalledTimes(1);
      expect(result.handledErrors[0]?.error).toMatchObject({
        code: "limit.budget",
        details: { budget: { name: "tight-execution-budget" }, scope: BudgetScope.Execution },
      });
    },
  );

  testWith(UnhandledBudgetApplication, SPENDER_FIRST)(
    "without a handler the execution fails with it",
    async ({ app, mockLlm }) => {
      mockLlm(SpenderAgent).thenReturn(hold, spend(0.06));
      mockLlm(WaiterAgent).thenReturn(wait);

      const run = execute(app, ParallelBudgetWorkflowStart, TASK);

      await expect(run).rejects.toFailWith(BudgetExceededError, {
        budget: { name: "tight-execution-budget" },
        scope: BudgetScope.Execution,
      });
      expect(parallelBudgetLog.aborts).toEqual(["BudgetExceededError"]);
    },
  );
});

describe("regressions", () => {
  testWith(ParallelBudgetApplication, SPENDER_FIRST)(
    "spend counted once: the result and the ledger hold every call and service, nothing twice",
    async ({ app, mockLlm }) => {
      mockLlm(SpenderAgent).thenReturn(hold, spend(0.06));
      mockLlm(WaiterAgent).thenReturn(wait);

      const result = await execute(app, ParallelBudgetWorkflowStart, TASK);

      // the spender's call (6 cents) and the waiter's service (3 cents), before it was aborted
      expect(result.spend.totalUsd).toBeCloseTo(0.09);
      expect(await executionCounter(result)).toBeCloseTo(0.09);
    },
  );

  testWith(ParallelBudgetApplication, { concurrency: TestConcurrency.Real })(
    "a launch under its budget is unchanged: both branches finish, nothing aborted",
    async ({ app, mockLlm }) => {
      mockLlm(SpenderAgent).thenReturn(replyWith(NoteDto, { text: "a" }, { cost: usd(0.01) }));
      mockLlm(WaiterAgent).thenReturn(replyWith(NoteDto, { text: "b" }, { cost: usd(0.01) }));

      const result = await execute(app, ParallelBudgetWorkflowStart, TASK);

      expect(result).toFinishWith(NotesWorkflowFinish, { text: "a; b" });
      expect(parallelBudgetLog.aborts).toEqual([]);
      expect(result.spend.totalUsd).toBeCloseTo(0.02);
      expect(await executionCounter(result)).toBeCloseTo(0.02);
    },
  );
});

describe("the live tally (BudgetMeter)", () => {
  const record = {
    budget: { name: "tight-execution-budget" },
    scope: BudgetScope.Execution,
    key: "execution-1",
    maxSpend: 0.05,
  };
  const call = (costUsd: number): UsageRecord => recordToolCost("slow-api", costUsd);
  const meter = (): BudgetMeter =>
    meterOf({ ledger: new InMemoryCostLedgerRepository(), clock: systemClock }, [record], 0);

  it("a tally counts at once: the next check sees it, one that exhausts a budget aborts", () => {
    const budgets = meter();

    budgets.tally([call(0.03)]);
    expect(budgets.exhausted.aborted).toBe(false);
    expect(() => {
      budgets.check(0.03, []);
    }).not.toThrow();
    budgets.tally([call(0.03)], ["a-agent"]);

    expect(budgets.exhausted.aborted).toBe(true);
    expect(budgets.exhausted.reason).toBeInstanceOf(BudgetExceededError);
    expect(budgets.exhausted.reason).toMatchObject({ path: ["a-agent"], usage: [] });
    expect(() => {
      budgets.check(0, []);
    }).toThrow(BudgetExceededError);
  });

  it("what the ledger records leaves the tally: a call counted once", async () => {
    const budgets = meter();
    const first = call(0.03);

    budgets.tally([first]);
    await budgets.record([first]);
    budgets.check(0.03, []);
    budgets.tally([call(0.01)]);

    expect(budgets.exhausted.aborted).toBe(false);
    expect(() => {
      budgets.check(0.03, []);
    }).not.toThrow();
  });

  it("without budgets a tally counts nothing", () => {
    const budgets = meterOf(
      { ledger: new InMemoryCostLedgerRepository(), clock: systemClock },
      [],
      0,
    );

    budgets.tally([call(10)]);

    expect(budgets.exhausted.aborted).toBe(false);
  });
});
