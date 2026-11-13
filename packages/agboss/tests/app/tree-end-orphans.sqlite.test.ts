/**
 * #939 AC3 (#910 I13): an instance that died in the middle of a tree's end leaves nothing open —
 * within a few sweeps another instance finishes it. Two instances on one SQLite file; the state a
 * death leaves is made through the stores' own transitions, each the store state at that hold
 * point: the root's record ended and nothing else (between the record and `forgetTree`), the paused
 * run removed (`pausedRun.delete` after), a `Resolved` answer still waiting at its pause
 * (`pause.closeUntaken` not run). A root still running, a root whose lease is held and another
 * application's root are skipped.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { cancelledRecordOutcome, CANCELLED_STOP_REASON } from "../../src/app/live-runs.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import {
  ExecutionLeaseRepository,
  ExecutionRecordRepository,
  PausedExecutionRepository,
  PauseResolution,
  PauseStatus,
} from "../../src/index.js";
import { NO_RECIPIENTS } from "../../src/infrastructure/pause-record.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { callTool, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  kill,
  OrderWorkflowStart,
  resetRecovery,
  seen,
} from "../infrastructure/fixtures/recovery.workflow.js";
import {
  SqliteRecoveryApplication,
  sqliteFilePerTest,
} from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";

sqliteFilePerTest();
const test = testWith(SqliteRecoveryApplication, { instances: 2 });

beforeEach(resetRecovery);
afterEach(() => {
  vi.restoreAllMocks();
});

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

/** A tree resting at its pause on the file, and what to read and break in its stores. */
async function restingTree(apps: readonly TestApp[], mockText: string) {
  for (const one of apps) await one.ready();
  const first = instance(apps, 0);
  const paused = await execute(first, OrderWorkflowStart, { text: mockText }, { threadId: "t-3" });
  const pauseId = paused.pending[0]?.pauseId ?? "";
  const pauses = first.resolve(PausedExecutionRepository);
  const records = first.resolve(ExecutionRecordRepository);
  const [turn] = await records.lastTurns(DEFAULT_TENANT_ID, paused.threadId, 1);
  if (turn === undefined) throw new Error("the pause has no record");
  const root = paused.executionId;
  return {
    pauseId,
    root,
    thread: paused.threadId,
    pauses,
    records,
    /** The root's record ended, as the tree's end writes it (a cancel, or a failure). */
    ends: (isCancel: boolean) =>
      records.complete(turn.id, {
        ...cancelledRecordOutcome(turn.route, turn.costUsd),
        status: "failed",
        stopReason: isCancel ? CANCELLED_STOP_REASON : "the tree failed",
      }),
    pause: () => pauses.findByTenantIdAndPauseId(DEFAULT_TENANT_ID, pauseId),
    pausedRun: async () =>
      (await pauses.findByTenantIdAndThreadId(DEFAULT_TENANT_ID, paused.threadId))?.run.runId,
    log: () => records.findPauseAnswersByTenantIdAndRootExecutionId(DEFAULT_TENANT_ID, root),
  };
}

describe("#939 AC3: another instance finishes a tree's end", () => {
  test("killed between the root's end and forgetTree: within 3 sweeps its pause is closed, its paused run gone", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps, "charge");
    await tree.ends(false);
    kill("instance-1");

    for (let sweep = 0; sweep < 3; sweep += 1) await clock.advance(seconds(31));

    expect(await tree.pause()).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.TreeEnded,
    });
    expect(await tree.pausedRun()).toBeUndefined();
    expect(seen.charges).toEqual([]);
  });

  test("killed after pausedRun.delete: the cancelled tree's pause closes Cancelled", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps, "charge");
    await tree.pauses.deleteByTenantIdAndThreadIdAndRunId(
      DEFAULT_TENANT_ID,
      tree.thread,
      tree.root,
    );
    await tree.ends(true);
    kill("instance-1");

    for (let sweep = 0; sweep < 3; sweep += 1) await clock.advance(seconds(31));

    expect(await tree.pause()).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Cancelled,
    });
  });

  test("killed before pause.closeUntaken: the Resolved answer is closed not taken, the log says so", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps, "charge");
    const answer = { decision: { approved: true }, answeredBy: "manager-17" };
    await tree.pauses.resolveByTenantIdAndPauseId(
      DEFAULT_TENANT_ID,
      tree.pauseId,
      answer,
      clock.now(),
      NO_RECIPIENTS,
    );
    await tree.pauses.deleteByTenantIdAndThreadIdAndRunId(
      DEFAULT_TENANT_ID,
      tree.thread,
      tree.root,
    );
    await tree.ends(true);
    kill("instance-1");

    for (let sweep = 0; sweep < 3; sweep += 1) await clock.advance(seconds(31));

    expect(await tree.pause()).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Cancelled,
      answer,
    });
    expect(await tree.log()).toMatchObject([
      { isTaken: false, resolution: PauseResolution.Cancelled, answeredBy: "manager-17" },
    ]);
    expect(seen.charges).toEqual([]);
  });

  test("a root still waiting at its pause is skipped: its pause stays open, its paused run kept", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps, "charge");

    for (let sweep = 0; sweep < 3; sweep += 1) await clock.advance(seconds(31));

    expect((await tree.pause())?.status).toBe(PauseStatus.Pending);
    expect(await tree.pausedRun()).toBe(tree.root);
  });

  test("a root whose lease another holds is skipped until the lease is free", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps, "charge");
    await tree.ends(false);
    const leases = instance(apps, 0).resolve(ExecutionLeaseRepository);
    const held = await leases.acquire(DEFAULT_TENANT_ID, tree.root, seconds(100));
    expect(held).toBeDefined();

    await clock.advance(seconds(31));
    expect((await tree.pause())?.status).toBe(PauseStatus.Pending);

    await clock.advance(seconds(100));
    await clock.advance(seconds(31));
    expect((await tree.pause())?.status).toBe(PauseStatus.Cancelled);
  });

  test("another application's root (no record here) is skipped: its pause stays, no error", async ({
    apps,
    clock,
  }) => {
    for (const one of apps) await one.ready();
    const pauses = instance(apps, 0).resolve(PausedExecutionRepository);
    await pauses.findOrCreateByStepKey({ ...pauseOf("p-foreign"), rootExecutionId: "foreign-run" });

    for (let sweep = 0; sweep < 3; sweep += 1) await clock.advance(seconds(31));

    expect((await pauses.findByTenantIdAndPauseId("default", "p-foreign"))?.status).toBe(
      PauseStatus.Pending,
    );
  });
});
