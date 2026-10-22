/**
 * #360: `app.cancel(threadId)` on any instance cancels the thread's execution wherever it runs — a
 * running one stops with `ExecutionCancelledError` within one lease renewal, a request made while
 * its holder is down ends it at recovery, and unknown, foreign or finished threads behave as before.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import {
  ExecutionLeaseLostError,
  ExecutionStatus,
  ThreadOwnerError,
  UnknownThreadError,
} from "../../src/index.js";
import { InMemoryExecutionTreeRepository } from "../../src/infrastructure/execution-tree.repository.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  Hold,
  kill,
  levers,
  OrderWorkflowStart,
  ReceiptDto,
  RecoveryApplication,
  resetRecovery,
  seen,
  Step,
  stores,
} from "../infrastructure/fixtures/recovery.workflow.js";

const test = testWith(RecoveryApplication, { instances: 2 });
const KEY = "@agboss/cancel-request";
const THREAD = "t-1";

beforeEach(resetRecovery);
afterEach(() => {
  vi.restoreAllMocks();
});

/** The two instances of a test, built in order (`instance-1`, `instance-2`). */
async function pair(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [first, second] = apps;
  if (first === undefined || second === undefined) throw new Error("the test runs two instances");
  await first.ready();
  await second.ready();
  return [first, second];
}

/** An execution started on an instance: its call, settled only when it ends. */
interface StartedExecution {
  readonly call: Promise<unknown>;
}

/** Starts an execution on `app` that steps and then holds; resolves once it holds. */
async function holding(app: TestApp): Promise<StartedExecution> {
  const held = new Promise<void>((resolve) => {
    levers.holdStarted = resolve;
  });
  const call = execute(app, OrderWorkflowStart, { text: "step, then hold" }, { threadId: THREAD });
  call.catch(() => undefined);
  await held;
  return { call };
}

/** The status of the thread's last record. */
async function lastStatus(): Promise<string | undefined> {
  const [record] = (await stores.records?.lastTerns("default", THREAD, 1)) ?? [];
  return record?.status;
}

/** The cancel requests written to the shared tree store. */
const requestWrites = () =>
  vi.spyOn(InMemoryExecutionTreeRepository.prototype, "saveIfAbsentInTree");

const writesOf = (spy: ReturnType<typeof requestWrites>): number =>
  spy.mock.calls.filter(([, key]) => key === KEY).length;

const stepAndHold = [
  callTool(Step, { text: "one" }),
  callTool(Hold, { text: "a long job" }),
] as const;

describe("#360 AC1: a cancel on the other instance stops the running execution", () => {
  test("within one renewal: cancelled, observed once, no later step, the record failed", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold);
    const [first, second] = await pair(apps);
    const { call } = await holding(first);
    const cancelled = await second.cancel(THREAD);
    await clock.advance(seconds(10));

    expect(cancelled).toEqual({ cancelled: true });
    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.errors.map((error) => error.constructor)).toEqual([ExecutionCancelledError]);
    expect(seen.ends).toEqual([]);
    expect(seen.steps).toEqual(["one"]);
    expect(seen.holds).toHaveLength(1);
    expect(await lastStatus()).toBe("failed");
    expect(await second.cancel(THREAD)).toEqual({ cancelled: false });
    expect(await first.cancel(THREAD)).toEqual({ cancelled: false });
  });

  test("a request seen at a checkpoint write stops it before the next model call", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold);
    const [first, second] = await pair(apps);
    const { call } = await holding(first);

    const cancelled = await second.cancel(THREAD);
    levers.letGo?.();

    expect(cancelled).toEqual({ cancelled: true });
    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.errors).toHaveLength(1);
    expect(await lastStatus()).toBe("failed");
  });

  test("a store error reading the request is retried at the next renewal, never fatal", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold);
    const [first, second] = await pair(apps);
    const { call } = await holding(first);
    const reads = vi
      .spyOn(InMemoryExecutionTreeRepository.prototype, "findByIdInTree")
      .mockRejectedValue(new Error("the tree store does not answer"));

    await second.cancel(THREAD);
    await clock.advance(seconds(10));
    const isAbortedWhileDown = seen.holds[0]?.aborted;
    reads.mockRestore();
    await clock.advance(seconds(10));

    expect(isAbortedWhileDown).toBe(false);
    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.errors).toHaveLength(1);
  });

  test("a cancel on the holder's own instance writes no request", async ({ apps, mockLlm }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold);
    const [first] = await pair(apps);
    const { call } = await holding(first);
    const writes = requestWrites();

    const cancelled = await first.cancel(THREAD);

    expect(cancelled).toEqual({ cancelled: true });
    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(writesOf(writes)).toBe(0);
  });
});

describe("#360: the execution moves between the request and the re-read", () => {
  test("it finished: not cancelled, the request withdrawn with the tree's keys", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold, replyWith(ReceiptDto, { text: "Done." }));
    const [first, second] = await pair(apps);
    const { call } = await holding(first);
    const records = stores.records;
    if (records === undefined) throw new Error("the records were not created");
    const [record] = await records.lastTerns("default", THREAD, 1);
    if (record === undefined) throw new Error("the execution has no record");
    vi.spyOn(records, "byIds").mockResolvedValueOnce([{ ...record, status: "answered" }]);
    const removals = vi.spyOn(InMemoryExecutionTreeRepository.prototype, "deleteAllInTree");

    const cancelled = await second.cancel(THREAD);
    const removed = removals.mock.calls.length;
    levers.letGo?.();

    expect(cancelled).toEqual({ cancelled: false });
    expect(removed).toBe(1);
    await expect(call).resolves.toMatchObject({ status: ExecutionStatus.Finished });
    expect(seen.errors).toEqual([]);
  });

  test("it paused: the cancel waits for the holder's lease, counted once", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold);
    const [first, second] = await pair(apps);
    const { call } = await holding(first);
    const records = stores.records;
    if (records === undefined) throw new Error("the records were not created");
    const [record] = await records.lastTerns("default", THREAD, 1);
    if (record === undefined) throw new Error("the execution has no record");
    vi.spyOn(records, "byIds").mockResolvedValueOnce([{ ...record, status: "paused" }]);

    const cancelling = second.cancel(THREAD);
    levers.letGo?.();

    expect(await cancelling).toEqual({ cancelled: true });
    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.errors).toHaveLength(1);
    expect(await lastStatus()).toBe("failed");
  });

  test("a request found before the tree rests paused: it ends cancelled instead", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const [first] = await pair(apps);
    // the request appears once the pass has stored its paused run: only the check at rest sees it
    const saves = vi.spyOn(InMemoryPausedExecutionRepository.prototype, "save");
    vi.spyOn(InMemoryExecutionTreeRepository.prototype, "findByIdInTree").mockImplementation(
      (_tree, key) =>
        Promise.resolve(
          saves.mock.calls.length > 0 && key === KEY
            ? { requestedAt: "now", ownerId: null }
            : undefined,
        ),
    );

    const call = execute(first, OrderWorkflowStart, { text: "charge" }, { threadId: THREAD });

    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.errors).toHaveLength(1);
    expect(await lastStatus()).toBe("failed");
    expect(await first.cancel(THREAD)).toEqual({ cancelled: false });
  });

  test("a resume that takes the lease of a requested tree ends it: the resume rejects", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const [first, second] = await pair(apps);
    const paused = await execute(
      first,
      OrderWorkflowStart,
      { text: "charge" },
      { threadId: THREAD },
    );
    vi.spyOn(InMemoryExecutionTreeRepository.prototype, "findByIdInTree").mockResolvedValue({
      requestedAt: "now",
      ownerId: null,
    });

    const resumed = second.resume(answerOf(paused, { approved: true }));

    await expect(resumed).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.charges).toEqual([]);
    expect(seen.errors).toHaveLength(1);
    expect(await lastStatus()).toBe("failed");
  });
});

describe("#360 AC2: a cancel requested while the holder is down", () => {
  test("recovery ends it as cancelled instead of continuing it", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold);
    const [first, second] = await pair(apps);
    const { call } = await holding(first);
    kill("instance-1");

    const cancelled = await second.cancel(THREAD);
    await clock.advance(seconds(31));

    expect(cancelled).toEqual({ cancelled: true });
    await expect(call).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    expect(seen.errors.map((error) => error.constructor)).toEqual([ExecutionCancelledError]);
    expect(seen.resumes).toEqual([]);
    expect(seen.holds).toHaveLength(1);
    expect(await lastStatus()).toBe("failed");
  });

  test("an instance of another config version ends it too: ending runs no graph", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepAndHold);
    const [first, second] = await pair(apps);
    const { call } = await holding(first);
    kill("instance-1");
    levers.stampedHash = "a-config-of-another-deploy";

    await second.cancel(THREAD);
    await clock.advance(seconds(31));

    await expect(call).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    expect(seen.errors.map((error) => error.constructor)).toEqual([ExecutionCancelledError]);
    expect(seen.resumes).toEqual([]);
    expect(await lastStatus()).toBe("failed");
  });
});

describe("#360 AC3: threads with nothing to cancel behave as before on both instances", () => {
  test("unknown, another tenant's, another owner's and a finished thread", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(replyWith(ReceiptDto, { text: "Done." }));
    const [first, second] = await pair(apps);
    await execute(first, OrderWorkflowStart, { text: "hi" }, { threadId: THREAD, ownerId: "ann" });
    const writes = requestWrites();

    for (const app of [first, second]) {
      expect(await app.cancel(THREAD, { ownerId: "ann" })).toEqual({ cancelled: false });
      await expect(app.cancel("unknown-thread")).rejects.toBeInstanceOf(UnknownThreadError);
      await expect(
        app.cancel(THREAD, { tenantId: "another-tenant", ownerId: "ann" }),
      ).rejects.toBeInstanceOf(UnknownThreadError);
      await expect(app.cancel(THREAD, { ownerId: "bob" })).rejects.toBeInstanceOf(ThreadOwnerError);
    }
    expect(writesOf(writes)).toBe(0);
  });
});
