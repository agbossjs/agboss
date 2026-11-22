/**
 * #1366 (shard once-child) — a queued child's end announced once by its worker (#562): `onExecutionEnd` only
 * when the worker's completion of the child's row won, `onExecutionError` only for a cancelled child whose row
 * went with its tree, neither otherwise, and the event's identity and spend as the parent's step made them
 * before #562. Each rule on its own, with an observer that lists what it heard.
 */
import { describe, expect, it, vi } from "vitest";
import {
  announcePass,
  cancelledOf,
  type AnnouncedPass,
  type ClaimedChild,
} from "../../src/app/remote/child-end-event.js";
import type { GraphDeps } from "../../src/graph/deps.js";
import type { RemoteChildRun } from "../../src/flow/runtime/remote/remote-child-run.js";
import { ExecutionObserverManager } from "../../src/core/observer-manager.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { recordToolCost } from "../../src/finops/usage.js";
import type { ChildExecutionQueueRepository } from "../../src/infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";

vi.mock("../../src/flow/runtime/workflow-keys.js", () => ({
  workflowIdentityOf: () => ({ name: "child-workflow", version: "v2", configHash: "hash-1" }),
  nodeRecordIn: (_deps: unknown, name: string) => ({ name, kind: "workflow-finish" }),
}));

const row = {
  tenantId: "acme",
  executionId: "child-1",
  parentExecutionId: "parent-1",
  rootExecutionId: "root-1",
  rootWorkflow: "root-workflow",
  workflow: "child-workflow",
  depth: 2,
  status: ExecutionRecordStatus.Running,
  run: "{}",
  queuedAt: new Date("2026-11-20T10:00:00.000Z"),
};

const [inherited, one, two] = [
  recordToolCost("parent", 1),
  recordToolCost("child-a", 2),
  recordToolCost("child-b", 4),
];

function claimedOf() {
  const observer = {
    onExecutionEnd: vi.fn((_event: { spend: { totalUsd: number; calls: number } }) =>
      Promise.resolve(),
    ),
    onExecutionError: vi.fn(() => Promise.resolve()),
  };
  const claimed: ClaimedChild = {
    deps: { observer: new ExecutionObserverManager([observer]) } as GraphDeps<string>,
    row,
    run: { threadId: "thread-1", initial: { child: { inheritedUsage: 1 } } } as RemoteChildRun,
  };
  return { observer, claimed };
}

const IDENTITY = {
  executionId: "child-1",
  parentExecutionId: "parent-1",
  rootExecutionId: "root-1",
  threadId: "thread-1",
  tenantId: "acme",
  workflow: { name: "child-workflow", version: "v2", startedVersion: "v2", configHash: "hash-1" },
};

const queueOf = (found: () => Promise<unknown>) => {
  const finds: unknown[][] = [];
  const queue = {
    findByTenantIdAndExecutionId: (...args: unknown[]) => {
      finds.push(args);
      return found();
    },
  } as ChildExecutionQueueRepository;
  return { queue, finds };
};

const noQueue = queueOf(() => Promise.reject(new Error("the queue is not read")));

describe("#1366: a child's end announced by its worker", () => {
  it("a finish whose completion won is announced with its identity, its finish and the spend of the child alone", async () => {
    const { observer, claimed } = claimedOf();
    const last = { finish: "child-finish", usage: [inherited, one, two] };
    const pass = {
      end: { status: ExecutionRecordStatus.Answered },
      finished: { ...claimed, last },
    };

    await announcePass(noQueue.queue, pass as never, true);

    expect(observer.onExecutionEnd).toHaveBeenCalledTimes(1);
    const [event] = observer.onExecutionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      ...IDENTITY,
      finish: { name: "child-finish", kind: "workflow-finish" },
    });
    expect(event?.spend.totalUsd).toBe(6);
    expect(event?.spend.calls).toBe(2);
    expect(observer.onExecutionError).not.toHaveBeenCalled();
    expect(noQueue.finds).toEqual([]);
  });

  it("a finish whose completion lost is not announced", async () => {
    const { observer, claimed } = claimedOf();
    const pass = {
      end: { status: ExecutionRecordStatus.Answered },
      finished: { ...claimed, last: { finish: "f", usage: [] } },
    };

    await announcePass(noQueue.queue, pass as never, false);

    expect(observer.onExecutionEnd).not.toHaveBeenCalled();
    expect(observer.onExecutionError).not.toHaveBeenCalled();
  });

  it("a pass that finished nothing announces no end", async () => {
    const { observer } = claimedOf();

    await announcePass(noQueue.queue, { end: { status: ExecutionRecordStatus.Paused } }, true);

    expect(observer.onExecutionEnd).not.toHaveBeenCalled();
  });

  it("a finish is announced to no one when its workflow has no observer", async () => {
    const { claimed } = claimedOf();
    const bare: ClaimedChild = { ...claimed, deps: {} as GraphDeps<string> };
    const pass = {
      end: { status: ExecutionRecordStatus.Answered },
      finished: { ...bare, last: { finish: "f", usage: [] } },
    };

    await expect(announcePass(noQueue.queue, pass as never, true)).resolves.toBeUndefined();
  });
});

describe("#1366: a child cancelled with its tree is announced by the worker that stopped it", () => {
  const cancelled = new ExecutionCancelledError({ message: "the tree was cancelled" });

  it("when its row went with the tree: onExecutionError with the cancellation and nothing to undo", async () => {
    const { observer, claimed } = claimedOf();
    const { queue, finds } = queueOf(() => Promise.resolve(undefined));
    const pass = {
      end: { status: ExecutionRecordStatus.Failed },
      cancelled: cancelledOf(claimed, cancelled),
    };

    await announcePass(queue, pass as never, false);

    expect(finds).toEqual([["acme", "child-1"]]);
    expect(observer.onExecutionError).toHaveBeenCalledExactlyOnceWith({
      ...IDENTITY,
      error: cancelled,
      compensations: [],
    });
    expect(observer.onExecutionEnd).not.toHaveBeenCalled();
  });

  it("not while its row is there: its parent announces it", async () => {
    const { observer, claimed } = claimedOf();
    const { queue } = queueOf(() => Promise.resolve(row));
    const pass = {
      end: { status: ExecutionRecordStatus.Failed },
      cancelled: cancelledOf(claimed, cancelled),
    };

    await announcePass(queue, pass as never, false);

    expect(observer.onExecutionError).not.toHaveBeenCalled();
  });

  it("not when the row cannot be read: at most once, never twice", async () => {
    const { observer, claimed } = claimedOf();
    const { queue } = queueOf(() => Promise.reject(new Error("the store is down")));
    const pass = {
      end: { status: ExecutionRecordStatus.Failed },
      cancelled: cancelledOf(claimed, cancelled),
    };

    await announcePass(queue, pass as never, false);

    expect(observer.onExecutionError).not.toHaveBeenCalled();
  });

  it("not when its completion won: nothing to announce as cancelled, and the row is not read", async () => {
    const { observer, claimed } = claimedOf();
    const pass = {
      end: { status: ExecutionRecordStatus.Answered },
      cancelled: cancelledOf(claimed, cancelled),
    };

    await announcePass(noQueue.queue, pass as never, true);

    expect(observer.onExecutionError).not.toHaveBeenCalled();
    expect(noQueue.finds).toEqual([]);
  });

  it("a pass that was not cancelled announces no cancellation, and its row is not read", async () => {
    const { observer } = claimedOf();

    await announcePass(noQueue.queue, { end: { status: ExecutionRecordStatus.Failed } }, false);

    expect(observer.onExecutionError).not.toHaveBeenCalled();
    expect(noQueue.finds).toEqual([]);
  });

  it("is announced to no one when its workflow has no observer", async () => {
    const { claimed } = claimedOf();
    const bare: ClaimedChild = { ...claimed, deps: {} as GraphDeps<string> };
    const { queue } = queueOf(() => Promise.resolve(undefined));
    const pass = {
      end: { status: ExecutionRecordStatus.Failed },
      cancelled: cancelledOf(bare, cancelled),
    };

    await expect(announcePass(queue, pass as never, false)).resolves.toBeUndefined();
  });
});

describe("#1366: the cancellation a failed pass ended with", () => {
  it("is the claimed child with the error, when a cancellation stopped it, and none for any other failure", () => {
    const { claimed } = claimedOf();
    const error = new ExecutionCancelledError();

    expect(cancelledOf(claimed, error)).toEqual({ ...claimed, error });
    expect(cancelledOf(claimed, new Error("boom"))).toBeUndefined();
    expect(cancelledOf(claimed, "cancelled")).toBeUndefined();
    expect(cancelledOf(claimed, undefined)).toBeUndefined();
  });
});
