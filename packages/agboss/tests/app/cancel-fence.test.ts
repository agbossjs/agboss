/**
 * #909 — cancel is a hard fence for effects. A tree's cancel request is durable the moment `app.cancel`
 * resolves (the mark in the lease store's database, `requestCancel`), and a fenced write or an
 * outbound call of the tree is refused from then on, atomically with the lease check — not at the
 * holder's next renewal, up to 10 s later. The step stops, the tree unwinds as cancelled, its undo
 * runs under the lease the holder still has; nothing was written or sent after the cancel.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { LiveRuns } from "../../src/app/live-runs.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { ExecutionCancelFencedError } from "../../src/index.js";
import { ExecutionLeaseRepository } from "../../src/index.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import {
  frozenRuns,
  gates,
  letAllGo,
  resetFencedEffect,
} from "./fixtures/fenced-effect.workflow.js";
import {
  behaviour,
  CancelFenceApplication,
  FenceChargeStart,
  FenceFarStart,
  FencePayStart,
  resetSeen,
  seen,
} from "./fixtures/cancel-fence.workflow.js";

const test = testWith(CancelFenceApplication, { instances: 2 });
const THREAD = "t-909";

beforeEach(() => {
  resetFencedEffect();
  resetSeen();
  behaviour.isSwallowing = false;
});
afterEach(() => {
  letAllGo();
  vi.restoreAllMocks();
});

/** The two instances of a test, built in order. */
async function pair(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [first, second] = apps;
  if (first === undefined || second === undefined) throw new Error("the test runs two instances");
  await first.ready();
  await second.ready();
  return [first, second];
}

/** An order started on `app` whose charge waits at its gate: its call, and the charge frozen. */
async function chargingAt(
  app: TestApp,
  start: typeof FenceChargeStart | typeof FencePayStart | typeof FenceFarStart = FenceChargeStart,
): Promise<{ readonly call: Promise<unknown> }> {
  gates.before = 1;
  const call = execute(app, start, { text: "order-1" }, { threadId: THREAD });
  call.catch(() => undefined);
  await frozenRuns(1);
  return { call };
}

describe("#909 AC1/AC3: a live holder between the cancel request and its next renewal", () => {
  test("a remote cancel: its next charge is refused, nothing charged, the tree ends cancelled, the reservation undone once, onFencedEffect Cancelled", async ({
    apps,
  }) => {
    const [first, second] = await pair(apps);
    const { call } = await chargingAt(first);

    // no clock advance: the holder has not renewed since the cancel — the window
    expect(await second.cancel(THREAD)).toEqual({ cancelled: true });
    letAllGo();
    const error = await rejectionOf(call);
    await settle();

    // the moving call rejects as for any cancel; the step saw the store's refusal
    expect(error).toBeInstanceOf(ExecutionCancelledError);
    expect(seen.refusals).toHaveLength(1);
    expect(seen.refusals[0]).toBeInstanceOf(ExecutionCancelFencedError);
    expect(seen.charged).toEqual([]);
    expect(seen.reserved).toEqual(["order-1"]);
    expect(seen.released).toEqual(["reservation-order-1"]);
    expect(seen.fenced).toEqual([
      { name: "charge", outcome: "cancelled" },
      { name: "release", outcome: "ran" },
    ]);
  });

  test("an outbound call: no intent recorded, no request sent, onOutboundCall Cancelled, the reservation undone once", async ({
    apps,
  }) => {
    const [first, second] = await pair(apps);
    const { call } = await chargingAt(first, FencePayStart);

    await second.cancel(THREAD);
    letAllGo();
    const error = await rejectionOf(call);
    await settle();

    expect(error).toBeInstanceOf(ExecutionCancelledError);
    expect(seen.requests).toEqual([]);
    expect(seen.calls).toEqual([{ name: "pay", outcome: "cancelled" }]);
    expect(seen.released).toEqual(["reservation-order-1"]);
  });

  test("a step that swallows the refusal still stops as cancelled: the tree does not go on to its finish", async ({
    apps,
  }) => {
    behaviour.isSwallowing = true;
    const [first, second] = await pair(apps);
    const { call } = await chargingAt(first);

    await second.cancel(THREAD);
    letAllGo();
    const error = await rejectionOf(call);
    await settle();

    expect(error).toBeInstanceOf(ExecutionCancelledError);
    expect(seen.charged).toEqual([]);
    expect(seen.released).toEqual(["reservation-order-1"]);
  });
});

describe("#909: who writes the mark", () => {
  test("a local app.cancel writes the mark before the abort", async ({ apps }) => {
    const [first] = await pair(apps);
    const mark = vi.spyOn(InMemoryExecutionLeaseRepository.prototype, "requestCancel");
    const abort = vi.spyOn(LiveRuns.prototype, "abort");
    const { call } = await chargingAt(first);

    expect(await first.cancel(THREAD)).toEqual({ cancelled: true });
    letAllGo();
    await rejectionOf(call);

    expect(mark).toHaveBeenCalledWith({ tenantId: "default", rootExecutionId: "execution-1" });
    expect(Math.min(...mark.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...abort.mock.invocationCallOrder),
    );
  });

  test("app.cancel rejects when the mark cannot be written; nothing is aborted and the run goes on", async ({
    apps,
  }) => {
    const [first] = await pair(apps);
    const { call } = await chargingAt(first);
    const abort = vi.spyOn(LiveRuns.prototype, "abort");
    const mark = vi
      .spyOn(InMemoryExecutionLeaseRepository.prototype, "requestCancel")
      .mockRejectedValueOnce(new Error("the lease store does not answer"));

    await expect(first.cancel(THREAD)).rejects.toThrow("the lease store does not answer");
    letAllGo();
    const done = await call;

    expect(abort).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledTimes(1);
    expect(seen.charged).toEqual(["reservation-order-1"]);
    expect(done).toMatchObject({ finish: { name: "fence-charge-finish-workflow-finish" } });
  });

  test("a mark without the tree key (a crash between the two writes): the tree stops at its first fenced write as cancelled", async ({
    apps,
  }) => {
    const [first, second] = await pair(apps);
    // the mark of the root of the next execution, before anything of it was written
    await second.resolve(ExecutionLeaseRepository).requestCancel({
      tenantId: "default",
      rootExecutionId: "execution-1",
    });

    const error = await rejectionOf(
      execute(first, FenceChargeStart, { text: "order-3" }, { threadId: "t-3" }),
    );
    await settle();

    expect(error).toBeInstanceOf(ExecutionCancelledError);
    expect(seen.refusals[0]).toBeInstanceOf(ExecutionCancelFencedError);
    expect(seen.charged).toEqual([]);
    expect(seen.released).toEqual(["reservation-order-3"]);
  });
});

describe("#909 AC1: an AnyInstance child", () => {
  test("its charge after its root's cancel is refused, naming the root's tree — the lease is the child's own", async ({
    apps,
  }) => {
    const [first, second] = await pair(apps);
    const { call } = await chargingAt(first, FenceFarStart);

    await second.cancel(THREAD);
    letAllGo();
    const error = await rejectionOf(call);
    await until(() => seen.refusals.length > 0, "the child's refusal");
    await settle();

    expect(error).toBeInstanceOf(ExecutionCancelledError);
    expect(seen.charged).toEqual([]);
    const [refusal] = seen.refusals;
    expect(refusal).toBeInstanceOf(ExecutionCancelFencedError);
    expect(refusal).toMatchObject({ rootExecutionId: "execution-1" });
    expect((refusal as ExecutionCancelFencedError).leaseExecutionId).not.toBe("execution-1");
  });
});
