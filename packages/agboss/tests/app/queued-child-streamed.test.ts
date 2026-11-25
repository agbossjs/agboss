/**
 * #1366 (shard once-child) — the spend of a queued child's pass counted once (`streamed`): which spend a
 * pass starts its budget from and which it takes as in the ledger already, for a fresh child, a child
 * recovered from its last checkpoint and a paused child resumed with a reply. The graph is a script (what
 * its checkpoint holds, what it streams); the budgets, the recorder and the drain are the real ones, over a
 * ledger that lists what it was asked to save.
 */
import { Command, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/app/app-deps.js";
import { ExecutionPausedError } from "../../src/app/lease-stopped.js";
import { runQueuedChild, streamed } from "../../src/app/remote/queued-child-run.js";
import { ApplicationStoppingError, ExecutionCancelledError } from "../../src/core/errors.js";
import { BudgetScope } from "../../src/budgets/budget.js";
import type { BudgetMeter, ExecutionBudgetRecord } from "../../src/budgets/execution-budgets.js";
import { recordToolCost, type UsageRecord } from "../../src/finops/usage.js";
import type { FrameworkLog } from "../../src/infrastructure/logger.js";
import type { ExecutionStateType } from "../../src/flow/runtime/state.js";
import {
  InMemoryCostLedgerRepository,
  type CostCounter,
  type LedgerEntry,
} from "../../src/infrastructure/cost-ledger.repository.js";
import type { QueuedChildExecution } from "../../src/infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import { VirtualClock } from "../../src/testing/index.js";

/** What the mocked graph builder was asked, and the graphs it hands out in turn. */
const script = vi.hoisted(() => ({
  built: [] as { budgets: BudgetMeter }[],
  graphs: [] as unknown[],
  replies: [] as UsageRecord[],
  spendCalls: [] as unknown[][],
}));

vi.mock("../../src/flow/runtime/build.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/flow/runtime/build.js")>()),
  executionGraphOf: (_deps: unknown, options: { budgets: BudgetMeter }) => {
    script.built.push({ budgets: options.budgets });
    return script.graphs[Math.min(script.built.length, script.graphs.length) - 1];
  },
}));

vi.mock("../../src/app/remote/queued-child-spend.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/remote/queued-child-spend.js")>()),
  resumedSpendOf: (...args: unknown[]) => {
    script.spendCalls.push(args);
    return Promise.resolve([...(args[4] as readonly UsageRecord[]), ...script.replies]);
  },
}));

interface Seen {
  run: unknown;
  parentOf: unknown[][];
  contextsOutside: unknown[];
  tenantOf: unknown[][];
}

const seen = vi.hoisted((): Seen => ({
  run: undefined,
  parentOf: [],
  contextsOutside: [],
  tenantOf: [],
}));

vi.mock("../../src/flow/runtime/remote/remote-child-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/flow/runtime/remote/remote-child-run.js")>()),
  decodedRun: () => Promise.resolve(seen.run),
  parentOfRecord: (...args: unknown[]) => {
    seen.parentOf.push(args);
    return "the-parent";
  },
}));

vi.mock("../../src/flow/context/runtime-contexts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/flow/context/runtime-contexts.js")>()),
  contextsOutsideExecution: (config: unknown) => {
    seen.contextsOutside.push(config);
    return "contexts-outside";
  },
  tenantOfExecution: (...args: unknown[]) => {
    seen.tenantOf.push(args);
    return "the-tenant";
  },
}));

const NOW = new Date("2026-11-20T10:00:00.000Z");
const BUDGET: ExecutionBudgetRecord = {
  budget: { name: "execution-budget" },
  scope: BudgetScope.Execution,
  key: "root-1",
  maxSpend: 100,
};

/** A ledger that lists every entry it was asked to save. */
class SeenLedger extends InMemoryCostLedgerRepository {
  readonly seen: LedgerEntry[] = [];

  override saveAll(counters: readonly CostCounter[], entries: readonly LedgerEntry[]) {
    this.seen.push(...entries);
    return super.saveAll(counters, entries);
  }
}

const paid = (tool: string, costUsd: number): UsageRecord => recordToolCost(tool, costUsd);
const inherited = paid("parent-tool", 1);
const made = paid("child-tool-1", 2);
const reply = paid("reply-tool", 4);
const own = paid("child-tool-2", 8);

const WAITING = [{ id: "task-1", name: "agent", interrupts: [] }];
const waitingAt = (id: string) => [{ id: "task-1", name: "agent", interrupts: [{ id, value: 1 }] }];

interface Scripted {
  /** What the thread's checkpoint holds before the pass. */
  readonly before: unknown;
  readonly tasks?: readonly unknown[];
  /** The values the pass streams, in order. */
  readonly streams?: readonly (readonly UsageRecord[])[];
  /** The checkpoint the pass wrote last, when it names one. */
  readonly writes?: string;
  /** The tasks its end checkpoint still has: it rests when any. */
  readonly endTasks?: readonly unknown[];
  /** What its end checkpoint's values are, when not the last stream's state. */
  readonly end?: unknown;
}

/** A graph the pass reads its checkpoint with (`before`) and streams (`streams`). */
function graphOf(scripted: Scripted) {
  const states: { config: unknown }[] = [];
  const stream = vi.fn((_input: unknown, _config: unknown) =>
    Promise.resolve(
      (async function* () {
        for (const usage of scripted.streams ?? []) yield ["values", { usage } as never] as const;
        if (scripted.writes !== undefined)
          yield [
            "checkpoints",
            { config: { configurable: { checkpoint_id: scripted.writes } } },
          ] as const;
      })(),
    ),
  );
  const graph = {
    checkpointer: new MemorySaver(),
    getState: (config: unknown) => {
      states.push({ config });
      const isRunning = scripted.streams !== undefined;
      return Promise.resolve({
        values: isRunning
          ? (scripted.end ?? { usage: scripted.streams.at(-1) ?? [] })
          : scripted.before,
        tasks: isRunning ? (scripted.endTasks ?? []) : (scripted.tasks ?? []),
      });
    },
    stream,
  };
  return { graph, stream, states };
}

/** The graph of the reading pass (the checkpoint before it) and the graph of the pass itself. */
function graphsOf(reading: Scripted, running?: Scripted) {
  const first = graphOf(reading);
  const second = graphOf(running ?? { before: {}, streams: [] });
  script.built.length = 0;
  script.graphs = [first.graph, second.graph];
  script.replies = [];
  script.spendCalls = [];
  return { reading: first, running: second };
}

const row: QueuedChildExecution = {
  tenantId: "default",
  executionId: "child-1",
  rootExecutionId: "root-1",
  parentExecutionId: "root-1",
  rootWorkflow: "root-workflow",
  workflow: "child-workflow",
  depth: 2,
  status: ExecutionRecordStatus.Running,
  run: "{}",
  queuedAt: NOW,
};

/** One pass of the child on a worker whose application has the execution budget. */
async function pass(resume?: Readonly<Record<string, string>>) {
  const ledger = new SeenLedger();
  const warn = vi.fn();
  const log: FrameworkLog = { info: vi.fn(), warn, error: vi.fn() };
  const budgets: Partial<NonNullable<AppDeps["budgets"]>> = {
    budgets: [],
    applicationName: "app",
    resolve: () => {
      throw new Error("no budget handler is resolved");
    },
    ledger,
    clock: new VirtualClock(NOW),
  };
  const wired: Partial<AppDeps> = {
    config: { name: "root-workflow", version: "1" } as AppDeps["config"],
    log,
    pause: {} as AppDeps["pause"],
    budgets: budgets as AppDeps["budgets"],
  };
  const rootDeps = wired as AppDeps;
  const run = {
    thread: "root-thread/child/child-1",
    threadId: "root-thread",
    input: {},
    parent: undefined,
    piiPolicies: [],
    initial: {
      usage: [inherited],
      budgets: [BUDGET],
      child: { parentExecutionId: "root-1", rootExecutionId: "root-1", inheritedUsage: 1 },
    },
    ...(resume === undefined ? {} : { resume }),
  };
  const context = {
    runId: "child-1",
    threadId: "root-thread",
    tenantId: "default",
    input: {},
    signal: new AbortController().signal,
  };
  const childDeps = { config: { name: "child-workflow", version: "1" } };
  const ended = await streamed(childDeps as never, rootDeps, row, run as never, context as never);
  const saved = ledger.seen.map((entry) => entry.costUsd);
  return { ended, saved, warn, run, ledger };
}

/** What the execution may spend in all at the meter's last read: 100 + what it spent before the pass. */
const startedFrom = (meter: BudgetMeter | undefined): number | undefined =>
  meter === undefined ? undefined : meter.budgetUsd() - 100;

describe("#1366: the spend of a queued child's pass, counted once", () => {
  it("a fresh child: its budget starts from the spend it inherited, and only its own is recorded", async () => {
    const { running } = graphsOf(
      { before: {} },
      { before: {}, streams: [[inherited], [inherited, own]] },
    );

    const { ended, saved, warn, run } = await pass();

    expect(saved).toEqual([8]);
    expect(startedFrom(script.built[0]?.budgets)).toBe(1);
    expect(startedFrom(script.built[1]?.budgets)).toBe(1);
    expect(running.stream).toHaveBeenCalledTimes(1);
    expect(running.stream.mock.calls[0]?.[0]).toBe(run.initial);
    expect(ended).toEqual({ rests: false, last: { usage: [inherited, own] } });
    expect(warn).not.toHaveBeenCalled();
  });

  it("a child recovered from its last checkpoint: its budget starts from the spend the checkpoint holds, none of it recorded again", async () => {
    const { running } = graphsOf(
      { before: { usage: [inherited, made] }, tasks: WAITING },
      {
        before: {},
        streams: [
          [inherited, made],
          [inherited, made, own],
        ],
      },
    );

    const { ended, saved, warn } = await pass();

    expect(saved).toEqual([8]);
    expect(startedFrom(script.built[1]?.budgets)).toBe(3);
    expect(running.stream.mock.calls[0]?.[0]).toBeNull();
    expect(ended.rests).toBe(false);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "execution.recovered",
      "execution child-1 is recovered: it continues from its last checkpoint",
      { executionId: "child-1", tenantId: "default" },
    );
  });

  it("a paused child resumed with a reply: the reply's spend is counted from the start and never recorded again", async () => {
    const { running } = graphsOf(
      { before: { usage: [inherited, made] }, tasks: waitingAt("int-1") },
      {
        before: {},
        streams: [
          [inherited, made, reply],
          [inherited, made, reply, own],
        ],
      },
    );
    script.replies = [reply];

    const { saved, warn } = await pass({ "int-1": "yes" });

    expect(saved).toEqual([8]);
    expect(startedFrom(script.built[1]?.budgets)).toBe(7);
    const input = running.stream.mock.calls[0]?.[0];
    expect(input).toBeInstanceOf(Command);
    expect((input as Command).resume).toEqual({ "int-1": "yes" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("a child that ended already is read, not run: its checkpoint's state and no pass", async () => {
    const { running } = graphsOf({ before: { usage: [inherited, made] }, tasks: [] });

    const { ended, saved, warn } = await pass();

    expect(ended).toEqual({ rests: false, last: { usage: [inherited, made] } });
    expect(saved).toEqual([]);
    expect(running.stream).not.toHaveBeenCalled();
    expect(script.built).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a child waiting at a pause no one answers rests, and no pass is made", async () => {
    for (const resume of [undefined, { "other-int": "yes" }]) {
      const { running } = graphsOf({
        before: { usage: [inherited, made] },
        tasks: waitingAt("int-1"),
      });

      const { ended, saved, warn } = await pass(resume);

      expect(ended).toEqual({ rests: true });
      expect(saved).toEqual([]);
      expect(running.stream).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it("a child re-queued with a resume that answers none of its pauses continues quietly: it is not a recovery", async () => {
    const { running } = graphsOf(
      { before: { usage: [inherited, made] }, tasks: WAITING },
      { before: {}, streams: [[inherited, made, own]] },
    );

    const { saved, warn } = await pass({ "gone-int": "yes" });

    expect(saved).toEqual([8]);
    expect(running.stream.mock.calls[0]?.[0]).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(script.spendCalls).toEqual([]);
  });

  it("a pass that stops at another pause rests, with the state of the checkpoint it wrote last", async () => {
    const { running } = graphsOf(
      { before: {} },
      { before: {}, streams: [[inherited, own]], writes: "cp-7", endTasks: waitingAt("int-9") },
    );

    const { ended } = await pass();

    expect(ended).toEqual({ rests: true, last: { usage: [inherited, own] } });
    expect(running.states[0]?.config).toMatchObject({ configurable: { checkpoint_id: "cp-7" } });
  });

  it("a pass whose end checkpoint holds no execution state ends with no last state", async () => {
    graphsOf({ before: {} }, { before: {}, streams: [[inherited]], end: { not: "a state" } });

    expect(await pass().then(({ ended }) => ended)).toEqual({ rests: false, last: undefined });
  });

  it("streams the child on its own thread, as its own run, with its parent's and its root's ids", async () => {
    const { running } = graphsOf({ before: {} }, { before: {}, streams: [[inherited]] });

    const { run } = await pass();

    const config = running.stream.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(config).toMatchObject({
      streamMode: ["values", "checkpoints"],
      runName: "child-workflow",
      configurable: { thread_id: run.thread },
      metadata: {
        executionId: "child-1",
        parentExecutionId: "root-1",
        rootExecutionId: "root-1",
        workflowName: "child-workflow",
        workflowVersion: "1",
        workflowChain: '["child-workflow"]',
        tenantId: "default",
        threadId: "root-thread",
      },
      tags: expect.arrayContaining(["tenant:default"]),
    });
    expect((config.configurable as Record<string, unknown>).run).toMatchObject({
      runId: "child-1",
      tenantId: "default",
    });
  });
});

/** One claimed child through `runQueuedChild`, over a scripted graph. */
async function claimed(options: {
  readonly registry?: "none" | "no-root" | "no-child" | "known";
  readonly ownerId?: string;
  readonly contexts?: unknown;
  readonly pii?: unknown;
  readonly graphs?: Scripted[];
  readonly signal?: AbortSignal;
  readonly failWith?: Error;
}) {
  const ledger = new SeenLedger();
  const rootDeps = {
    config: { name: "root-workflow", version: "1" },
    log: { warn: vi.fn() },
    contexts: options.contexts,
    budgets: {
      budgets: [],
      applicationName: "app",
      resolve: () => {
        throw new Error("no budget handler is resolved");
      },
      ledger,
      clock: new VirtualClock(NOW),
    },
  };
  const childDeps = { config: { name: "child-workflow", version: "1" } };
  const chained = { ...childDeps, pii: options.pii, fingerprintKeys: "fingerprints" };
  const registryCalls: unknown[][] = [];
  const registry = {
    rootOf: (name: string) =>
      options.registry === "none" || options.registry === "no-root"
        ? undefined
        : { name, deps: rootDeps },
    depsOf: (name: string) =>
      options.registry === "none" || options.registry === "no-child"
        ? undefined
        : { ...childDeps, name },
    chainedDepsOf: (...args: unknown[]) => {
      registryCalls.push(args);
      return chained;
    },
    marker: "registry",
  };
  seen.parentOf.length = 0;
  seen.contextsOutside.length = 0;
  seen.tenantOf.length = 0;
  const run = {
    thread: "root-thread/child/child-1",
    threadId: "root-thread",
    input: { text: "hi" },
    parent: { workflow: { name: "root-workflow" } },
    piiPolicies: ["policy-a"],
    ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
    initial: {
      usage: [inherited],
      budgets: [BUDGET],
      contexts: { tenant: "tenant-values", execution: "execution-values" },
      child: {
        parentExecutionId: "root-1",
        rootExecutionId: "root-1",
        inheritedUsage: 1,
        itemIndex: 3,
      },
    },
  };
  seen.run = run;
  const fresh: Scripted[] = [{ before: {} }, { before: {}, streams: [[inherited]] }];
  const graphs = (options.graphs ?? fresh).map(graphOf);
  script.built.length = 0;
  script.graphs = graphs.map((each) => each.graph);
  const { failWith } = options;
  if (failWith !== undefined) graphs[1]?.stream.mockImplementation(() => Promise.reject(failWith));
  const lease = { lease: "held" };
  const signal = options.signal ?? new AbortController().signal;
  const pass = await runQueuedChild(
    { registry: registry as never, serde: "serde" as never },
    row,
    lease as never,
    signal,
  );
  return { pass, graphs, run, lease, signal, registryCalls, ledger };
}

describe("#1366: one claimed child's pass on its worker", () => {
  it("a child that is not a workflow of this application fails with its name and its root's", async () => {
    const { pass } = await claimed({ registry: "none" });

    expect(pass?.end.status).toBe(ExecutionRecordStatus.Failed);
    const failure = JSON.parse(pass?.end.failure ?? "") as { name: string; message: string };
    expect(failure).toMatchObject({
      name: "QueuedChildError",
      message: "child-workflow (of root-workflow) is not a workflow of this application",
    });
    expect(pass?.cancelled).toBeUndefined();
  });

  it("a child whose root or whose own workflow the application lacks fails the same", async () => {
    for (const registry of ["no-root", "no-child"] as const) {
      const { pass } = await claimed({ registry });

      expect(pass?.end.status).toBe(ExecutionRecordStatus.Failed);
      expect(pass?.end.failure).toContain("is not a workflow of this application");
    }
  });

  it("a cancellation before the child was claimed announces nothing as the child's", async () => {
    const abort = new AbortController();
    abort.abort();

    const { pass } = await claimed({ registry: "none", signal: abort.signal });

    expect(pass?.end.status).toBe(ExecutionRecordStatus.Failed);
    expect(pass?.cancelled).toBeUndefined();
  });

  it("a child that ran to its finish is answered, with the state it ended at and what claimed it", async () => {
    const { pass, run } = await claimed({});

    expect(pass?.end).toEqual({ status: ExecutionRecordStatus.Answered });
    expect(pass?.finished).toMatchObject({ row, run, last: { usage: [inherited] } });
    expect(pass?.finished?.deps).toMatchObject({ config: { name: "child-workflow" } });
  });

  it("a child that ended with no state is answered, and nothing is announced", async () => {
    const { pass } = await claimed({
      graphs: [{ before: {} }, { before: {}, streams: [[inherited]], end: { not: "a state" } }],
    });

    expect(pass).toEqual({ end: { status: ExecutionRecordStatus.Answered }, finished: undefined });
  });

  it("a child that stops at a pause is paused", async () => {
    const { pass } = await claimed({
      graphs: [
        { before: {} },
        { before: {}, streams: [[inherited]], endTasks: waitingAt("int-1") },
      ],
    });

    expect(pass).toEqual({ end: { status: ExecutionRecordStatus.Paused } });
  });

  it("a hand-over leaves the row running: nothing is answered", async () => {
    const stopping = new ApplicationStoppingError({ message: "the application is stopping" });

    const { pass } = await claimed({ failWith: stopping });

    expect(pass).toBeUndefined();
  });

  it("a pause of the child's tree parks it like a hand-over: nothing is answered, failed or cancelled (#1341c)", async () => {
    const paused = new ExecutionPausedError({ message: "the child's tree was paused" });
    const byError = await claimed({ failWith: paused });
    expect(byError.pass).toBeUndefined();

    // the abort of the worker's watch surfaces as whatever error the step threw: the signal's reason says why
    const abort = new AbortController();
    abort.abort(paused);
    const bySignal = await claimed({ signal: abort.signal, failWith: new Error("aborted") });
    expect(bySignal.pass).toBeUndefined();
  });

  it("a failure is the row's failure text; a cancellation is announced as the child's, with its claimed child", async () => {
    const boom = await claimed({ failWith: new Error("boom") });
    expect(boom.pass?.end.status).toBe(ExecutionRecordStatus.Failed);
    expect(JSON.parse(boom.pass?.end.failure ?? "")).toMatchObject({ message: "boom" });
    expect(boom.pass?.cancelled).toBeUndefined();

    const cancelled = new ExecutionCancelledError({ message: "the tree was cancelled" });
    const stopped = await claimed({ failWith: cancelled });
    expect(stopped.pass?.end.status).toBe(ExecutionRecordStatus.Failed);
    expect(stopped.pass?.cancelled).toMatchObject({ error: cancelled, row, run: stopped.run });
  });

  it("a cancelled signal ends the pass as a cancellation", async () => {
    const abort = new AbortController();
    abort.abort();

    const { pass } = await claimed({ signal: abort.signal, failWith: new Error("aborted") });

    expect(pass?.cancelled?.error).toBeInstanceOf(ExecutionCancelledError);
  });

  it("chains the child's PII policies by the names its launch carries, under the worker's lease", async () => {
    const { registryCalls, lease, graphs } = await claimed({
      pii: { observability: "mask", fieldKey: "key" },
    });

    expect(registryCalls).toHaveLength(1);
    expect(registryCalls[0]?.[1]).toEqual(["policy-a"]);
    const config = graphs[1]?.stream.mock.calls[0]?.[1] as {
      configurable: { run: Record<string, unknown> };
    };
    expect(config.configurable.run.lease).toBe(lease);
  });

  it("runs the child's steps in a context of its own: its ids, its worker's signal and lease, its parent rebuilt, its masks and keys", async () => {
    const { graphs, run, lease, signal } = await claimed({
      ownerId: "owner-1",
      contexts: "app-contexts",
      pii: { observability: "mask", fieldKey: "key" },
    });

    const config = graphs[1]?.stream.mock.calls[0]?.[1] as {
      signal: AbortSignal;
      configurable: { run: Record<string, unknown> };
    };
    expect(config.signal).toBe(signal);
    expect(config.configurable.run).toMatchObject({
      runId: "child-1",
      threadId: run.threadId,
      signal,
      tenantId: "default",
      input: { text: "hi" },
      ownerId: "owner-1",
      lease,
      tree: { parent: "the-parent", itemIndex: 3 },
      observability: "mask",
      correlationKey: "key",
      fingerprintKeys: "fingerprints",
    });
    expect(seen.contextsOutside).toEqual([]);
    expect(seen.tenantOf[0]).toEqual(["app-contexts", "tenant-values"]);
    expect(seen.parentOf[0]?.[0]).toBe(run.parent);
    expect(seen.parentOf[0]?.[1]).toMatchObject({
      marker: "registry",
      tenant: "the-tenant",
      values: "execution-values",
      signal,
    });
  });

  it("a child of an application with no contexts takes the contexts outside an execution, and a run with no owner has none", async () => {
    const { graphs } = await claimed({ contexts: undefined, pii: undefined });

    const config = graphs[1]?.stream.mock.calls[0]?.[1] as {
      configurable: { run: Record<string, unknown> };
    };
    expect(seen.contextsOutside).toEqual([{ name: "root-workflow", version: "1" }]);
    expect(seen.tenantOf[0]?.[0]).toBe("contexts-outside");
    expect(config.configurable.run).not.toHaveProperty("ownerId");
    expect(config.configurable.run.observability).toBeUndefined();
  });
});
