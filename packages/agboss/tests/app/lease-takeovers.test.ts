/**
 * #501 PR 1 — which takes of a tree's lease are takeovers (`reportTake`), what a takeover's record
 * holds, and that recording one never throws: a mask, a store or an observer that fails is a
 * warning. Units over the in-memory stores and a virtual clock.
 */
import { describe, expect, it } from "vitest";
import { executionLeasesOf } from "../../src/app/execution-leases.js";
import { recordTakeover } from "../../src/app/lease-events.js";
import {
  reacquiredOf,
  reportTake,
  rootTakeOf,
  type LeaseEventLog,
  type LeaseTake,
  type RootThreadConfig,
} from "../../src/app/execution-leases.js";
import { ExecutionObserverManager } from "../../src/core/observer-manager.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import type { ExecutionLeaseTakeoverEvent } from "../../src/flow/observers/lease-events.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
} from "../../src/infrastructure/execution-lease.repository.js";
import {
  ExecutionLeaseEventKind,
  InMemoryExecutionLeaseEventRepository,
  LeaseTakeoverReason,
} from "../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { recordingLog } from "../helpers/log.js";

const LEASE: ExecutionLease = {
  tenantId: "acme",
  rootExecutionId: "root-1",
  holderInstanceId: "instance-2",
  leaseEpoch: 2,
  expiresAt: new Date("2026-01-05T09:00:30.000Z"),
  remaining: seconds(30),
};

const TAKEN_OVER: ExecutionLease = {
  ...LEASE,
  takenOverFrom: { holderInstanceId: "instance-1", leaseEpoch: 1 },
};

/** A lease log in memory: its rows, what its observer heard, its warnings. */
function leaseLog(overrides: Partial<LeaseEventLog> = {}) {
  const database = new InMemoryDatabase();
  const heard: ExecutionLeaseTakeoverEvent[] = [];
  const { log, entries } = recordingLog();
  const events: LeaseEventLog = {
    repository: new InMemoryExecutionLeaseEventRepository(database),
    observer: new ExecutionObserverManager([
      {
        onExecutionLeaseTakeover: (event: ExecutionLeaseTakeoverEvent) => {
          heard.push(event);
        },
      },
    ]),
    mask: (event) => Promise.resolve(event),
    log,
    clock: new VirtualClock(),
    recording: import("../../src/app/lease-events.js"),
    ...overrides,
  };
  return { events, heard, entries, rows: database.executionLeaseEvents };
}

describe("#501: which takes are takeovers", () => {
  it("a take whose store names the previous holder is reported, whatever the site", async () => {
    const { events, heard, rows } = leaseLog();

    await reportTake(events, TAKEN_OVER, { reason: LeaseTakeoverReason.Resumed });

    expect(heard).toEqual([
      {
        tenantId: "acme",
        rootExecutionId: "root-1",
        leaseExecutionId: "root-1",
        scopeKey: "acme:root-1",
        token: 2,
        holderInstanceId: "instance-2",
        previousHolderInstanceId: "instance-1",
        previousToken: 1,
        reason: LeaseTakeoverReason.Resumed,
      },
    ]);
    expect(rows).toEqual([
      {
        kind: ExecutionLeaseEventKind.Takeover,
        occurredAt: "2026-01-05T09:00:00.000Z",
        tenantId: "acme",
        rootExecutionId: "root-1",
        executionId: "root-1",
        scopeKey: "acme:root-1",
        token: 2,
        holderInstanceId: "instance-2",
        reason: LeaseTakeoverReason.Resumed,
        previousHolderInstanceId: "instance-1",
        previousToken: 1,
      },
    ]);
  });

  it("a takeover site's take is reported without a previous holder", async () => {
    const { events, heard } = leaseLog();

    await reportTake(events, LEASE, { reason: LeaseTakeoverReason.Recovered, isTakeover: true });

    expect(heard).toHaveLength(1);
    expect(heard[0]).not.toHaveProperty("previousHolderInstanceId");
  });

  it("a free lease taken by an ordinary site is not reported", async () => {
    const { events, heard, rows } = leaseLog();

    await reportTake(events, LEASE, { reason: LeaseTakeoverReason.Resumed });

    expect(heard).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("a take without a reason (a lease taken outside an application) is never reported", async () => {
    const { events, heard } = leaseLog();

    await reportTake(events, TAKEN_OVER, undefined);

    expect(heard).toEqual([]);
  });

  it("a holder without a lease log reports nothing", async () => {
    await expect(
      reportTake(undefined, TAKEN_OVER, { reason: LeaseTakeoverReason.Recovered }),
    ).resolves.toBeUndefined();
  });

  it("a remote child's take names its tree's root; its own execution is the lease's", async () => {
    const { events, heard } = leaseLog();
    const take: LeaseTake = {
      reason: LeaseTakeoverReason.RemoteChild,
      isTakeover: true,
      rootExecutionId: "root-0",
    };

    await reportTake(events, LEASE, take);

    expect(heard[0]).toMatchObject({ rootExecutionId: "root-0", leaseExecutionId: "root-1" });
  });

  it("the head checkpoint is read only for a reported take; one that cannot be read is left out", async () => {
    const { events, heard } = leaseLog();
    const reads: string[] = [];
    const read = (id: string | Error) => () => {
      reads.push(String(id));
      return id instanceof Error ? Promise.reject(id) : Promise.resolve(id);
    };

    await reportTake(events, LEASE, {
      reason: LeaseTakeoverReason.Resumed,
      checkpointIdOf: read("not-read"),
    });
    await reportTake(events, TAKEN_OVER, {
      reason: LeaseTakeoverReason.Resumed,
      checkpointIdOf: read("checkpoint-9"),
    });
    await reportTake(events, TAKEN_OVER, {
      reason: LeaseTakeoverReason.Resumed,
      checkpointIdOf: read(new Error("the checkpointer is down")),
    });

    expect(reads).toEqual(["checkpoint-9", "Error: the checkpointer is down"]);
    expect(heard.map((event) => event.checkpointId)).toEqual(["checkpoint-9", undefined]);
    expect(heard[1]).not.toHaveProperty("checkpointId");
  });

  it("a re-acquire is a takeover of the same tree as the first take", () => {
    const first: LeaseTake = { reason: LeaseTakeoverReason.RemoteChild, rootExecutionId: "root-0" };

    expect(reacquiredOf(undefined)).toEqual({
      reason: LeaseTakeoverReason.Reacquired,
      isTakeover: true,
    });
    expect(reacquiredOf(first)).toEqual({
      reason: LeaseTakeoverReason.Reacquired,
      isTakeover: true,
      rootExecutionId: "root-0",
    });
  });

  it("a root's take reads the head checkpoint of the root's own thread, when there is a checkpointer", async () => {
    const threads: unknown[] = [];
    const checkpointer = {
      getTuple: (config: RootThreadConfig) => {
        threads.push(config);
        return Promise.resolve(
          threads.length === 1 ? { checkpoint: { id: "checkpoint-3" } } : undefined,
        );
      },
    };
    const checkpoints = { checkpointer };

    const take = rootTakeOf(checkpoints, "root-1", LeaseTakeoverReason.Cancelled, true);
    const none = rootTakeOf(undefined, "root-1", LeaseTakeoverReason.Resumed);

    expect(take).toMatchObject({ reason: LeaseTakeoverReason.Cancelled, isTakeover: true });
    expect(await take.checkpointIdOf?.()).toBe("checkpoint-3");
    expect(await take.checkpointIdOf?.()).toBeUndefined();
    expect(threads).toEqual([
      { configurable: { thread_id: "root-1" } },
      { configurable: { thread_id: "root-1" } },
    ]);
    expect(none).toEqual({ reason: LeaseTakeoverReason.Resumed, isTakeover: false });
  });
});

describe("#501: recording a takeover never throws", () => {
  const event: ExecutionLeaseTakeoverEvent = {
    tenantId: "acme",
    rootExecutionId: "root-1",
    leaseExecutionId: "root-1",
    scopeKey: "acme:root-1",
    token: 2,
    holderInstanceId: "instance-2",
    reason: LeaseTakeoverReason.Recovered,
  };

  it("a mask that fails: a warning, nothing written, nothing told", async () => {
    const { events, heard, rows, entries } = leaseLog({
      mask: () => Promise.reject(new Error("the mask failed")),
    });

    await expect(recordTakeover(events, event)).resolves.toBeUndefined();

    expect(rows).toEqual([]);
    expect(heard).toEqual([]);
    expect(entries).toEqual([
      {
        level: "warn",
        code: "lease-event.failed",
        message: "the takeover of execution root-1 could not be recorded: Error: the mask failed",
      },
    ]);
  });

  it("the mask is what the row and the observers see", async () => {
    const { events, heard, rows } = leaseLog({
      mask: (shown) => Promise.resolve({ ...(shown as object), tenantId: "<masked>" }),
    });

    await recordTakeover(events, event);

    expect(heard[0]?.tenantId).toBe("<masked>");
    expect(rows[0]?.tenantId).toBe("<masked>");
  });
});

describe("#501: a waiting hold that takes an expired lease reports it", () => {
  it("a resume waiting while the holder froze takes its lease over: Resumed, naming the frozen holder", async () => {
    const clock = new VirtualClock();
    const database = new InMemoryDatabase();
    const instanceOf = (instanceId: string) =>
      applicationContextOf({
        name: "lease-test-application",
        version: "1.0.0",
        instanceId,
        startedAt: clock.now(),
        environmentName: "test",
        environment: NO_ENVIRONMENT_VALUES,
      });
    const first = new InMemoryExecutionLeaseRepository(clock, instanceOf("instance-1"), database);
    const second = new InMemoryExecutionLeaseRepository(clock, instanceOf("instance-2"), database);
    const { events, heard } = leaseLog({ clock });
    const tree = { tenantId: "default", rootExecutionId: "root-1" };
    // the first holder's background renewals never reach a store: it froze
    const frozen = await first.acquire("default", "root-1", seconds(30));

    const waiting = executionLeasesOf(second, clock, { events }).hold(tree, undefined, {
      reason: LeaseTakeoverReason.Resumed,
    });
    await clock.advance(seconds(31));
    const held = await waiting;

    expect(frozen?.leaseEpoch).toBe(1);
    expect(heard).toEqual([
      expect.objectContaining({
        reason: LeaseTakeoverReason.Resumed,
        token: 2,
        holderInstanceId: "instance-2",
        previousHolderInstanceId: "instance-1",
        previousToken: 1,
      }),
    ]);
    await held.release();
  });
});
