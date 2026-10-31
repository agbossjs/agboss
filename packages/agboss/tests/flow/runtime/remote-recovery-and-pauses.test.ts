/**
 * #333 PR 4 (AC2, AC3, AC4, S7, S9):
 * - AC2: while a parent awaits remote children, it yields its root lease in
 *   `ExecutionLeaseRepository` and re-acquires it before `.join()` / `.onJoinError()`.
 * - AC3: a remote child (`ChildPlacement.AnyInstance`) that pauses interrupts its parent's node
 *   with `{ waitingForChild: { …, remote: true } }`, surfaces in `result.pending` with its
 *   `childExecutionId` and `itemIndex`, resumes on any instance via `app.resume`, and populates
 *   `PauseAnswerRecord` in `result.children[i].pauses` and `result.record.pauses`.
 * - AC4 & S7: each worker holds a 30 s lease in `ExecutionLeaseRepository` under
 *   `(tenantId, childExecutionId)`. On a worker crash or a graceful stop past `shutdownTimeout`
 *   (S7), the queue row stays `Running`, and once the child's lease is free, another instance
 *   reclaims only that child and continues it from its last checkpoint on
 *   `<parentThreadId>/child/<id>` without re-running finished siblings or finished child steps.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus, PauseResolution } from "../../../src/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { logged, resetLogged } from "../../helpers/log.js";
import {
  kill,
  resetRecovery,
  seen as leaseSeen,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import {
  ChecksFailedWorkflowFinish,
  childLog,
  ConfirmReviewTool,
  ItemReviewedWorkflowFinish,
  ItemReviewerAgent,
  resetChildLog,
  ReviewsSummaryWorkflowFinish,
} from "./fixtures/children.workflow.js";
import { ItemResultDto, SummaryWorkflowFinish, type ItemDto } from "./fixtures/fan-out.workflow.js";
import { resetRecoveryRuns } from "./fixtures/launch-recovery.workflow.js";
import {
  recoveryRuns,
  RemoteHoldItemsWorkflowStart,
  RemoteRecoveryApplication,
  RemoteReviewItemsWorkflowStart,
  RemoteReviewOneWorkflowStart,
  remoteRecoverySeen,
  resetRemoteRecoverySeen,
} from "./fixtures/remote-recovery.workflow.js";
import { passLive } from "../../helpers/live-time.js";

const test = testWith(RemoteRecoveryApplication, { instances: 2 });
const who = { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u1" } };
const approve = { approved: true };

const answerOf = (paused: { readonly pending: readonly { readonly pauseId?: string }[] }) => ({
  pauseId: paused.pending[0]?.pauseId ?? "",
  decision: approve,
});

const item = (name: string, outcome: "ok" | "fail" = "ok"): ItemDto => ({
  name,
  delay: 0,
  outcome,
});

const nameIn = (request: ModelRequest): string => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  return /"name": "(\w+)"/.exec(input)?.[1] ?? "?";
};

const reviewer = (request: ModelRequest) => {
  const name = nameIn(request);
  const confirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  return name === "b" && !confirmed
    ? callTool(ConfirmReviewTool, { name })
    : replyWith(ItemResultDto, { name });
};

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

/** Starts `instance-2` first so its worker claims children queued by `instance-1`. */
async function readyWorkerFirst(apps: readonly TestApp[]): Promise<void> {
  await instance(apps, 1).ready();
  await instance(apps, 0).ready();
}

const childStarts = (workflow: string): readonly string[] =>
  childLog.starts
    .filter((event) => event.workflow.name === workflow)
    .map((event) => event.executionId);

beforeEach(() => {
  resetChildLog();
  resetRecovery();
  resetRecoveryRuns();
  resetRemoteRecoverySeen();
  resetLogged();
});

describe("#333 PR 4 AC2: yielding the root lease while waiting for remote children", () => {
  test("the parent releases its root lease while remote children run, and re-acquires it before joining or handling a FailFast error", async ({
    apps,
  }) => {
    await readyWorkerFirst(apps);
    const first = instance(apps, 0);

    const done = await execute(first, RemoteHoldItemsWorkflowStart, [item("a"), item("b")], who);
    expect(done).toFinishWith(SummaryWorkflowFinish, { text: "a, b" });
    const rootLeases = leaseSeen.leases.filter(
      (lease) => lease.rootExecutionId === done.executionId,
    );
    // initial acquire on start (epoch 1), then re-acquired after yielding for remote children (epoch >= 2)
    expect(rootLeases[0]?.leaseEpoch).toBe(1);
    expect(rootLeases.at(-1)?.leaseEpoch).toBeGreaterThanOrEqual(2);

    const failed = await execute(
      first,
      RemoteHoldItemsWorkflowStart,
      [item("a"), item("bad", "fail")],
      who,
    );
    expect(failed).toFinishWith(ChecksFailedWorkflowFinish, { text: "failed on one of 2" });
  });
});

describe("#333 PR 4 AC3: remote children that pause, resume across instances, and PauseAnswerRecord parity", () => {
  test("a remote child's pause appears in result.pending with childExecutionId and itemIndex, resumes on the other instance, and records PauseAnswerRecord on the child and root", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer(reviewer);
    await readyWorkerFirst(apps);

    const paused = await execute(
      instance(apps, 0),
      RemoteReviewItemsWorkflowStart,
      [item("a"), item("b")],
      who,
    );

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending).toHaveLength(1);
    expect(paused.pending[0]?.childExecutionId).toBeDefined();
    expect(paused.pending[0]?.itemIndex).toBe(1);
    const before = mockLlm(ItemReviewerAgent).requests.length;

    // resume on the SECOND instance: only "b" continues on its own thread, with the same child id
    const done = await instance(apps, 1).resume(answerOf(paused), {
      tenantId: "acme",
      record: true,
    });

    expect(done).toFinishWith(ReviewsSummaryWorkflowFinish, { text: "a, b" });
    expect(mockLlm(ItemReviewerAgent).requests.slice(before).map(nameIn)).toEqual(["b"]);
    expect(childStarts("item-review-workflow")).toHaveLength(2);
    const childB = done.children.find((child) => child.itemIndex === 1);
    expect(childB?.executionId).toBe(paused.pending[0]?.childExecutionId);
    expect(childB?.pauses).toMatchObject([
      {
        pauseId: paused.pending[0]?.pauseId,
        resolution: PauseResolution.Replied,
        decision: approve,
      },
    ]);
    expect(done.record?.pauses).toMatchObject([
      {
        pauseId: paused.pending[0]?.pauseId,
        executionId: paused.pending[0]?.childExecutionId,
        resolution: PauseResolution.Replied,
        decision: approve,
      },
    ]);
  });

  test("a single remote child pauses and resumes with the same executionId", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer(reviewer);
    await readyWorkerFirst(apps);

    const paused = await execute(instance(apps, 0), RemoteReviewOneWorkflowStart, item("b"), who);
    const done = await instance(apps, 1).resume(answerOf(paused), { tenantId: "acme" });

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(done).toFinishWith(ItemReviewedWorkflowFinish, { name: "b" });
    expect(childStarts("item-review-workflow")).toHaveLength(1);
    expect(done.children.map((child) => child.executionId)).toEqual(
      childStarts("item-review-workflow"),
    );
  });
});

describe("#333 PR 4 AC4 & S7: per-child recovery on worker crash and graceful stop past shutdownTimeout", () => {
  test("AC4: when the worker running a remote child crashes, the other instance reclaims only that child after its 30 s lease expires and continues from its last checkpoint", async ({
    apps,
    clock,
  }) => {
    for (const app of apps) await app.ready();
    const held = new Promise<void>((resolve) => {
      recoveryRuns.holdStarted = resolve;
    });
    const call = execute(
      instance(apps, 1),
      RemoteHoldItemsWorkflowStart,
      [item("a"), item("hold"), item("c")],
      who,
    );
    await held;
    expect(remoteRecoverySeen.holdInstanceId).toBe("instance-1");

    kill("instance-1");
    // the parent on instance-2 is live: its yielded lease is renewed in time (#534)
    await passLive(clock, seconds(31));
    const done = await call;

    expect(done).toFinishWith(SummaryWorkflowFinish, { text: "a, hold, c" });
    // finished siblings "a" and "c" and step 1 (RemotePrepItemAction) of "hold" never ran a second time!
    expect([...remoteRecoverySeen.prepRuns].sort()).toEqual(["a", "c", "hold"]);
    expect([...recoveryRuns.runs].sort()).toEqual(["a", "c", "hold", "hold"]);
    expect(childStarts("remote-hold-check-workflow")).toHaveLength(3);
    expect(logged.some((entry) => entry.code === "execution.recovered")).toBe(true);
  });

  test("S7: on graceful stop past shutdownTimeout, a worker leaves its remote child row Running and the other instance continues it from its last checkpoint", async ({
    apps,
    clock,
  }) => {
    for (const app of apps) await app.ready();
    const held = new Promise<void>((resolve) => {
      recoveryRuns.holdStarted = resolve;
    });
    const call = execute(
      instance(apps, 1),
      RemoteHoldItemsWorkflowStart,
      [item("a"), item("hold"), item("c")],
      who,
    );
    await held;
    expect(remoteRecoverySeen.holdInstanceId).toBe("instance-1");

    const closing = instance(apps, 0).close({ timeout: seconds(5) });
    await clock.advance(seconds(5));
    await closing;
    const done = await call;

    expect(done).toFinishWith(SummaryWorkflowFinish, { text: "a, hold, c" });
    // step 1 (RemotePrepItemAction) ran once per child ("a", "c", "hold") — never re-run on recovery!
    expect([...remoteRecoverySeen.prepRuns].sort()).toEqual(["a", "c", "hold"]);
    expect([...recoveryRuns.runs].sort()).toEqual(["a", "c", "hold", "hold"]);
    expect(childStarts("remote-hold-check-workflow")).toHaveLength(3);
  });
});
