/**
 * #520 — a stale instance never takes the lease of an `AnyInstance` child another instance already
 * finished. A's parent waits for its child on B; A's reclaim of the child, asked while B still runs
 * it, freezes at A's lease store (`leases.stall`); B ends the child — answered, failed or cancelled
 * — and finishes its lease; A resumes. Before the fix A took the free lease of the finished child
 * (and kept it, renewed) and wrote a `RemoteChild` takeover for it.
 */
import { beforeEach, describe, expect } from "vitest";
import {
  ChildExecutionFailedError,
  ExecutionCancelledError,
  ExecutionRecordStatus,
} from "../../src/index.js";
import { testWith, type TestLeases } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import {
  bothReady,
  childOf,
  item,
  leaseRowOf,
  statusOf,
  takeoversOf,
} from "./fixtures/finished-work.js";
import {
  openGate,
  RemoteChildYieldApplication,
  resetYield,
  YieldOneWorkflowFinish,
  YieldOneWorkflowStart,
  yieldSeen,
} from "./fixtures/remote-child-yield.workflow.js";

const test = testWith(RemoteChildYieldApplication, { instances: 2 });

/** What the stale instance A sees: the parent on A, its child at its gate on B, A frozen. */
interface FrozenReclaim {
  readonly a: TestApp;
  readonly b: TestApp;
  readonly call: Promise<unknown>;
  readonly child: ReturnType<typeof childOf>;
}

/**
 * A's parent waits for its child, which runs on B; A freezes, and its parent's next look (1 s) sees
 * the child `Running`: A's reclaim reads the row — still B's claim — and asks for the child's
 * lease, the ask waiting at A's frozen store.
 */
async function frozenReclaim(
  apps: readonly TestApp[],
  { clock, leases }: { readonly clock: VirtualClock; readonly leases: TestLeases },
  outcome: "ok" | "fail" = "ok",
): Promise<FrozenReclaim> {
  const [a, b] = await bothReady(apps);
  const call = execute(a, YieldOneWorkflowStart, item("gate", outcome), { threadId: "thread-a" });
  await until(() => yieldSeen.runs.length === 1, "the child at its gate on B");
  const child = childOf(b);
  leases.stall(a);
  await clock.advance(seconds(1));
  await settle();
  return { a, b, call, child };
}

/** A's lease store goes on; what A's call ended with, once everything A asked settled. */
async function resumed(
  { a, call }: FrozenReclaim,
  leases: TestLeases,
): Promise<{ readonly done: unknown; readonly error: unknown }> {
  leases.resume(a);
  const error = await rejectionOf(call);
  const done = error === undefined ? await call : undefined;
  await settle();
  return { done, error };
}

/** No lease of the child is A's, and no takeover of it is in the lease log. */
async function expectNoStaleClaim({ b, child }: FrozenReclaim): Promise<void> {
  // the child's lease is still B's, finished: A took none
  expect(leaseRowOf(b, child.executionId)).toMatchObject({
    released: true,
    isFinished: true,
    lease: { holderInstanceId: "instance-1", leaseEpoch: 1 },
  });
  expect(await takeoversOf(b, child.rootExecutionId, child.executionId)).toEqual([]);
  expect(yieldSeen.runs).toEqual([{ name: "gate", instanceId: "instance-1" }]);
}

beforeEach(() => {
  resetYield();
  resetLogged();
});

describe("#520 AC2: a stale instance does not re-claim a finished AnyInstance child", () => {
  test("AC2: A's reclaim frozen while B answers the child takes no lease and writes no takeover of it", async ({
    apps,
    clock,
    leases,
  }) => {
    const frozen = await frozenReclaim(apps, { clock, leases });
    openGate();
    await until(
      () => statusOf(frozen.b, frozen.child) === ExecutionRecordStatus.Answered,
      "the child answered on B",
    );
    const { done, error } = await resumed(frozen, leases);

    expect(error).toBeUndefined();
    expect(done).toFinishWith(YieldOneWorkflowFinish, { name: "gate" });
    await expectNoStaleClaim(frozen);
  });

  test("AC2: … nor once B's child failed (the parent fails with it)", async ({
    apps,
    clock,
    leases,
  }) => {
    const frozen = await frozenReclaim(apps, { clock, leases }, "fail");
    openGate();
    await until(
      () => statusOf(frozen.b, frozen.child) === ExecutionRecordStatus.Failed,
      "the child failed on B",
    );
    const { error } = await resumed(frozen, leases);

    expect(error).toBeInstanceOf(ChildExecutionFailedError);
    await expectNoStaleClaim(frozen);
  });

  test("AC2: … nor once a cancel stopped B's child (the tree ends cancelled)", async ({
    apps,
    clock,
    leases,
  }) => {
    const frozen = await frozenReclaim(apps, { clock, leases });
    expect(await frozen.b.cancel("thread-a", { tenantId: "default" })).toEqual({ cancelled: true });
    // B's look at the running child (every 10 s) finds the request and stops it
    await clock.advance(seconds(10));
    await until(
      () => statusOf(frozen.b, frozen.child) === ExecutionRecordStatus.Failed,
      "the child stopped on B",
    );
    const { error } = await resumed(frozen, leases);
    openGate();

    expect(error).toBeInstanceOf(ExecutionCancelledError);
    await expectNoStaleClaim(frozen);
  });
});
