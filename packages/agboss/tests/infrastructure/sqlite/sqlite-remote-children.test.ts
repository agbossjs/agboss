/**
 * #333 PR 2 (AC1, M1 automated) — children on any instance, two application instances on one
 * SQLite file (two connections): a launch of six children runs on both instances and the parent
 * joins all six; a failed remote child reaches its parent's join as `ChildExecutionFailedError`.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { ExecutionCancelledError } from "../../../src/index.js";
import { seconds } from "../../../src/units/index.js";
import { TestConcurrency, testWith } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { execute } from "../../helpers/flow.js";
import {
  RemoteChecksFailedWorkflowFinish,
  RemoteChecksWorkflowFinish,
  RemoteItemsWorkflowStart,
  closeGate,
  remoteLog,
  resetRemoteLog,
} from "../../flow/runtime/fixtures/remote-children.workflow.js";
import { RemoteSqliteApplication } from "./fixtures/remote-children.application.js";
import { sqliteFilePerTest } from "./fixtures/sqlite.workflow.js";

sqliteFilePerTest();
// the branches as in production: the six children are queued at once
const test = testWith(RemoteSqliteApplication, {
  instances: 2,
  concurrency: TestConcurrency.Real,
});

beforeEach(resetRemoteLog);

const first = (apps: readonly TestApp[]): TestApp => {
  const [app] = apps;
  if (app === undefined) throw new Error("the test runs no instance");
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
