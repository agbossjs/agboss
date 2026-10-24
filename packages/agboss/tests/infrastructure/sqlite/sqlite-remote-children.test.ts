/**
 * #333 PR 2 (AC1, M1 automated) — children on any instance, two application instances on one
 * SQLite file (two connections): a launch of six children runs on both instances and the parent
 * joins all six; a failed remote child reaches its parent's join as `ChildExecutionFailedError`.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { ExecutionCancelledError, ExecutionStatus } from "../../../src/index.js";
import { seconds } from "../../../src/units/index.js";
import {
  callTool,
  replyWith,
  TestConcurrency,
  testWith,
  type ModelRequest,
} from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { execute } from "../../helpers/flow.js";
import {
  childLog,
  ConfirmReviewTool,
  ItemReviewerAgent,
  resetChildLog,
  ReviewsSummaryWorkflowFinish,
} from "../../flow/runtime/fixtures/children.workflow.js";
import {
  ItemResultDto,
  SummaryWorkflowFinish,
} from "../../flow/runtime/fixtures/fan-out.workflow.js";
import { resetRecoveryRuns } from "../../flow/runtime/fixtures/launch-recovery.workflow.js";
import {
  RemoteChecksFailedWorkflowFinish,
  RemoteChecksWorkflowFinish,
  RemoteItemsWorkflowStart,
  closeGate,
  remoteLog,
  resetRemoteLog,
} from "../../flow/runtime/fixtures/remote-children.workflow.js";
import {
  recoveryRuns,
  RemoteHoldItemsWorkflowStart,
  RemoteReviewItemsWorkflowStart,
  remoteRecoverySeen,
  resetRemoteRecoverySeen,
} from "../../flow/runtime/fixtures/remote-recovery.workflow.js";
import { RemoteSqliteApplication } from "./fixtures/remote-children.application.js";
import { sqliteFilePerTest } from "./fixtures/sqlite.workflow.js";

sqliteFilePerTest();
// the branches as in production: the six children are queued at once
const test = testWith(RemoteSqliteApplication, {
  instances: 2,
  concurrency: TestConcurrency.Real,
});

beforeEach(() => {
  resetRemoteLog();
  resetChildLog();
  resetRecoveryRuns();
  resetRemoteRecoverySeen();
});

const first = (apps: readonly TestApp[]): TestApp => {
  const [app] = apps;
  if (app === undefined) throw new Error("the test runs no instance");
  return app;
};

const second = (apps: readonly TestApp[]): TestApp => {
  const [, app] = apps;
  if (app === undefined) throw new Error("the test runs no second instance");
  return app;
};

const items = (...names: readonly string[]) =>
  names.map((name) => ({ name, delay: 0, outcome: name === "bad" ? "fail" : "ok" }));

describe("#333 PR 2 AC1: six children on two instances over one SQLite file", () => {
  test("both instances run children; the parent joins all six, in item order", async ({ apps }) => {
    for (const app of apps) await app.ready();

    const result = await execute(
      first(apps),
      RemoteItemsWorkflowStart,
      items("a", "b", "c", "d", "e", "f"),
    );

    expect(result).toFinishWith(RemoteChecksWorkflowFinish, { text: "a, b, c, d, e, f" });
    const instances = new Set(remoteLog.readings.map((reading) => reading.instanceId));
    expect(instances.size).toBe(2);
    expect(remoteLog.readings.map((reading) => reading.itemIndex).sort()).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(new Set(remoteLog.readings.map((reading) => reading.rootExecutionId))).toEqual(
      new Set([result.executionId]),
    );
  });

  test("a failed remote child fails its branch: the join's side path takes it", async ({
    apps,
  }) => {
    for (const app of apps) await app.ready();

    const result = await execute(first(apps), RemoteItemsWorkflowStart, items("a", "bad"));

    expect(result).toFinishWith(RemoteChecksFailedWorkflowFinish, { text: "failed on one of 2" });
  });
});

describe("#333 PR 2 AC5: a cancel reaches the children on every instance", () => {
  test("app.cancel on the parent's instance: each running child stops at its tree's next look", async ({
    apps,
    clock,
  }) => {
    for (const app of apps) await app.ready();
    closeGate();
    const call = execute(first(apps), RemoteItemsWorkflowStart, items("a", "b"), {
      threadId: "t-cancel",
    });
    call.catch(() => undefined);
    await vi.waitFor(() => {
      expect(remoteLog.waiting).toBe(2);
    });

    const cancelled = await first(apps).cancel("t-cancel");
    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
    await clock.advance(seconds(10));

    expect(cancelled).toEqual({ cancelled: true });
    await vi.waitFor(() => {
      expect(remoteLog.aborted).toHaveLength(2);
    });
    expect(new Set(remoteLog.aborted.map((child) => child.instanceId)).size).toBe(2);
  });
});

describe("#333 PR 4 M2: remote child pauses and per-child recovery on two instances over one SQLite file", () => {
  const nameIn = (request: ModelRequest): string => {
    const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
    return /"name": "(\w+)"/.exec(input)?.[1] ?? "?";
  };

  test("a remote child pauses on SQLite, and app.resume on the other instance continues only that child", async ({
    apps,
    mockLlm,
  }) => {
    for (const app of apps) await app.ready();
    mockLlm(ItemReviewerAgent).thenAnswer((request) => {
      const name = nameIn(request);
      const confirmed =
        request.kind === "chat" && request.messages.some((line) => line.role === "tool");
      return name === "b" && !confirmed
        ? callTool(ConfirmReviewTool, { name })
        : replyWith(ItemResultDto, { name });
    });

    const paused = await execute(first(apps), RemoteReviewItemsWorkflowStart, items("a", "b"));
    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending).toHaveLength(1);
    const pauseId = paused.pending[0]?.pauseId ?? "";

    const done = await second(apps).resume(
      { pauseId, decision: { approved: true } },
      { record: true },
    );

    expect(done).toFinishWith(ReviewsSummaryWorkflowFinish, { text: "a, b" });
    expect(done.record?.pauses).toMatchObject([
      {
        pauseId,
        executionId: paused.pending[0]?.childExecutionId,
      },
    ]);
  });

  test("stopping the worker running a remote child recovers only that child on the other instance from its last checkpoint", async ({
    apps,
    clock,
  }) => {
    for (const app of apps) await app.ready();
    const held = new Promise<void>((resolve) => {
      recoveryRuns.holdStarted = resolve;
    });
    const call = execute(first(apps), RemoteHoldItemsWorkflowStart, items("a", "hold", "c"));
    await held;
    expect(remoteRecoverySeen.holdInstanceId).toBe("instance-2");

    const closing = second(apps).close({ timeout: seconds(5) });
    await clock.advance(seconds(5));
    await closing;
    const done = await call;

    expect(done).toFinishWith(SummaryWorkflowFinish, { text: "a, hold, c" });
    expect([...remoteRecoverySeen.prepRuns].sort()).toEqual(["a", "c", "hold"]);
    expect([...recoveryRuns.runs].sort()).toEqual(["a", "c", "hold", "hold"]);
    expect(
      childLog.starts.filter((event) => event.workflow.name === "remote-hold-check-workflow"),
    ).toHaveLength(3);
  });
});
