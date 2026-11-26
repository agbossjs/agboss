/**
 * #1356 — the spend a queued child already has in the ledger when it is continued after a pause
 * (`resumedSpendOf`): its flow's usage, the spend of each open agent loop and the usage of the replies
 * being given — nothing of a pause no one answers now, nothing of another tenant's tree.
 */
import { seenOf } from "../../src/infrastructure/pause-seen.js";
import { MemorySaver, emptyCheckpoint, type StateSnapshot } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import type { AppDeps } from "../../src/app/app-deps.js";
import { RandomIdGenerator } from "../../src/infrastructure/clock.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { pauseFor } from "../../src/app/parts.js";
import { interruptIdsOf, resumedSpendOf } from "../../src/app/remote/queued-child-spend.js";
import { recordToolCost, type UsageRecord } from "../../src/finops/usage.js";
import type { ExecutionGraph } from "../../src/flow/runtime/build.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import type { QueuedChildExecution } from "../../src/infrastructure/child-execution-queue.repository.js";
import {
  ExecutionRecordStatus,
  InMemoryExecutionRecordRepository,
} from "../../src/infrastructure/execution-record.repository.js";
import { NO_RECIPIENTS, PauseResolution } from "../../src/infrastructure/pause-record.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";

const spend = (tool: string, cost: number): UsageRecord => recordToolCost(tool, cost);

/** A snapshot of the child's thread with `tasks`, the fields nothing here reads left empty. */
const snapshotOf = (tasks: StateSnapshot["tasks"]): StateSnapshot => ({
  values: {},
  next: [],
  config: { configurable: { thread_id: "child-thread", checkpoint_ns: "" } },
  metadata: undefined,
  createdAt: undefined,
  parentConfig: undefined,
  tasks,
});

const waitingTask = (
  id: string,
  interrupts: readonly { id?: string; value: unknown }[],
): StateSnapshot["tasks"][number] => ({
  id,
  name: "agent",
  path: ["__pregel_pull", "agent"],
  interrupts: [...interrupts],
});

describe("#1356: the interrupts a child waits at", () => {
  it("lists the id of every interrupt of every task, and none of an interrupt without one", () => {
    const before = snapshotOf([
      waitingTask("t1", [{ id: "i1", value: 1 }, { value: 2 }, { id: "i2", value: 3 }]),
      waitingTask("t2", []),
      waitingTask("t3", [{ id: "i3", value: 4 }]),
    ]);

    expect(interruptIdsOf(before)).toEqual(["i1", "i2", "i3"]);
    expect(interruptIdsOf(snapshotOf([]))).toEqual([]);
  });
});

const TENANT = "default";
const ROOT = "run-1";
const THREAD = "child-thread";
const row: QueuedChildExecution = {
  tenantId: TENANT,
  executionId: "child-1",
  rootExecutionId: ROOT,
  parentExecutionId: ROOT,
  rootWorkflow: "root-workflow",
  workflow: "child-workflow",
  depth: 2,
  status: ExecutionRecordStatus.Paused,
  run: "{}",
  queuedAt: new Date("2026-11-20T10:00:00.000Z"),
};

/** The graph as `pausedLoopsOf` reads it: its pending tasks, its checkpoints in `saver`. */
function graphOf(tasks: StateSnapshot["tasks"], saver: MemorySaver): ExecutionGraph {
  const fake = {
    checkpointer: saver,
    getState: () => Promise.resolve(snapshotOf(tasks)),
  };
  const isGraph = (value: object): value is ExecutionGraph => value === fake;
  if (!isGraph(fake)) throw new Error("unreachable");
  return fake;
}

/** What `resumedSpendOf` reads of the application's deps: the pause seam. */
const depsOf = (
  pauses: InMemoryPausedExecutionRepository,
  checkpointer: MemorySaver,
): Pick<AppDeps, "pause"> => ({
  pause: pauseFor(
    checkpointer,
    pauses,
    new InMemoryExecutionRecordRepository(new VirtualClock(), new RandomIdGenerator()),
  ),
});

describe("#1356: the spend a continued child already has", () => {
  it("is the flow's usage as it is when the application keeps no pauses", async () => {
    const flow = [spend("a", 1)];
    const saver = new MemorySaver();

    const result = await resumedSpendOf(graphOf([], saver), {}, row, THREAD, flow, {});

    expect(result).toBe(flow);
  });

  it("adds the open loops' spend and the usage of the replies being given, and nothing else", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const saver = new MemorySaver();
    const flow = [spend("flow", 1)];
    const [handed, loopA, loopB] = [spend("handed", 2), spend("loop-a", 3), spend("loop-b", 4)];
    const [replyA, replyLate, replyOther, replyUnasked] = [
      spend("reply-a", 5),
      spend("reply-late", 6),
      spend("reply-other-tenant", 7),
      spend("reply-not-answering", 8),
    ];
    // the loop of the first interrupt: what it added to the usage it was handed
    await saver.put(
      { configurable: { thread_id: THREAD, checkpoint_ns: "agent:t1" } },
      {
        ...emptyCheckpoint(),
        id: "c-1",
        channel_values: { usage: [handed, loopA, loopB], from: { usage: 1 } },
        channel_versions: { usage: 1, from: 1 },
      },
      { source: "loop", step: 0, parents: {} },
    );
    // a loop whose pause was withdrawn, and is among the answers of this pass: it still waits there
    const [handed2, loopC] = [spend("handed-2", 9), spend("loop-c", 10)];
    await saver.put(
      { configurable: { thread_id: THREAD, checkpoint_ns: "agent:t2" } },
      {
        ...emptyCheckpoint(),
        id: "c-2",
        channel_values: { usage: [handed2, loopC], from: { usage: 1 } },
        channel_versions: { usage: 1, from: 1 },
      },
      { source: "loop", step: 0, parents: {} },
    );
    await pauses.findOrCreateByStepKey(pauseOf("p-withdrawn", "run-1:agent:5:call-5"));
    await pauses.cancelByTenantIdAndPauseId(
      TENANT,
      "p-withdrawn",
      PauseResolution.Withdrawn,
      new Date(),
      NO_RECIPIENTS,
    );
    // answered at once by its channel: taken, and still waited at until this pass takes it
    const answered = pauseOf("p-answered", "run-1:agent:1:call-1");
    await pauses.findOrCreateByStepKey(answered);
    await pauses.decideByTenantIdAndPauseId(
      TENANT,
      "p-answered",
      { decision: { approved: true }, actor: undefined, usage: [replyA] },
      new Date(),
      seenOf(answered),
    );
    // answered by a person, being taken now: its reply's usage counts, once
    const replied = pauseOf("p-replied", "run-1:agent:2:call-2");
    await pauses.findOrCreateByStepKey(replied);
    await pauses.resolveByTenantIdAndPauseId(
      TENANT,
      "p-replied",
      { decision: { approved: true }, actor: { id: "manager" }, usage: [replyLate] },
      new Date(),
      NO_RECIPIENTS,
    );
    // pending, no answer yet: nothing to add
    await pauses.findOrCreateByStepKey(pauseOf("p-pending", "run-1:agent:3:call-3"));
    // not among the answers of this pass
    const unasked = pauseOf("p-unasked", "run-1:agent:4:call-4");
    await pauses.findOrCreateByStepKey(unasked);
    await pauses.decideByTenantIdAndPauseId(
      TENANT,
      "p-unasked",
      { decision: { approved: true }, actor: undefined, usage: [replyUnasked] },
      new Date(),
      seenOf(unasked),
    );
    // another tenant's tree with the same pause id
    const foreign = { ...pauseOf("p-answered", "run-1:agent:1:call-1"), tenantId: "other" };
    await pauses.findOrCreateByStepKey(foreign);
    await pauses.decideByTenantIdAndPauseId(
      "other",
      "p-answered",
      { decision: { approved: true }, actor: undefined, usage: [replyOther] },
      new Date(),
      seenOf(foreign),
    );
    const graph = graphOf(
      [
        waitingTask("t1", [{ id: "i1", value: { pauseId: "p-answered" } }]),
        waitingTask("t2", [{ id: "i4", value: { pauseId: "p-withdrawn" } }]),
      ],
      saver,
    );

    const result = await resumedSpendOf(graph, depsOf(pauses, saver), row, THREAD, flow, {
      i1: "p-answered",
      i2: "p-replied",
      i3: "p-pending",
      i4: "p-withdrawn",
    });

    expect(result).toEqual([...flow, loopA, loopB, loopC, replyA, replyLate]);
  });
});
