import { usd } from "../../src/units/index.js";
/**
 * #1366 (ledger-run shard) — the spend a recovered and a resumed pass starts from, each rule on its own: what
 * recovery reads of the checkpoint (the state, or the first task's input), what it refuses to continue, the
 * spend that is already in the ledger and so is not recorded again, and what a resume adds to it (every paused
 * loop's spend and the free-text replies').
 */
import { Command } from "@langchain/langgraph";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { continueAgent, NothingToRecoverError, withInitial } from "../../src/run/continue-agent.js";
import { continueRun } from "../../src/run/continue-run.js";
import { isWaiting, pausedLoopsOf } from "../../src/run/paused.js";
import { readingGraphOf } from "../../src/run/run-budgets.js";
import { NotPausedError, resumeAgent } from "../../src/run/resume-agent.js";
import { openPausesOf } from "../../src/run/waiting-pauses.js";

vi.mock("../../src/run/continue-run.js", () => ({ continueRun: vi.fn() }));
vi.mock("../../src/run/run-budgets.js", async (original) => ({
  ...(await original<typeof import("../../src/run/run-budgets.js")>()),
  readingGraphOf: vi.fn(),
}));
vi.mock("../../src/run/paused.js", async (original) => ({
  ...(await original<typeof import("../../src/run/paused.js")>()),
  isWaiting: vi.fn(),
  pausedLoopsOf: vi.fn(),
}));
vi.mock("../../src/run/waiting-pauses.js", async (original) => ({
  ...(await original<typeof import("../../src/run/waiting-pauses.js")>()),
  openPausesOf: vi.fn(),
}));

const record = (costUsd: number, caller = "agent:a"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const STARTED = { start: "chat", startInput: { text: "hi" }, usage: [record(0.5)] };

/** The pass `continueRun` was given by the code under test. */
type Pass = (
  graph: never,
  streaming: never,
  record: (records: readonly UsageRecord[]) => Promise<void>,
) => Promise<unknown>;

const continued = (): {
  run: Record<string, unknown>;
  options: unknown;
  pass: Pass;
} => {
  const [run, , options, pass] = vi.mocked(continueRun).mock.calls[0] ?? [];
  return { run: run as never, options, pass: pass as never };
};

/** A stream of states, as LangGraph's `stream` hands them. */
async function* statesOf(...states: readonly unknown[]): AsyncGenerator {
  await Promise.resolve();
  for (const state of states) yield state;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(continueRun).mockResolvedValue({ status: ExecutionStatus.Finished } as never);
});

describe("#1366: recovery continues an execution from its last checkpoint", () => {
  const interrupted = {
    runId: "run-1",
    threadId: "thread-1",
    tenantId: "tenant-1",
    turnId: "turn-1",
    startedVersion: "1.0.0",
  };

  interface Checkpoint {
    readonly values: Record<string, unknown>;
    readonly tasks?: readonly unknown[];
    /** The first task's input, under the `__start__` channel. */
    readonly channel?: unknown;
    readonly saver?: "none" | "unsaved" | "saved";
  }

  /** Recovery's deps over a checkpoint: its state, its tasks, and what its saver keeps under `__start__`. */
  const recoveryOf = (checkpoint: Checkpoint) => {
    const getTuple = vi.fn(() =>
      Promise.resolve(
        checkpoint.saver === "unsaved"
          ? undefined
          : { checkpoint: { channel_values: { __start__: checkpoint.channel } } },
      ),
    );
    const checkpointer = checkpoint.saver === "none" ? true : { getTuple };
    const getState = vi.fn(() =>
      Promise.resolve({ values: checkpoint.values, tasks: checkpoint.tasks ?? [], next: [] }),
    );
    vi.mocked(readingGraphOf).mockReturnValue({ getState, checkpointer } as never);
    const complete = vi.fn(() => Promise.resolve());
    return { deps: { turns: { complete } } as never, getTuple, getState, complete };
  };

  it("continues from the state it finds: its usage is the spend already in the ledger", async () => {
    const { deps, getState } = recoveryOf({
      values: { ...STARTED, budgetUsd: 2, budgets: [{ budget: { name: "b" } }], contexts: {} },
    });

    await continueAgent(interrupted, deps, { signal: undefined });

    expect(getState).toHaveBeenCalledWith({ configurable: { thread_id: "run-1" } });
    expect(continued().run).toEqual({
      ...interrupted,
      start: "chat",
      startInput: { text: "hi" },
      budgetUsd: 2,
      budgets: [{ budget: { name: "b" } }],
      deadline: undefined,
      spent: [record(0.5)],
    });
    expect(continued().options).toEqual({ signal: undefined });
  });

  it("without a budget in the state its limit is 0; the deadline is the state's own", async () => {
    const deadline = { at: "2026-11-21T00:00:00.000Z" };
    const { deps } = recoveryOf({ values: { ...STARTED, contexts: { deadline } } });

    await continueAgent(interrupted, deps);

    expect(continued().run).toMatchObject({ budgetUsd: 0, deadline });
  });

  it("a state without contexts has no deadline, and is no failure", async () => {
    const { deps } = recoveryOf({ values: { ...STARTED, budgetUsd: 1 } });

    await continueAgent(interrupted, deps);

    expect(continued().run).toMatchObject({ budgetUsd: 1, deadline: undefined });
  });

  it("the state at its defaults takes the run's initial state from the first task's input", async () => {
    const initial = { start: "chat", startInput: { text: "hi" }, usage: [record(1)], budgetUsd: 3 };
    const { deps, getTuple } = recoveryOf({
      values: { start: "", usage: [], budgetUsd: 9 },
      channel: initial,
      saver: "saved",
    });

    await continueAgent(interrupted, deps);

    expect(getTuple).toHaveBeenCalledWith({ configurable: { thread_id: "run-1" } });
    expect(continued().run).toMatchObject({
      start: "chat",
      startInput: { text: "hi" },
      budgetUsd: 3,
      spent: [record(1)],
    });
  });

  it("a state that has its start does not read the first task's input", async () => {
    const { deps, getTuple } = recoveryOf({
      values: { ...STARTED },
      channel: { start: "other", usage: [record(7)] },
      saver: "saved",
    });

    await continueAgent(interrupted, deps);

    expect(getTuple).not.toHaveBeenCalled();
    expect(continued().run).toMatchObject({ start: "chat", spent: [record(0.5)] });
  });

  it.each([
    ["a run's input that is not an object", "chat"],
    ["a run's input that is null", null],
    ["no input in the channel", undefined],
  ])("%s is no initial state: nothing to continue", async (_name, channel) => {
    const { deps, complete } = recoveryOf({
      values: { start: "", usage: [] },
      channel,
      saver: "saved",
    });

    await expect(continueAgent(interrupted, deps)).rejects.toBeInstanceOf(NothingToRecoverError);

    expect(complete).toHaveBeenCalledOnce();
    expect(continueRun).not.toHaveBeenCalled();
  });

  it("an input that is no plain object, even one with a start of its own, is no initial state", async () => {
    const input = Object.assign(() => undefined, { start: "chat", usage: [] });
    const { deps } = recoveryOf({ values: { start: "" }, channel: input, saver: "saved" });

    await expect(continueAgent(interrupted, deps)).rejects.toBeInstanceOf(NothingToRecoverError);
  });

  it("the state with no initial laid over it is the state itself", () => {
    const values = { start: "" };

    expect(withInitial(values, undefined)).toBe(values);
    expect(withInitial(values, { start: "chat" })).toEqual({ start: "chat" });
    expect(withInitial(values, { start: "chat" })).not.toBe(values);
  });

  it("no checkpoint for the first task is no initial state either", async () => {
    const { deps } = recoveryOf({ values: { start: "" }, saver: "unsaved" });

    await expect(continueAgent(interrupted, deps)).rejects.toBeInstanceOf(NothingToRecoverError);
  });

  it("a checkpointer that is no store is read for nothing: nothing to continue", async () => {
    const { deps, getTuple } = recoveryOf({ values: { start: "" }, saver: "none" });

    await expect(continueAgent(interrupted, deps)).rejects.toBeInstanceOf(NothingToRecoverError);

    expect(getTuple).not.toHaveBeenCalled();
  });

  it.each([
    ["no start", { usage: [] }],
    ["an empty start", { start: "", usage: [] }],
    ["no usage", { start: "chat" }],
  ])(
    "%s: its record is completed as failed with what stopped it, and nothing runs",
    async (_name, values) => {
      const { deps, complete } = recoveryOf({ values });

      const failure = await continueAgent(interrupted, deps).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(NothingToRecoverError);
      expect((failure as Error).message).toBe(
        "execution run-1 stopped before its first checkpoint: nothing to continue",
      );
      expect(complete).toHaveBeenCalledWith("turn-1", {
        replyWith: "",
        status: "failed",
        stopReason: "execution run-1 stopped before its first checkpoint: nothing to continue",
        route: [],
        steps: [],
        costUsd: usd(0),
      });
      expect(continueRun).not.toHaveBeenCalled();
    },
  );

  it("a graph with no task left is only finished: its state, no step run", async () => {
    const values = { ...STARTED };
    const { deps } = recoveryOf({ values, tasks: [] });
    const moving = { stream: vi.fn() };

    await continueAgent(interrupted, deps);
    const state = await continued().pass(moving as never, {} as never, vi.fn());

    expect(state).toBe(values);
    expect(moving.stream).not.toHaveBeenCalled();
  });

  it("a graph with a task left runs it: the spend the state holds is not recorded again, the new is", async () => {
    const { deps } = recoveryOf({ values: { ...STARTED }, tasks: [{ id: "t" }] });
    const next = [record(0.5), record(0.25)];
    const moving = { stream: vi.fn(() => statesOf({ usage: next })) };
    const recorded = vi.fn(() => Promise.resolve());
    const streaming = { callbacks: [] };

    await continueAgent(interrupted, deps);
    const state = await continued().pass(moving as never, streaming as never, recorded);

    expect(moving.stream).toHaveBeenCalledWith(null, streaming);
    expect(recorded).toHaveBeenCalledOnce();
    expect(recorded).toHaveBeenCalledWith([record(0.25)]);
    expect(state).toEqual({ usage: next });
  });
});

describe("#1366: a resume continues a paused run with what it has spent", () => {
  const paused = {
    status: ExecutionStatus.Paused,
    runId: "run-1",
    tenantId: "tenant-1",
    turnId: "turn-1",
    threadId: "thread-1",
  };
  const answer = (usage: readonly UsageRecord[] | undefined, pauseId: string) => ({
    pauseId,
    ...(usage === undefined ? {} : { answer: { usage } }),
  });
  const resumeOf = (taken: readonly unknown[] = [], values: Record<string, string> = {}) =>
    ({ values, pauseIds: taken.map((_, i) => `p${String(i)}`), taken }) as never;

  const setup = (state: Record<string, unknown> | undefined, loops: readonly unknown[]) => {
    const isOpen = vi.fn();
    const getState = vi.fn(() => Promise.resolve({ values: state }));
    const checkpointer = { name: "saver" };
    const graph = { getState };
    vi.mocked(readingGraphOf).mockReturnValue(graph as never);
    vi.mocked(isWaiting).mockResolvedValue(true);
    vi.mocked(pausedLoopsOf).mockResolvedValue(loops as never);
    vi.mocked(openPausesOf).mockResolvedValue(isOpen);
    const pauses = { name: "pauses" };
    return {
      deps: { pause: { pauses, checkpointer } } as never,
      graph,
      checkpointer,
      isOpen,
      pauses,
    };
  };

  it("what it spent is the flow's usage and every paused loop's, then the replies' read in the ledger already", async () => {
    const { deps } = setup(
      {
        usage: [record(1)],
        budgets: [{ budget: { name: "b" } }],
        contexts: { deadline: { at: "d" } },
      },
      [{ usage: [record(0.25)] }, { usage: [record(0.5, "agent:b")] }],
    );
    const taken = [answer([record(0.125, "reader")], "p0"), answer(undefined, "p1")];

    await resumeAgent(paused as never, resumeOf(taken), deps);

    expect(continued().run).toMatchObject({
      runId: "run-1",
      budgets: [{ budget: { name: "b" } }],
      deadline: { at: "d" },
      spent: [record(1), record(0.25), record(0.5, "agent:b"), record(0.125, "reader")],
    });
  });

  it("a state without usage or contexts spends what its loops did, and has no deadline", async () => {
    const { deps } = setup({}, [{ usage: [record(0.25)] }]);

    await resumeAgent(paused as never, resumeOf(), deps);

    expect(continued().run).toMatchObject({
      spent: [record(0.25)],
      budgets: undefined,
      deadline: undefined,
    });
  });

  it("the pass takes the pauses it answers, and keeps the other fields of the paused run", async () => {
    const { deps } = setup({ usage: [] }, [{ usage: [] }]);
    const taken = [answer(undefined, "p0"), answer(undefined, "p1")];

    await resumeAgent(paused as never, resumeOf(taken), deps);

    expect(continued().run.takenPauseIds).toEqual(new Set(["p0", "p1"]));
    expect(continued().run).toMatchObject({ turnId: "turn-1", threadId: "thread-1" });
  });

  it("reads the loops where the run waits: the open pauses of its tree, those it answers included", async () => {
    const { deps, graph, checkpointer, isOpen, pauses } = setup({ usage: [] }, [{ usage: [] }]);
    const resume = { values: {}, pauseIds: ["a", "b"], taken: [] } as never;

    await resumeAgent(paused as never, resume, deps);

    expect(isWaiting).toHaveBeenCalledWith(graph, "run-1");
    expect(openPausesOf).toHaveBeenCalledWith(
      pauses,
      { tenantId: "tenant-1", runId: "run-1" },
      { answering: new Set(["a", "b"]) },
    );
    expect(pausedLoopsOf).toHaveBeenCalledWith(graph, checkpointer, "run-1", isOpen);
    expect(graph.getState).toHaveBeenCalledWith({ configurable: { thread_id: "run-1" } });
  });

  it("a run that is not paused, or has no pause seam, is refused", async () => {
    const { deps } = setup({ usage: [] }, [{ usage: [] }]);
    const finished = { ...paused, status: ExecutionStatus.Finished };

    const notPaused = await resumeAgent(finished as never, resumeOf(), deps).catch(
      (e: unknown) => e,
    );
    const noSeam = await resumeAgent(paused as never, resumeOf(), {} as never).catch(
      (e: unknown) => e,
    );

    expect(notPaused).toBeInstanceOf(NotPausedError);
    expect((notPaused as Error).message).toBe("Run run-1 was not paused or the pause seam is off");
    expect(noSeam).toBeInstanceOf(NotPausedError);
    expect((noSeam as Error).message).toBe("Run run-1 was not paused or the pause seam is off");
    expect(continueRun).not.toHaveBeenCalled();
  });

  it("a run that waits for nothing is refused, and one with no paused loop too", async () => {
    const { deps } = setup({ usage: [] }, []);
    vi.mocked(isWaiting).mockResolvedValue(false);

    const notWaiting = await resumeAgent(paused as never, resumeOf(), deps).catch(
      (e: unknown) => e,
    );
    vi.mocked(isWaiting).mockResolvedValue(true);
    const noLoops = await resumeAgent(paused as never, resumeOf(), deps).catch((e: unknown) => e);

    for (const failure of [notWaiting, noLoops]) {
      expect(failure).toBeInstanceOf(NotPausedError);
      expect((failure as Error).message).toBe("Run run-1 is not waiting for an approval");
    }
    expect(pausedLoopsOf).toHaveBeenCalledTimes(1);
    expect(continueRun).not.toHaveBeenCalled();
  });

  it("the pass resumes with the answers and records only the spend that is not in the ledger", async () => {
    const { deps } = setup({ usage: [record(1)] }, [{ usage: [] }]);
    const resume = { values: { i1: "p0" }, pauseIds: ["p0"], taken: [] } as never;
    const moving = {
      stream: vi.fn(() => statesOf({ usage: [record(1), record(0.5, "agent:c")] })),
    };
    const recorded = vi.fn(() => Promise.resolve());
    const streaming = { callbacks: [] };

    await resumeAgent(paused as never, resume, deps, { signal: undefined });
    await continued().pass(moving as never, streaming as never, recorded);

    expect(moving.stream).toHaveBeenCalledWith(new Command({ resume: { i1: "p0" } }), streaming);
    expect(recorded).toHaveBeenCalledOnce();
    expect(recorded).toHaveBeenCalledWith([record(0.5, "agent:c")]);
    expect(continued().options).toEqual({ signal: undefined });
  });
});
