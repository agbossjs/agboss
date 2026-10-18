/**
 * #265 AC7 / AC11: `PausedExecutionRepository` — one paused execution per thread, kept with the
 * versions it paused under; exactly one of two concurrent `Pending → Resolved` transitions of one
 * pause succeeds, with its decision, also from two instances. One suite, run against the
 * in-memory default and `SqlitePausedExecutionRepository` (two instances on one file).
 */
import { describe, expect, it } from "vitest";
import type { PausedRun } from "../../src/app/paused-runs.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { PauseStatus, type PausedExecutionRepository } from "../../src/index.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { SqlitePausedExecutionRepository } from "../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { buildCostReport } from "../../src/finops/usage.js";
import { sharedInMemory, storeKinds } from "./contracts/store-kinds.js";

const kinds = storeKinds<PausedExecutionRepository>({
  inMemory: (seam) => sharedInMemory(seam, "paused", () => new InMemoryPausedExecutionRepository()),
  sqlite: ({ clock, connection }) => new SqlitePausedExecutionRepository(connection(), clock.now),
});

/** A paused run as the app stores it (`budgetUsd: Infinity` — a run without a cost limit). */
const pausedRunOf = (threadId: string, runId = "run-1"): PausedRun => ({
  run: {
    runId,
    threadId,
    ternId: "tern-1",
    status: ExecutionStatus.Paused,
    start: "order-workflow-start",
    startInput: { text: "charge" },
    budgetUsd: Number.POSITIVE_INFINITY,
    path: ["start", "clerk"],
    cost: buildCostReport([]),
    data: { scope: {}, outdatedValues: [], lastError: null },
  },
  workflowVersion: "1.0.0",
  configHash: "hash",
  status: PauseStatus.Pending,
});

describe.each(kinds)(
  "#265 AC11: a pause goes from Pending to Resolved once ($name)",
  ({ twoInstances }) => {
    it("of two concurrent transitions of one pause on two instances exactly one succeeds, with its decision", async () => {
      const { first, second } = twoInstances();
      await first.save(pausedRunOf("thread-1"));

      const [one, other] = await Promise.all([
        first.resolveByThreadId("thread-1", { approved: true }),
        second.resolveByThreadId("thread-1", { approved: false }),
      ]);

      expect(one).toMatchObject({ status: PauseStatus.Resolved, decision: { approved: true } });
      expect(other).toBeUndefined();
      expect(await second.findByThreadId("thread-1")).toMatchObject({
        status: PauseStatus.Resolved,
        decision: { approved: true },
      });
      expect(await first.resolveByThreadId("no-such-thread", {})).toBeUndefined();
    });
  },
);

describe.each(kinds)("#265 AC7: paused executions by thread ($name)", ({ twoInstances }) => {
  it("a saved pause is found on the other instance as written, its versions with it", async () => {
    const { first, second } = twoInstances();
    const paused = pausedRunOf("thread-1");

    await first.save(paused);

    expect(await second.findByThreadId("thread-1")).toEqual(paused);
    expect(await second.findByThreadId("thread-2")).toBeUndefined();
  });

  it("a later pause of the thread replaces the earlier one; a delete forgets it", async () => {
    const { first, second } = twoInstances();
    await first.save(pausedRunOf("thread-1", "run-1"));
    await first.save(pausedRunOf("thread-1", "run-2"));

    const latest = await second.findByThreadId("thread-1");
    await second.deleteByThreadId("thread-1");

    expect(latest?.run.runId).toBe("run-2");
    expect(await first.findByThreadId("thread-1")).toBeUndefined();
  });

  it("a resolved pause without a decision reads back without one", async () => {
    const { first, second } = twoInstances();
    await first.save(pausedRunOf("thread-1"));

    await first.resolveByThreadId("thread-1", undefined);

    expect((await second.findByThreadId("thread-1"))?.decision).toBeUndefined();
    expect((await second.findByThreadId("thread-1"))?.status).toBe(PauseStatus.Resolved);
  });
});
