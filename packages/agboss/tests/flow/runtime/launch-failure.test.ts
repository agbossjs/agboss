import { beforeEach, describe, expect } from "vitest";
import {
  ActionFailedError,
  BranchStatus,
  StepFailedError,
  ExecutionCancelledError,
} from "../../../src/index.js";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  FanOutApplication,
  FanOutUnboundedApplication,
  fanOut,
  ItemFailedError,
  ItemsFailedWorkflowFinish,
  ItemsWorkflowStart,
  resetFanOut,
  type ItemDto,
} from "./fixtures/fan-out.workflow.js";

/** #273 AC7, S20, S22: a failed branch cancels its siblings; the join takes it, or the execution fails. */

const items = testWith(FanOutApplication);
const unbounded = testWith(FanOutUnboundedApplication);

const ok = (name: string, delay = 0): ItemDto => ({ name, delay, outcome: "ok" });
const bad = (name: string, delay = 0): ItemDto => ({ name, delay, outcome: "fail" });

beforeEach(resetFanOut);

describe("AC7: FailFast", () => {
  items(
    "FailFast cancels siblings: a running one is aborted, a waiting one never starts",
    async ({ app }) => {
      const result = await execute(app, ItemsWorkflowStart, [
        bad("x"),
        ok("slow", 500),
        ok("later"),
      ]);

      expect(result).toFinishWith(ItemsFailedWorkflowFinish, { text: "failed on one of 3" });
      expect(fanOut.events).toContain("aborted slow");
      expect(fanOut.events).not.toContain("start later");
      expect(result.launches[0]?.branches.map((branch) => branch.status)).toEqual([
        BranchStatus.Failed,
        BranchStatus.Cancelled,
        BranchStatus.Cancelled,
      ]);
    },
  );

  items(
    "onJoinError by cause chain: the domain error inside ActionFailedError",
    async ({ app }) => {
      const result = await execute(app, ItemsWorkflowStart, [ok("a"), bad("b")], { record: true });

      expect(result).toFinishWith(ItemsFailedWorkflowFinish);
      expect(result.record?.lastError).toMatchObject({
        code: "step.action",
        details: { nodeId: "process-item-action", itemIndex: 1, visitNumber: 1 },
        cause: { code: "test.item-failed" },
      });
      const failed = result.launches[0]?.branches[1];
      expect(failed).toMatchObject({ itemIndex: 1, status: BranchStatus.Failed });
    },
  );

  items("cancelled branches' spend still counted", async ({ app }) => {
    const result = await execute(app, ItemsWorkflowStart, [bad("x"), ok("slow", 500)]);

    expect(fanOut.events).toContain("aborted slow");
    expect(result.spend.totalUsd).toBeCloseTo(0.02);
  });

  unbounded("uncaught fails the execution with the branch's error", async ({ app }) => {
    const run = execute(app, ItemsWorkflowStart, [ok("a"), bad("b", 5), ok("c", 300)]);

    await expect(run).rejects.toBeInstanceOf(ActionFailedError);
    await expect(run).rejects.toBeInstanceOf(StepFailedError);
    await expect(run).rejects.toMatchObject({
      code: "step.action",
      nodeId: "process-item-action",
      itemIndex: 1,
      cause: expect.any(ItemFailedError) as unknown,
    });
    expect(fanOut.events).toContain("aborted c");
  });
});

/** Until the log shows `event` (a branch started), at most two seconds. */
async function untilEvent(event: string): Promise<void> {
  for (let tick = 0; tick < 200 && !fanOut.events.includes(event); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("S21: a cancel of the execution is no branch outcome", () => {
  items(
    "app.cancel during a launch aborts every branch and rejects: no join, no .onJoinError",
    async ({ app }) => {
      const run = execute(app, ItemsWorkflowStart, [ok("a", 500), ok("b", 500)]);
      run.catch(() => undefined);
      await untilEvent("start b");

      await app.cancel(fanOut.threads[0] ?? "");

      await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);
      expect(fanOut.events).toEqual(expect.arrayContaining(["aborted a", "aborted b"]));
    },
  );
});
