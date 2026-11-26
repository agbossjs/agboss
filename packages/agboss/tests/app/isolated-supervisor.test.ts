/**
 * #1286b (D9): the supervisor of an instance's isolated workers only forks — one process per queued
 * `IsolatedWorker` child, never for another placement, once while it lives, again when the child is
 * queued again (resumed, or its fork died and a worker reclaimed it), capped by the instance's step
 * slots, and its stop closes every fork (then ends the ones that stay). The processes are recorders here;
 * `isolated-worker-processes.test.ts` runs real ones.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  startIsolatedSupervisor,
  type ForkHandle,
  type ForkSpec,
  type IsolatedSupervisor,
} from "../../src/app/remote/isolated-supervisor.js";
import { StepSlots } from "../../src/app/step-slots.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { ChildPlacement } from "../../src/flow/child-placement.js";
import { remoteChildSignals } from "../../src/flow/runtime/remote/remote-child-signals.js";
import { InMemoryChildExecutionQueueRepository } from "../../src/infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { SILENT_LOG } from "../../src/infrastructure/logger.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { queuedChild } from "../../src/testing/contracts/queued-child.js";
import { seconds } from "../../src/units/index.js";
import { settle } from "./fixtures/fence-takeover.js";

const isolated = { placement: ChildPlacement.IsolatedWorker } as const;

/** A fork the test ends itself (`exit()`), recording how it was asked to close. */
class RecordedFork implements ForkHandle {
  readonly exited: Promise<void>;
  readonly signals: string[] = [];
  exit: () => void = () => undefined;

  constructor(
    readonly spec: ForkSpec,
    private readonly closesOnTerminate: boolean,
  ) {
    this.exited = new Promise<void>((resolve) => {
      this.exit = resolve;
    });
  }

  terminate(): void {
    this.signals.push("terminate");
    if (this.closesOnTerminate) this.exit();
  }

  kill(): void {
    this.signals.push("kill");
    this.exit();
  }
}

interface Rig {
  readonly clock: VirtualClock;
  readonly deadline: AbortController;
  readonly queue: InMemoryChildExecutionQueueRepository;
  readonly forks: RecordedFork[];
  readonly errors: string[];
  start(options?: { readonly cap?: number; readonly closes?: boolean }): IsolatedSupervisor;
  queueChild(id: string, fields?: Parameters<typeof queuedChild>[1]): Promise<void>;
}

function rigOf(): Rig {
  const clock = new VirtualClock();
  const context = applicationContextOf({
    name: "isolated-application",
    version: "1.0.0",
    instanceId: "instance-1",
    startedAt: clock.now(),
    profiles: ["test"],
  });
  const queue = new InMemoryChildExecutionQueueRepository(clock, context, new InMemoryDatabase());
  const forks: RecordedFork[] = [];
  const errors: string[] = [];
  const deadline = new AbortController();
  return {
    clock,
    deadline,
    queue,
    forks,
    errors,
    start: ({ cap, closes = true } = {}) =>
      startIsolatedSupervisor({
        queue,
        clock,
        log: { ...SILENT_LOG, error: (code) => void errors.push(code) },
        spec: { entry: "file:///app/main.js", profile: ["economy"] },
        launch: (spec) => {
          const fork = new RecordedFork(spec, closes);
          forks.push(fork);
          return fork;
        },
        slots: cap === undefined ? undefined : new StepSlots(cap, clock),
        deadline: rig.deadline.signal,
      }),
    queueChild: async (id, fields = {}) => {
      await queue.saveIfAbsent(queuedChild(id, fields));
      remoteChildSignals.queued();
      await settle();
    },
  };
}

let rig: Rig;
let supervisor: IsolatedSupervisor | undefined;

beforeEach(() => {
  rig = rigOf();
  supervisor = undefined;
});

const stopAll = async (): Promise<void> => {
  const stopping = supervisor?.stop();
  await settle();
  rig.deadline.abort();
  await stopping;
};

describe("#1286b: the supervisor of isolated workers", () => {
  it("forks one process per queued IsolatedWorker child, with its ids and the instance's settings", async () => {
    supervisor = rig.start();
    await settle();
    await rig.queueChild("c-1", isolated);
    await rig.queueChild("c-2", isolated);

    expect(rig.forks.map((fork) => fork.spec)).toEqual([
      {
        entry: "file:///app/main.js",
        profile: ["economy"],
        tenantId: "default",
        executionId: "c-1",
      },
      {
        entry: "file:///app/main.js",
        profile: ["economy"],
        tenantId: "default",
        executionId: "c-2",
      },
    ]);
    await stopAll();
  });

  it("forks for no other placement", async () => {
    supervisor = rig.start();
    await settle();

    await rig.queueChild("any", { placement: ChildPlacement.AnyWorker });
    await rig.queueChild("other", { placement: ChildPlacement.OtherWorker });
    await rig.queueChild("bare");

    expect(rig.forks).toEqual([]);
    await stopAll();
  });

  it("forks a child that was queued before it started, at its first look", async () => {
    await rig.queueChild("c-1", isolated);

    supervisor = rig.start();
    await settle();

    expect(rig.forks.map((fork) => fork.spec.executionId)).toEqual(["c-1"]);
    await stopAll();
  });

  it("forks a child once while its process lives, however often it looks", async () => {
    supervisor = rig.start();
    await settle();
    await rig.queueChild("c-1", isolated);

    remoteChildSignals.queued();
    await settle();
    await rig.clock.advance(seconds(65));
    await settle();

    expect(rig.forks).toHaveLength(1);
    await stopAll();
  });

  it("forks a child again when it is queued again after its process ended, not before the backoff", async () => {
    supervisor = rig.start();
    await settle();
    await rig.queueChild("c-1", isolated);
    const [first] = rig.forks;
    const claimed = await rig.queue.claimIsolatedWorkerByTenantIdAndExecutionId("default", "c-1");
    await rig.queue.completeByTenantIdAndExecutionId("default", "c-1", {
      status: ExecutionRecordStatus.Paused,
    });
    expect(claimed).toBeDefined();

    // resumed: the parent queues it again with the resume, while the fork is still going down
    await rig.queue.saveIfAbsent({ ...queuedChild("c-1", isolated), run: '{"resume":{}}' });
    first?.exit();
    await settle();
    expect(rig.forks).toHaveLength(1);
    await rig.clock.advance(seconds(2));
    await settle();

    expect(rig.forks.map((fork) => fork.spec.executionId)).toEqual(["c-1", "c-1"]);
    await stopAll();
  });

  it("holds one step slot of the instance per fork: never more forks than slots", async () => {
    supervisor = rig.start({ cap: 1 });
    await settle();
    await rig.queueChild("c-1", isolated);
    await rig.queueChild("c-2", isolated);

    expect(rig.forks.map((fork) => fork.spec.executionId)).toEqual(["c-1"]);

    // the first ends (answered, so its row is gone from the queue's isolated list) and frees its slot
    await rig.queue.claimIsolatedWorkerByTenantIdAndExecutionId("default", "c-1");
    await rig.queue.completeByTenantIdAndExecutionId("default", "c-1", {
      status: ExecutionRecordStatus.Answered,
    });
    rig.forks[0]?.exit();
    await settle();

    expect(rig.forks.map((fork) => fork.spec.executionId)).toEqual(["c-1", "c-2"]);
    await stopAll();
  });

  it("does not fork a fork's slot away from a step: with no cap it forks them all", async () => {
    supervisor = rig.start();
    await settle();
    for (const id of ["a", "b", "c", "d"]) await rig.queueChild(id, isolated);

    expect(rig.forks).toHaveLength(4);
    await stopAll();
  });

  it("a launcher that fails frees its slot, is logged and is tried again later", async () => {
    const clock = rig.clock;
    let attempts = 0;
    supervisor = startIsolatedSupervisor({
      queue: rig.queue,
      clock,
      log: { ...SILENT_LOG, error: (code) => void rig.errors.push(code) },
      spec: { entry: "file:///app/main.js" },
      launch: (spec) => {
        attempts += 1;
        if (attempts === 1) throw new Error("spawn failed");
        const fork = new RecordedFork(spec, true);
        rig.forks.push(fork);
        return fork;
      },
      slots: new StepSlots(1, clock),
      deadline: rig.deadline.signal,
    });
    await settle();

    await rig.queueChild("c-1", isolated);
    expect(rig.errors).toEqual(["isolated-worker.fork-failed"]);
    expect(rig.forks).toEqual([]);
    await clock.advance(seconds(2));
    await settle();

    expect(rig.forks.map((fork) => fork.spec.executionId)).toEqual(["c-1"]);
    await stopAll();
  });

  it("its stop asks every fork to close and waits for them", async () => {
    supervisor = rig.start();
    await settle();
    await rig.queueChild("c-1", isolated);
    await rig.queueChild("c-2", isolated);

    await supervisor.stop();

    expect(rig.forks.map((fork) => fork.signals)).toEqual([["terminate"], ["terminate"]]);
  });

  it("its stop ends a fork that has not closed at the stop's deadline, and forks nothing after it", async () => {
    supervisor = rig.start({ closes: false });
    await settle();
    await rig.queueChild("c-1", isolated);

    const stopping = supervisor.stop();
    await settle();
    expect(rig.forks[0]?.signals).toEqual(["terminate"]);
    rig.deadline.abort();
    await stopping;
    await rig.queueChild("c-2", isolated);

    expect(rig.forks[0]?.signals).toEqual(["terminate", "kill"]);
    expect(rig.forks).toHaveLength(1);
  });
});
