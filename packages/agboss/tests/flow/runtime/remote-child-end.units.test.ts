import { StoredNamesUnreadableError } from "../../../src/core/stored-json.js";
/**
 * #1366 (shard once-child) — a child on any instance as its parent's step sees it (`remoteChildEndOf`): the
 * child's row queued once and waited for until it settles, its spend taken into the budgets as in the ledger
 * already (once, #685) before the parent's state shows it, and the end announced only by a pass that saw the
 * child end (#562). The queue is a script, the clock a hand, the budgets a spy.
 */
import { MemorySaver, type BaseCheckpointSaver, type StateSnapshot } from "@langchain/langgraph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordToolCost, type UsageRecord } from "../../../src/finops/usage.js";
import { LedgerState } from "../../../src/finops/ledger-mark.js";
import { trivialExecutionGraph } from "./fixtures/execution-graph.js";
import type { Milliseconds } from "../../../src/units/index.js";
import type { ExecutionGraph } from "../../../src/flow/runtime/build.js";
import {
  remoteChildEndOf,
  type RemoteChildSite,
} from "../../../src/flow/runtime/remote/remote-child.js";
import { remoteChildSignals } from "../../../src/flow/runtime/remote/remote-child-signals.js";
import { RecordedError, durableErrorOf } from "../../../src/core/error-record.js";
import type { QueuedChildExecution } from "../../../src/infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../../src/infrastructure/execution-record.repository.js";
import { treeKeyOf } from "../../../src/infrastructure/in-memory-database.js";

/** What the parent's step interrupts with, and what the resume answers. */
const interrupts = vi.hoisted(() => ({ values: [] as unknown[], answer: "{}" }));

vi.mock("@langchain/langgraph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/langgraph")>()),
  interrupt: (value: unknown) => {
    interrupts.values.push(value);
    return interrupts.answer;
  },
}));

const NOW = new Date("2026-11-20T10:00:00.000Z");
const FAILURE = JSON.stringify(durableErrorOf(new Error("the desk is closed")));
/** A row of 0.1.0: names, a code and a message only — no durable record. */
const LEGACY_FAILURE = JSON.stringify({
  name: "DeskClosedError",
  message: "the desk is closed",
  code: "desk.closed",
});
const inherited = recordToolCost("parent-tool", 1);
const made = recordToolCost("child-tool", 2);

const rowIn = (status: ExecutionRecordStatus, failure?: string): QueuedChildExecution => ({
  tenantId: "acme",
  executionId: "child-1",
  rootExecutionId: "root-1",
  parentExecutionId: "parent-1",
  rootWorkflow: "root-workflow",
  workflow: "child-workflow",
  depth: 2,
  status,
  run: "{}",
  queuedAt: NOW,
  ...(failure === undefined ? {} : { failure }),
});

/** What the queue answers to each read, in turn (the last one stays); what it was asked to save. */
function queueOf(reads: readonly (QueuedChildExecution | undefined)[], isSaved = true) {
  const saved: QueuedChildExecution[] = [];
  let read = 0;
  const queue = {
    findByTenantIdAndExecutionId: vi.fn(() => {
      // a wait that never ends fails the test at once (a mutant that never settles a row), never hangs it
      if (read > 200) throw new Error("the row was read endlessly");
      const found = reads[Math.min(read, reads.length - 1)];
      read += 1;
      return Promise.resolve(found);
    }),
    saveIfAbsent: vi.fn((row: QueuedChildExecution) => {
      saved.push(row);
      return Promise.resolve(isSaved);
    }),
  };
  return { queue, saved, reads: () => read };
}

/** A real graph over its own checkpointer whose state read answers `values` and `tasks`. */
const graphOf = (values: unknown, tasks: StateSnapshot["tasks"] = []): ExecutionGraph => {
  const graph = trivialExecutionGraph();
  vi.spyOn(graph, "getState").mockResolvedValue({ values, next: [], config: {}, tasks });
  return graph;
};

/** The parts of a child's site that `remoteChildEndOf` reads: what the test fakes is left as `object` or `unknown`. */
interface RemoteSiteRead {
  readonly children: {
    readonly queue: unknown;
    readonly rateLimits: object;
    readonly clock: {
      readonly now: () => Date;
      readonly sleep: (delay: Milliseconds, signal?: AbortSignal) => Promise<void>;
    };
    readonly yieldWhile?: RemoteChildSite["children"]["yieldWhile"];
  };
  readonly checkpointer: BaseCheckpointSaver;
  readonly tenantId: string;
  readonly executionId: string;
  readonly rootExecutionId: string;
  readonly parentExecutionId: string;
  readonly rootWorkflow: string;
  readonly workflow: string;
  readonly depth: number;
  readonly node: string;
  readonly isRecursive: boolean;
  readonly run: {
    readonly thread: string;
    readonly threadId: string;
    readonly input: object;
    readonly parent: object;
    readonly piiPolicies: readonly string[];
    readonly initial: object;
  };
  readonly signal: AbortSignal;
}

function siteOf(
  queue: unknown,
  options: { signal?: AbortSignal; yieldWhile?: RemoteChildSite["children"]["yieldWhile"] } = {},
) {
  let sleeps = 0;
  const clock = {
    now: () => NOW,
    sleep: vi.fn((_delay?: number, _signal?: AbortSignal) => {
      sleeps += 1;
      return sleeps > 200 ? Promise.reject(new Error("slept endlessly")) : Promise.resolve();
    }),
  };
  const read: RemoteSiteRead = {
    children: { queue, rateLimits: {}, clock, yieldWhile: options.yieldWhile },
    checkpointer: new MemorySaver(),
    tenantId: "acme",
    executionId: "child-1",
    rootExecutionId: "root-1",
    parentExecutionId: "parent-1",
    rootWorkflow: "root-workflow",
    workflow: "child-workflow",
    depth: 2,
    node: "child-node",
    isRecursive: false,
    run: {
      thread: "root-thread/child/child-1",
      threadId: "root-thread",
      input: {},
      parent: {},
      piiPolicies: [],
      initial: { child: { inheritedUsage: 1 } },
    },
    signal: options.signal ?? new AbortController().signal,
  };
  const site = read as RemoteChildSite;
  return { site, clock };
}

const budgetsOf = (calls: string[]) => ({
  settled: vi.fn(() => {
    calls.push("settled");
    return Promise.resolve();
  }),
  takeRecordedElsewhere: vi.fn((records: readonly UsageRecord[]) => {
    calls.push(`took ${String(records.length)}`);
    return Promise.resolve();
  }),
});

const ELSEWHERE = { state: LedgerState.RecordedElsewhere };

describe("#1366: a child on any instance, queued once and waited for", () => {
  afterEach(() => vi.restoreAllMocks());

  it("queues the child's row once its parent's spend is in the ledger, and wakes the claimers", async () => {
    const order: string[] = [];
    const { queue, saved } = queueOf([undefined, rowIn(ExecutionRecordStatus.Answered)]);
    const budgets = budgetsOf(order);
    queue.saveIfAbsent.mockImplementation((row) => {
      order.push("queued");
      saved.push(row);
      return Promise.resolve(true);
    });
    const off = remoteChildSignals.onQueued(() => order.push("woke"));
    const { site } = siteOf(queue);

    await remoteChildEndOf(graphOf({ usage: [inherited] }), {}, site, budgets);
    off();

    expect(order.slice(0, 3)).toEqual(["settled", "queued", "woke"]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      tenantId: "acme",
      executionId: "child-1",
      rootExecutionId: "root-1",
      parentExecutionId: "parent-1",
      rootWorkflow: "root-workflow",
      workflow: "child-workflow",
      depth: 2,
      status: ExecutionRecordStatus.Queued,
      queuedAt: NOW,
    });
    expect(JSON.parse(saved[0]?.run ?? "")).toHaveProperty("type");
  });

  it("finds the row of a re-entry and queues nothing", async () => {
    const { queue } = queueOf([rowIn(ExecutionRecordStatus.Answered)]);
    const { site } = siteOf(queue);

    await remoteChildEndOf(graphOf({ usage: [] }), {}, site, undefined);

    expect(queue.saveIfAbsent).not.toHaveBeenCalled();
  });

  it("an answered child: its state with its own calls marked as in the ledger, taken into the budgets, announced by no one here", async () => {
    const order: string[] = [];
    const { queue } = queueOf([undefined, rowIn(ExecutionRecordStatus.Answered)]);
    const budgets = budgetsOf(order);
    const { site } = siteOf(queue);

    const end = await remoteChildEndOf(
      graphOf({ usage: [inherited, made], finish: "f" }),
      {},
      site,
      budgets,
    );

    expect(end).toEqual({
      state: { usage: [inherited, { ...made, ledger: ELSEWHERE }], finish: "f" },
      failed: false,
      announces: false,
    });
    expect(budgets.takeRecordedElsewhere).toHaveBeenCalledExactlyOnceWith([
      inherited,
      { ...made, ledger: ELSEWHERE },
    ]);
    expect(order).toEqual(["settled", "took 2"]);
  });

  it("a child whose thread holds no execution state has no state, and takes in no spend", async () => {
    const order: string[] = [];
    const { queue } = queueOf([undefined, rowIn(ExecutionRecordStatus.Answered)]);
    const { site } = siteOf(queue);

    const end = await remoteChildEndOf(graphOf({}), {}, site, budgetsOf(order));

    expect(end).toEqual({ failed: false, announces: false });
    expect(order).toEqual(["settled", "took 0"]);
  });

  it("a failed child: its error as its worker recorded it, announced by the pass that queued it", async () => {
    const { queue } = queueOf([undefined, rowIn(ExecutionRecordStatus.Failed, FAILURE)]);
    const { site } = siteOf(queue);

    const end = await remoteChildEndOf(graphOf({ usage: [inherited] }), {}, site, undefined);

    expect(end.failed).toBe(true);
    expect(end.announces).toBe(true);
    expect(end.error).toBeInstanceOf(Error);
    expect(end.error).toMatchObject({ message: "the desk is closed" });
    expect(end.state).toEqual({ usage: [inherited] });
  });

  it("a failed child found already settled by a pass that did not queue it is announced by none", async () => {
    const { queue } = queueOf([rowIn(ExecutionRecordStatus.Failed, FAILURE)]);
    const { site } = siteOf(queue);

    const end = await remoteChildEndOf(graphOf({ usage: [] }), {}, site, undefined);

    expect(end).toMatchObject({ failed: true, announces: false });
    expect(end.error).toBeInstanceOf(Error);
  });

  it("a child settled before its pass looked, though this pass queued its row, is announced: it saw it", async () => {
    const { queue } = queueOf([undefined, rowIn(ExecutionRecordStatus.Failed, FAILURE)]);
    const { site } = siteOf(queue);

    expect(await remoteChildEndOf(graphOf({ usage: [] }), {}, site, undefined)).toMatchObject({
      announces: true,
    });
  });

  it("a child that settles while the parent waits is announced by the pass that waited, even a row it found", async () => {
    const { queue } = queueOf([
      rowIn(ExecutionRecordStatus.Running),
      rowIn(ExecutionRecordStatus.Failed, FAILURE),
    ]);
    const { site } = siteOf(queue);

    const end = await remoteChildEndOf(graphOf({ usage: [] }), {}, site, undefined);

    expect(end).toMatchObject({ failed: true, announces: true });
  });
});

describe("#1366: the wait for a child's row to settle", () => {
  it("reads the row again after each sleep until it settles, and tells the reclaimers of each Running read", async () => {
    const running = rowIn(ExecutionRecordStatus.Running);
    const { queue } = queueOf([
      rowIn(ExecutionRecordStatus.Queued),
      rowIn(ExecutionRecordStatus.Queued),
      rowIn(ExecutionRecordStatus.Queued),
      running,
      running,
      rowIn(ExecutionRecordStatus.Answered),
    ]);
    const seen: string[] = [];
    const off = remoteChildSignals.onRunning((row) => seen.push(row.status));
    const { site, clock } = siteOf(queue);

    const end = await remoteChildEndOf(graphOf({ usage: [] }), {}, site, undefined);
    off();

    expect(end.failed).toBe(false);
    expect(clock.sleep.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(clock.sleep.mock.calls[0]?.[0]).toBe(1000);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen)).toEqual(new Set([ExecutionRecordStatus.Running]));
  });

  it("is woken at once by the child's end in this process", async () => {
    const { queue } = queueOf([
      rowIn(ExecutionRecordStatus.Queued),
      rowIn(ExecutionRecordStatus.Queued),
      rowIn(ExecutionRecordStatus.Answered),
    ]);
    const { site, clock } = siteOf(queue);
    const wakes: boolean[] = [];
    clock.sleep.mockImplementation((_delay?: number, signal?: AbortSignal) => {
      remoteChildSignals.ended(treeKeyOf("acme", "child-1"));
      wakes.push(signal?.aborted === true);
      return Promise.resolve();
    });

    await remoteChildEndOf(graphOf({ usage: [] }), {}, site, undefined);

    expect(wakes).toContain(true);
  });

  it("a child whose row is gone is lost: the step fails with its id", async () => {
    const { queue } = queueOf([rowIn(ExecutionRecordStatus.Queued), undefined]);
    const { site } = siteOf(queue);

    await expect(remoteChildEndOf(graphOf({ usage: [] }), {}, site, undefined)).rejects.toThrow(
      "child execution child-1 is no longer queued",
    );
  });

  it("a row that was never there and cannot be queued is lost too", async () => {
    const { queue } = queueOf([undefined], false);
    const { site } = siteOf(queue);

    await expect(
      remoteChildEndOf(graphOf({ usage: [] }), {}, site, undefined),
    ).rejects.toMatchObject({
      name: "RemoteChildLostError",
    });
  });

  it("ends when the parent's step is aborted, before it reads the row again", async () => {
    const abort = new AbortController();
    const { queue } = queueOf([rowIn(ExecutionRecordStatus.Queued)]);
    const { site, clock } = siteOf(queue, { signal: abort.signal });
    clock.sleep.mockImplementation(() => {
      abort.abort(new Error("the step was cancelled"));
      return Promise.resolve();
    });

    await expect(remoteChildEndOf(graphOf({ usage: [] }), {}, site, undefined)).rejects.toThrow(
      "the step was cancelled",
    );
  });

  it("waits inside the parent's yield of its lease, and the row it returns is the child's end", async () => {
    const order: string[] = [];
    const { queue } = queueOf([
      rowIn(ExecutionRecordStatus.Queued),
      rowIn(ExecutionRecordStatus.Failed, FAILURE),
    ]);
    const yieldWhile = vi.fn(async <T>(wait: () => Promise<T>): Promise<T> => {
      order.push("yielded");
      const row = await wait();
      order.push("re-acquired");
      return row;
    });
    const { site } = siteOf(queue, { yieldWhile: yieldWhile as never });

    const end = await remoteChildEndOf(graphOf({ usage: [] }), {}, site, budgetsOf(order));

    expect(yieldWhile).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["settled", "yielded", "re-acquired", "took 0"]);
    expect(end).toMatchObject({ failed: true, announces: true });
    expect(end.error).toBeInstanceOf(Error);
  });

  it("a settled row is not waited for: the lease is not yielded", async () => {
    const { queue } = queueOf([rowIn(ExecutionRecordStatus.Answered)]);
    const yieldWhile = vi.fn(<T>(wait: () => Promise<T>) => wait());
    const { site } = siteOf(queue, { yieldWhile: yieldWhile as never });

    await remoteChildEndOf(graphOf({ usage: [] }), {}, site, undefined);

    expect(yieldWhile).not.toHaveBeenCalled();
  });
});

describe("#1366: the error of a failed remote child", () => {
  it("is a RecordedError when its worker kept its durable record; a row of 0.1.0 or with no failure is refused (#1307d)", async () => {
    const kept = JSON.stringify(durableErrorOf(new Error("the desk is closed")));
    const recorded = queueOf([rowIn(ExecutionRecordStatus.Failed, kept)]);
    const legacy = queueOf([rowIn(ExecutionRecordStatus.Failed, LEGACY_FAILURE)]);
    const none = queueOf([rowIn(ExecutionRecordStatus.Failed)]);

    const first = await remoteChildEndOf(
      graphOf({ usage: [] }),
      {},
      siteOf(recorded.queue).site,
      undefined,
    );

    expect(first.error).toBeInstanceOf(RecordedError);
    for (const refused of [legacy, none])
      await expect(
        remoteChildEndOf(graphOf({ usage: [] }), {}, siteOf(refused.queue).site, undefined),
      ).rejects.toBeInstanceOf(StoredNamesUnreadableError);
  });
});

describe("#1366: the watch a waiting parent opens on its child", () => {
  it("is closed after every wait, also when the wait ends in a failure", async () => {
    const closed: string[] = [];
    const real = remoteChildSignals.watchEnd.bind(remoteChildSignals);
    const spy = vi.spyOn(remoteChildSignals, "watchEnd").mockImplementation((key) => {
      const watch = real(key);
      return {
        signal: watch.signal,
        close: () => {
          closed.push(key);
          watch.close();
        },
      };
    });
    const ok = queueOf([
      rowIn(ExecutionRecordStatus.Queued),
      rowIn(ExecutionRecordStatus.Queued),
      rowIn(ExecutionRecordStatus.Answered),
    ]);
    await remoteChildEndOf(graphOf({ usage: [] }), {}, siteOf(ok.queue).site, undefined);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(closed).toEqual([treeKeyOf("acme", "child-1")]);

    const lost = queueOf([rowIn(ExecutionRecordStatus.Queued), undefined]);
    await remoteChildEndOf(graphOf({ usage: [] }), {}, siteOf(lost.queue).site, undefined).catch(
      () => undefined,
    );
    expect(closed).toHaveLength(2);
    spy.mockRestore();
  });

  it("a row that settles on the first read is not slept for; one that settles after a sleep is read no more", async () => {
    const quick = queueOf([
      rowIn(ExecutionRecordStatus.Queued),
      rowIn(ExecutionRecordStatus.Answered),
    ]);
    const first = siteOf(quick.queue);
    await remoteChildEndOf(graphOf({ usage: [] }), {}, first.site, undefined);
    expect(first.clock.sleep).not.toHaveBeenCalled();
    expect(quick.reads()).toBe(2);

    const slow = queueOf([
      rowIn(ExecutionRecordStatus.Queued),
      rowIn(ExecutionRecordStatus.Queued),
      rowIn(ExecutionRecordStatus.Answered),
    ]);
    const second = siteOf(slow.queue);
    await remoteChildEndOf(graphOf({ usage: [] }), {}, second.site, undefined);
    expect(second.clock.sleep).toHaveBeenCalledTimes(1);
    expect(slow.reads()).toBe(3);
  });
});

describe("#1366: a child that rests at a pause", () => {
  const openAt = (...ids: (string | undefined)[]): StateSnapshot["tasks"] => [
    {
      id: "task-1",
      name: "child-node",
      interrupts: ids.map((id) => (id === undefined ? { value: 1 } : { id, value: 1 })),
    },
  ];
  const answered = (resume: Record<string, string>) => {
    interrupts.values.length = 0;
    interrupts.answer = JSON.stringify(resume);
  };

  it("interrupts its parent's step naming where the child waits, on any instance", async () => {
    answered({});
    const { queue } = queueOf([
      rowIn(ExecutionRecordStatus.Paused),
      rowIn(ExecutionRecordStatus.Answered),
    ]);
    const { site } = siteOf(queue);

    await remoteChildEndOf(graphOf({ usage: [] }), {}, site, undefined);

    expect(interrupts.values).toEqual([
      {
        waitingForChild: {
          executionId: "child-1",
          thread: "root-thread/child/child-1",
          node: "child-node",
          isRecursive: false,
          remote: true,
        },
      },
    ]);
  });

  it("re-queues the child with the resume that answers one of its open pauses, and wakes the claimers", async () => {
    answered({ "int-1": "yes" });
    const { queue, saved } = queueOf([
      rowIn(ExecutionRecordStatus.Paused),
      rowIn(ExecutionRecordStatus.Answered),
    ]);
    const woke: string[] = [];
    const off = remoteChildSignals.onQueued(() => woke.push("woke"));
    const { site } = siteOf(queue);

    const end = await remoteChildEndOf(
      graphOf({ usage: [] }, openAt("int-1")),
      {},
      site,
      undefined,
    );
    off();

    expect(saved).toHaveLength(1);
    const { data } = JSON.parse(saved[0]?.run ?? "{}") as { data: string };
    expect(JSON.parse(Buffer.from(data, "base64").toString())).toMatchObject({
      resume: { "int-1": "yes" },
    });
    expect(woke).toEqual(["woke"]);
    expect(end).toMatchObject({ failed: false, announces: false });
  });

  it("re-queues when one of several tasks has the answered pause, though another has none", async () => {
    answered({ "int-1": "yes" });
    const { queue, saved } = queueOf([
      rowIn(ExecutionRecordStatus.Paused),
      rowIn(ExecutionRecordStatus.Answered),
    ]);
    const tasks: StateSnapshot["tasks"] = [
      { id: "task-0", name: "child-node", interrupts: [] },
      { id: "task-1", name: "child-node", interrupts: [{ id: "int-1", value: 1 }] },
    ];

    await remoteChildEndOf(graphOf({ usage: [] }, tasks), {}, siteOf(queue).site, undefined);

    expect(saved).toHaveLength(1);
  });

  it("re-queues when any one of several pauses is answered, and none when no open pause is", async () => {
    answered({ "int-2": "yes" });
    const some = queueOf([
      rowIn(ExecutionRecordStatus.Paused),
      rowIn(ExecutionRecordStatus.Answered),
    ]);
    await remoteChildEndOf(
      graphOf({ usage: [] }, openAt("int-1", "int-2")),
      {},
      siteOf(some.queue).site,
      undefined,
    );
    expect(some.saved).toHaveLength(1);

    answered({ "int-9": "yes" });
    const none = queueOf([
      rowIn(ExecutionRecordStatus.Paused),
      rowIn(ExecutionRecordStatus.Paused),
      rowIn(ExecutionRecordStatus.Answered),
    ]);
    const woke: string[] = [];
    const off = remoteChildSignals.onQueued(() => woke.push("woke"));
    await remoteChildEndOf(
      graphOf({ usage: [] }, openAt("int-1", "int-2")),
      {},
      siteOf(none.queue).site,
      undefined,
    );
    off();
    expect(none.saved).toEqual([]);
    expect(woke).toEqual([]);
    expect(interrupts.values).toHaveLength(2);
  });

  it("an interrupt with no id answers nothing, though the resume has a key of that name", async () => {
    answered({ undefined: "yes" });
    const { queue, saved } = queueOf([
      rowIn(ExecutionRecordStatus.Paused),
      rowIn(ExecutionRecordStatus.Paused),
      rowIn(ExecutionRecordStatus.Answered),
    ]);

    await remoteChildEndOf(
      graphOf({ usage: [] }, openAt(undefined)),
      {},
      siteOf(queue).site,
      undefined,
    );

    expect(saved).toEqual([]);
  });

  it("a child already re-queued by another pass is not queued again, and no one is woken for it", async () => {
    answered({ "int-1": "yes" });
    const { queue, saved } = queueOf(
      [rowIn(ExecutionRecordStatus.Paused), rowIn(ExecutionRecordStatus.Failed, FAILURE)],
      false,
    );
    const woke: string[] = [];
    const off = remoteChildSignals.onQueued(() => woke.push("woke"));

    const end = await remoteChildEndOf(
      graphOf({ usage: [] }, openAt("int-1")),
      {},
      siteOf(queue).site,
      undefined,
    );
    off();

    expect(saved).toHaveLength(1);
    expect(woke).toEqual([]);
    expect(end).toMatchObject({ failed: true, announces: false });
  });
});
