import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ChildExecutionFailedError } from "../../../src/index.js";
import { ChildExecutionStatus } from "../../../src/flow/runtime/child-records.js";
import { InMemoryChildExecutionQueueRepository } from "../../../src/infrastructure/child-execution-queue.repository.js";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  CountDoneWorkflowFinish,
  CountStoppedWorkflowFinish,
  resetRecursionLog,
} from "./fixtures/recursion.workflow.js";
import {
  RemoteChainWorkflowStart,
  RemoteCountdownWorkflowStart,
  RemoteRecursionApplication,
} from "./fixtures/remote-recursion.workflow.js";

/**
 * #333 PR 3 (AC3, depth) — a recursion on any instance meets `maxDepth` as on its parent's
 * instance: each level is queued and run by a worker, whose execution's depth is rebuilt from its
 * parents; the hard stop (`DepthLimitExceededError`) refuses the launch past `maxDepth` where the
 * level above runs, and the soft stop leaves the recursive route unready on the last level.
 */

const test = testWith(RemoteRecursionApplication, { instances: 2 });

beforeEach(resetRecursionLog);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("#333 PR 3: maxDepth for children on any instance", () => {
  test("a count that ends in time: each level queued, the depths as on one instance", async ({
    apps,
  }) => {
    const queued = vi.spyOn(InMemoryChildExecutionQueueRepository.prototype, "saveIfAbsent");
    const [app] = apps;
    if (app === undefined) throw new Error("the test runs no instance");

    const result = await execute(app, RemoteCountdownWorkflowStart, { left: 1 });

    expect(result).toFinishWith(CountDoneWorkflowFinish, { depth: 2 });
    expect(queued.mock.calls.map(([child]) => child.depth)).toEqual([2]);
  });

  test("level 3 (maxDepth), run by a worker, launching level 4: refused there, taken by its .onError", async ({
    apps,
  }) => {
    const queued = vi.spyOn(InMemoryChildExecutionQueueRepository.prototype, "saveIfAbsent");
    const [app] = apps;
    if (app === undefined) throw new Error("the test runs no instance");

    const result = await execute(app, RemoteCountdownWorkflowStart, { left: 5 });

    expect(result).toFinishWith(CountStoppedWorkflowFinish, { depth: 3 });
    expect(queued.mock.calls.map(([child]) => child.depth)).toEqual([2, 3]);
    const third = result.children[0]?.children[0];
    expect(third?.depth).toBe(3);
    expect(third?.path).toContain("depth-stopped-action");
    expect(third?.children[0]).toMatchObject({
      depth: 4,
      status: ChildExecutionStatus.Failed,
      path: [],
      error: { name: "DepthLimitExceededError", code: "limit.depth" },
    });
  });

  test("the soft stop: on the last level, on a worker, the recursive route is not ready", async ({
    apps,
  }) => {
    const [app] = apps;
    if (app === undefined) throw new Error("the test runs no instance");

    const error: unknown = await execute(app, RemoteChainWorkflowStart, { name: "a" }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ChildExecutionFailedError);
    expect(error).toMatchObject({
      cause: { name: "RouterDecisionError", message: expect.stringContaining("is not ready") },
    });
  });
});
