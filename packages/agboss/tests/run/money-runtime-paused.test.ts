import { usd } from "../../src/units/index.js";
/**
 * #1366 (money-runtime shard) — how the spend of a paused run is found, each rule on its own over fake checkpoints: a
 * run waits when nodes are left; an agent loop's own spend lives in the checkpoint of the task it waits in, under the
 * namespace of that task below its parents; only a task with an open pause waits (one that took its answer and
 * finished does not), a child workflow's loops are found below its node and on its own thread, a step that waits
 * at its own interrupt has none, and every branch's spend is counted once.
 */
import { INTERRUPT } from "@langchain/langgraph";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { childGraphOf, waitingForOf } from "../../src/flow/runtime/child-thread.js";
import {
  finishedTaskIdsOf,
  isWaiting,
  loopOf,
  pausedLoopsOf,
  pausedUsageOf,
  runConfig,
} from "../../src/run/paused.js";

vi.mock("../../src/flow/runtime/child-thread.js", () => ({
  childGraphOf: vi.fn(),
  waitingForOf: vi.fn(),
}));

const record = (costUsd: number, caller = "agent:a"): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

/** An agent loop's state: it was handed `from` records and has `own` of its own after them. */
const loopState = (from: number, ...own: UsageRecord[]) => ({
  usage: [...Array.from({ length: from }, (_, index) => record(100 + index, "handed")), ...own],
  from: { usage: from },
});
const OPEN = { open: true };
const taskOf = (id: string, changes: Record<string, unknown> = {}) => ({
  id,
  name: "agent",
  interrupts: [{ value: OPEN }],
  state: undefined,
  ...changes,
});
const snapshotOf = (tasks: object[], namespace?: unknown, values: object = {}) => ({
  tasks,
  values,
  next: [],
  config: { configurable: namespace === undefined ? undefined : { checkpoint_ns: namespace } },
});
const tupleOf = (values: object, pendingWrites?: [string, string, unknown][]) => ({
  checkpoint: { channel_values: values },
  ...(pendingWrites === undefined ? {} : { pendingWrites }),
});
const isOpen = (value: unknown): boolean => (value as { open?: boolean }).open === true;

function setup(snapshot: object, tuples: Record<string, object | undefined> = {}) {
  // only the root's state is there to read: a read of another namespace is a read the run never makes
  const getState = vi.fn(
    (config: { configurable?: { checkpoint_ns?: string } }, _options?: unknown) =>
      config.configurable?.checkpoint_ns === undefined
        ? Promise.resolve(snapshot)
        : Promise.reject(new Error(`unexpected read of ${config.configurable.checkpoint_ns}`)),
  );
  const getTuple = vi.fn(
    (config: { configurable: { thread_id: string; checkpoint_ns?: string } }) =>
      Promise.resolve(
        tuples[`${config.configurable.thread_id}/${config.configurable.checkpoint_ns ?? ""}`],
      ),
  );
  return { graph: { getState } as never, saver: { getTuple } as never, getState, getTuple };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("#1366: the config of a run and whether it waits", () => {
  it("the checkpoint thread is the run id, over the caller's own keys and the run's services", () => {
    const config = runConfig("run-1", { run: "ctx" } as never, {
      a: 1,
      thread_id: "other",
      run: "own",
    });

    expect(config).toEqual({ configurable: { a: 1, run: "ctx", thread_id: "run-1" } });
    expect(runConfig("run-1")).toEqual({ configurable: { thread_id: "run-1" } });
  });

  it("a run with nodes left in its checkpoint waits for a decision", async () => {
    const waiting = setup({ next: ["agent"] });
    const done = setup({ next: [] });

    expect(await isWaiting(waiting.graph, "run-1")).toBe(true);
    expect(await isWaiting(done.graph, "run-1")).toBe(false);
    expect(waiting.getState).toHaveBeenCalledWith({ configurable: { thread_id: "run-1" } });
  });
});

describe("#1366: the tasks that finished while their siblings still wait", () => {
  it("are those that wrote a result: not an interrupt, a resume or an error", async () => {
    const { saver, getTuple } = setup(
      {},
      {
        "run-1/": tupleOf({}, [
          ["t-done", "result", 1],
          ["t-asked", INTERRUPT, 1],
          ["t-resumed", "__resume__", 1],
          ["t-failed", "__error__", 1],
          ["t-also", "other", 2],
        ]),
      },
    );

    expect([...(await finishedTaskIdsOf(saver, "run-1"))]).toEqual(["t-done", "t-also"]);
    expect(getTuple).toHaveBeenCalledWith({ configurable: { thread_id: "run-1" } });
  });

  it("are none without a checkpointer, a checkpoint, or its pending writes", async () => {
    const { saver } = setup({}, { "run-1/": tupleOf({}) });

    expect((await finishedTaskIdsOf(undefined, "run-1")).size).toBe(0);
    expect((await finishedTaskIdsOf(true, "run-1")).size).toBe(0);
    expect((await finishedTaskIdsOf(saver, "run-1")).size).toBe(0);
    expect((await finishedTaskIdsOf(setup({}).saver, "run-1")).size).toBe(0);
  });
});

describe("#1366: the loops a paused run waits in", () => {
  it("an agent loop's spend is what it added to the usage it was handed, read under its task's namespace", async () => {
    const { graph, saver, getState, getTuple } = setup(snapshotOf([taskOf("t1")]), {
      "run-1/": tupleOf({}),
      "run-1/agent:t1": tupleOf(loopState(2, record(0.25, "a"), record(0.5, "b"))),
    });

    const loops = await pausedLoopsOf(graph, saver, "run-1", isOpen);

    expect(loops).toEqual([{ usage: [record(0.25, "a"), record(0.5, "b")] }]);
    expect(getState).toHaveBeenCalledWith(
      { configurable: { thread_id: "run-1" } },
      { subgraphs: true },
    );
    expect(getTuple).toHaveBeenCalledWith({
      configurable: { thread_id: "run-1", checkpoint_ns: "agent:t1" },
    });
  });

  it("below a parent's namespace its own is joined to it", async () => {
    const { graph, saver } = setup(snapshotOf([taskOf("t1")], "flow:p1"), {
      "run-1/": tupleOf({}),
      "run-1/flow:p1|agent:t1": tupleOf(loopState(0, record(0.25))),
    });

    expect(await pausedLoopsOf(graph, saver, "run-1", isOpen)).toEqual([{ usage: [record(0.25)] }]);
  });

  it.each([
    ["no config at all", undefined],
    ["a namespace that is no text", 5],
  ])(
    "a snapshot with %s is at the root: its tasks' namespace is their own",
    async (_why, namespace) => {
      const { graph, saver } = setup(snapshotOf([taskOf("t1")], namespace), {
        "run-1/agent:t1": tupleOf(loopState(0, record(0.25))),
      });

      expect(await pausedLoopsOf(graph, saver, "run-1", isOpen)).toEqual([
        { usage: [record(0.25)] },
      ]);
    },
  );

  it("only a task with an open pause waits: one whose pause is closed, or that finished, adds nothing", async () => {
    const { graph, saver } = setup(
      snapshotOf([
        taskOf("t-open"),
        taskOf("t-closed", { interrupts: [{ value: { open: false } }] }),
        taskOf("t-finished"),
        taskOf("t-none", { interrupts: [] }),
        taskOf("t-mixed", { interrupts: [{ value: { open: false } }, { value: OPEN }] }),
      ]),
      {
        "run-1/": tupleOf({}, [["t-finished", "result", 1]]),
        "run-1/agent:t-open": tupleOf(loopState(0, record(1, "open"))),
        "run-1/agent:t-closed": tupleOf(loopState(0, record(2, "closed"))),
        "run-1/agent:t-finished": tupleOf(loopState(0, record(3, "finished"))),
        "run-1/agent:t-none": tupleOf(loopState(0, record(4, "none"))),
        "run-1/agent:t-mixed": tupleOf(loopState(0, record(5, "mixed"))),
      },
    );

    const loops = await pausedLoopsOf(graph, saver, "run-1", isOpen);

    expect(loops.flatMap((loop) => loop.usage.map((u) => u.caller))).toEqual(["open", "mixed"]);
  });

  it("a step that waits at its own interrupt has a loop of no spend", async () => {
    const { graph, saver } = setup(snapshotOf([taskOf("t1")]), { "run-1/": tupleOf({}) });

    expect(await pausedLoopsOf(graph, saver, "run-1", isOpen)).toEqual([{ usage: [] }]);
  });

  it("a child workflow's node is read through its own snapshot: the loops are below it", async () => {
    const inner = snapshotOf([taskOf("t2", { name: "inner" })], "child:c1");
    const { graph, saver } = setup(snapshotOf([taskOf("t1", { state: inner })]), {
      "run-1/": tupleOf({}),
      "run-1/child:c1|inner:t2": tupleOf(loopState(0, record(0.25, "inner"))),
    });

    expect(await pausedLoopsOf(graph, saver, "run-1", isOpen)).toEqual([
      { usage: [record(0.25, "inner")] },
    ]);
  });

  it("a workflow run from the registry (its checkpoint holds a child) is read the same way, from its own state", async () => {
    const inner = snapshotOf([taskOf("t2", { name: "inner" })], "agent:t1");
    const { graph, saver, getState } = setup(snapshotOf([taskOf("t1")]), {
      "run-1/": tupleOf({}),
      "run-1/agent:t1": tupleOf({ child: { executionId: "c1" } }),
      "run-1/agent:t1|inner:t2": tupleOf(loopState(0, record(0.25, "inner"))),
    });
    getState.mockResolvedValueOnce(snapshotOf([taskOf("t1")]));
    getState.mockResolvedValueOnce(inner);

    const loops = await pausedLoopsOf(graph, saver, "run-1", isOpen);

    expect(loops).toEqual([{ usage: [record(0.25, "inner")] }]);
    expect(getState).toHaveBeenLastCalledWith(
      { configurable: { thread_id: "run-1", checkpoint_ns: "agent:t1" } },
      { subgraphs: true },
    );
  });

  it.each([
    ["no state", undefined],
    ["a state that is null", null],
    ["a state that is a text", "waiting"],
    ["a state with tasks and no values", { tasks: [] }],
    ["a state with values and no tasks", { values: {} }],
  ])(
    "a task with %s is no child workflow: its loop is read from its own checkpoint",
    async (_why, state) => {
      const { graph, saver } = setup(snapshotOf([taskOf("t1", { state })]), {
        "run-1/": tupleOf({}),
        "run-1/agent:t1": tupleOf(loopState(0, record(0.25))),
      });

      expect(await pausedLoopsOf(graph, saver, "run-1", isOpen)).toEqual([
        { usage: [record(0.25)] },
      ]);
    },
  );

  it("a checkpoint with no values at all is no child's, and no loop's either: it is refused for what it lacks", async () => {
    const { graph, saver } = setup(snapshotOf([taskOf("t1")]), {
      "run-1/": tupleOf({}),
      "run-1/agent:t1": { checkpoint: { channel_values: null } },
    });

    await expect(pausedLoopsOf(graph, saver, "run-1", isOpen)).rejects.toThrow(/usage/);
  });

  it("a checkpoint whose child is unset is an agent loop's own", async () => {
    const { graph, saver } = setup(snapshotOf([taskOf("t1")]), {
      "run-1/": tupleOf({}),
      "run-1/agent:t1": tupleOf({ ...loopState(0, record(0.25)), child: undefined }),
    });

    expect(await pausedLoopsOf(graph, saver, "run-1", isOpen)).toEqual([{ usage: [record(0.25)] }]);
  });

  it("a child waited for on its own thread: its loops are read on its graph and thread, after the parent's own", async () => {
    const childSnapshot = snapshotOf([taskOf("c-t1")]);
    const child = setup(childSnapshot, {
      "child-thread/": tupleOf({}),
      "child-thread/agent:c-t1": tupleOf(loopState(0, record(0.5, "child"))),
    });
    vi.mocked(waitingForOf).mockImplementation(((value: { waits?: boolean }) =>
      value.waits === true ? { thread: "child-thread" } : undefined) as never);
    vi.mocked(childGraphOf).mockResolvedValue(child.graph);
    const waits = { value: { waits: true } };
    const parent = setup(
      snapshotOf([taskOf("t1", { interrupts: [{ value: { open: false } }, waits] }), taskOf("t2")]),
      {
        "run-1/": tupleOf({}),
        "run-1/agent:t2": tupleOf(loopState(0, record(0.25, "parent"))),
      },
    );
    // the same checkpointer serves both threads
    const saver = {
      getTuple: vi.fn((config: { configurable: { thread_id: string } }) =>
        config.configurable.thread_id === "child-thread"
          ? child.getTuple(config as never)
          : parent.getTuple(config as never),
      ),
    };

    const loops = await pausedLoopsOf(parent.graph, saver as never, "run-1", isOpen);

    expect(loops.flatMap((loop) => loop.usage.map((u) => u.caller))).toEqual(["parent", "child"]);
    expect(child.getState).toHaveBeenCalledWith(
      { configurable: { thread_id: "child-thread" } },
      { subgraphs: true },
    );
  });

  it("a child whose graph is not known is not read, and the interrupts after the one that names it are not either", async () => {
    vi.mocked(waitingForOf).mockReturnValue({ thread: "child-thread" } as never);
    vi.mocked(childGraphOf).mockResolvedValue(undefined);
    const { graph, saver } = setup(
      snapshotOf([taskOf("t1", { interrupts: [{ value: { open: false } }, { value: OPEN }] })]),
      { "run-1/": tupleOf({}) },
    );

    const loops = await pausedLoopsOf(graph, saver, "run-1", isOpen);

    expect(childGraphOf).toHaveBeenCalledTimes(1);
    expect(loops.length).toBeLessThanOrEqual(1);
  });
});

describe("#1366: what a paused loop and a paused run have spent", () => {
  it("a loop's spend is what it added to the usage it was handed", () => {
    expect(loopOf(loopState(2, record(0.25), record(0.5)) as never)).toEqual({
      usage: [record(0.25), record(0.5)],
    });
    expect(loopOf(loopState(2) as never)).toEqual({ usage: [] });
  });

  it("is the flow's own and every loop's, each once and in that order", () => {
    const usage = pausedUsageOf(
      [record(1, "flow")],
      [{ usage: [record(2, "a")] }, { usage: [] }, { usage: [record(3, "b"), record(4, "c")] }],
    );

    expect(usage.map((u) => u.caller)).toEqual(["flow", "a", "b", "c"]);
    expect(pausedUsageOf([], [])).toEqual([]);
  });
});
