import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ChildExecutionFailedError } from "../../../src/index.js";
import { InMemoryChildExecutionQueueRepository } from "../../../src/infrastructure/child-execution-queue.repository.js";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  RemoteChildrenApplication,
  RemoteChecksWorkflowFinish,
  RemoteItemsWorkflowStart,
  RemoteOneWorkflowStart,
  remoteLog,
  resetRemoteLog,
} from "./fixtures/remote-children.workflow.js";

const test = testWith(RemoteChildrenApplication);

beforeEach(resetRemoteLog);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("#333 PR 2: a child on any instance, one instance", () => {
  test("per item: each child is queued, claimed and run here; the join has every result", async ({
    app,
  }) => {
    const queued = vi.spyOn(InMemoryChildExecutionQueueRepository.prototype, "saveIfAbsent");
    const items = ["a", "b", "c"].map((name) => ({ name, delay: 0, outcome: "ok" }));

    const result = await execute(app, RemoteItemsWorkflowStart, items);

    expect(queued.mock.calls.map(([child]) => child.workflow)).toEqual([
      "remote-item-workflow",
      "remote-item-workflow",
      "remote-item-workflow",
    ]);
    expect(result).toFinishWith(RemoteChecksWorkflowFinish, { text: "a, b, c" });
    expect(remoteLog.readings.map((reading) => reading.depth)).toEqual([2, 2, 2]);
  });

  test("once: the child's context is its tree's", async ({ app }) => {
    const result = await execute(app, RemoteOneWorkflowStart, {
      name: "a",
      delay: 0,
      outcome: "ok",
    });

    expect(result.output).toEqual({ name: "a" });
    expect(remoteLog.readings).toMatchObject([
      {
        item: "a",
        parentExecutionId: result.executionId,
        rootExecutionId: result.executionId,
        depth: 2,
        rootWorkflow: "remote-one-workflow",
        threadId: result.threadId,
      },
    ]);
  });

  test("a failed child without a handler fails the execution: its error's name and message as the cause", async ({
    app,
  }) => {
    const call = execute(app, RemoteOneWorkflowStart, { name: "x", delay: 0, outcome: "fail" });

    const error: unknown = await call.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ChildExecutionFailedError);
    expect(error).toMatchObject({
      workflow: { name: "remote-item-workflow" },
      cause: {
        name: "ActionFailedError",
        code: "step.action",
        cause: {
          name: "ItemFailedError",
          message: "x cannot be checked",
          code: "test.item-failed",
        },
      },
    });
  });
});
