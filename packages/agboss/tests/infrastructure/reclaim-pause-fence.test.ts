/**
 * agbossjs/agboss#1341 (money review 2026-11-25, finding 1): a root that waits on remote children
 * yields its lease; an operator's `Immediate` pause lands from another instance; the holder then
 * reclaims its lease at `token + 1`. Before the fix the reclaimed token was above the fence
 * (`fencedThroughToken` = the yielded token): the root's `runOnce` on it and every child's write
 * committed while the tree was paused — up to one renewal (7.5 s) of charges. Now the reclaim
 * inherits the fence in its own atomic step, so both writes are refused, on the in-memory stores and
 * on a SQLite file shared by two connections (the instances). A cancel or stop mark fences by the
 * row, whatever the token, so a reclaim under one is refused as well (the cancel's undo still runs).
 */
import { describe, expect, it } from "vitest";
import { ExecutionCancelFencedError } from "../../src/app/lease-lost.js";
import { InterruptMode } from "../../src/app/interrupt-types.js";
import {
  ExecutionPauseFencedError,
  ExecutionStopFencedError,
} from "../../src/app/lease-stopped.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import type { FencedEffectRepository } from "../../src/infrastructure/fenced-effect.repository.js";
import { IdempotencyRunStatus } from "../../src/infrastructure/fenced-effect.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryFencedEffectRepository } from "../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { SqliteExecutionLeaseRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteFencedEffectRepository } from "../../src/infrastructure/sqlite/sqlite-fenced-effect.repository.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import { keyOf, rejectionOf, treeOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours } from "../../src/units/index.js";
import { storeClockOf } from "../helpers/store-clock.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

interface Instance {
  readonly leases: ExecutionLeaseRepository;
  readonly effects: FencedEffectRepository;
}

const contextOf = (instanceId: string) =>
  applicationContextOf({
    name: "reclaim-fence-application",
    version: "1.0.0",
    instanceId,
    startedAt: new Date(0),
    environmentName: "test",
    environment: NO_ENVIRONMENT_VALUES,
  });

/** Two instances over one in-memory database (one test's instances share it). */
function inMemoryPair(): readonly [Instance, Instance] {
  const database = new InMemoryDatabase();
  const clock = storeClockOf(new VirtualClock());
  const on = (instanceId: string): Instance => {
    const leases = new InMemoryExecutionLeaseRepository(clock, contextOf(instanceId), database);
    return { leases, effects: new InMemoryFencedEffectRepository(clock, database, leases) };
  };
  return [on("instance-1"), on("instance-2")];
}

/** Two instances, each on its own connection to one SQLite file. */
function sqlitePair(): readonly [Instance, Instance] {
  const path = temporarySqlitePath();
  const on = (instanceId: string): Instance => {
    const connection = connectionTo(path);
    const clock = storeClockOf(new VirtualClock());
    return {
      leases: new SqliteExecutionLeaseRepository(connection, clock, contextOf(instanceId)),
      effects: new SqliteFencedEffectRepository(connection, clock),
    };
  };
  return [on("instance-1"), on("instance-2")];
}

const charge = () => ({ receipt: "charged" });

async function takenOn(leases: ExecutionLeaseRepository, id: string): Promise<ExecutionLease> {
  const lease = await leases.acquire("default", id, hours(1));
  if (lease === undefined) throw new Error(`the lease of ${id} must be free`);
  return lease;
}

async function reclaimedOn(
  leases: ExecutionLeaseRepository,
  held: ExecutionLease,
): Promise<ExecutionLease> {
  const lease = await leases.reclaim(held, hours(1));
  if (lease === undefined) throw new Error("the holder's yielded lease must be reclaimed");
  return lease;
}

/** The root `root-1` yielded while it waits for its child `child-1`, whose lease is its own. */
async function waitingTree(holder: Instance) {
  const root = await takenOn(holder.leases, "root-1");
  const child = await takenOn(holder.leases, "child-1");
  await holder.leases.yield(root);
  const childKey = effectKeyForTesting(keyOf(child, "child-charge"), {
    rootExecutionId: "root-1",
  });
  return { root, childKey };
}

describe.each([
  ["in-memory", inMemoryPair],
  ["SQLite (two connections to one file)", sqlitePair],
] as const)("agbossjs/agboss#1341: a reclaim under a set mark stays fenced — %s", (_, pair) => {
  it("an Immediate pause from another instance while the root is yielded: the reclaimed token inherits the fence — the root's charge and the child's are refused", async () => {
    const [holder, operator] = pair();
    const { root, childKey } = await waitingTree(holder);
    await operator.leases.requestPause(treeOf(root), { mode: InterruptMode.Immediate });

    const reclaimed = await reclaimedOn(holder.leases, root);
    const ofRoot = await rejectionOf(holder.effects.runOnce(keyOf(reclaimed), charge));
    const ofChild = await rejectionOf(holder.effects.runOnce(childKey, charge));

    expect(reclaimed.token).toBe(root.token + 1);
    expect(await operator.leases.pauseOf(treeOf(root))).toEqual({
      pause: { mode: InterruptMode.Immediate },
      fencedThroughToken: reclaimed.token,
    });
    expect(ofRoot).toBeInstanceOf(ExecutionPauseFencedError);
    expect(ofRoot).toMatchObject({ token: reclaimed.token, rootExecutionId: "root-1" });
    expect(ofChild).toBeInstanceOf(ExecutionPauseFencedError);
    expect(ofChild).toMatchObject({ rootExecutionId: "root-1", leaseExecutionId: "child-1" });
  });

  it("an AfterStep pause raises no fence on a reclaim, and a reclaim after unpause writes: only the pause in force fences", async () => {
    const [holder, operator] = pair();
    const { root, childKey } = await waitingTree(holder);
    await operator.leases.requestPause(treeOf(root), { mode: InterruptMode.AfterStep });
    const underAfterStep = await reclaimedOn(holder.leases, root);
    const ran = await holder.effects.runOnce(keyOf(underAfterStep, "a"), charge);

    await holder.leases.yield(underAfterStep);
    await operator.leases.requestPause(treeOf(root), { mode: InterruptMode.Immediate });
    await operator.leases.unpause(treeOf(root));
    const afterUnpause = await reclaimedOn(holder.leases, underAfterStep);
    const ofRoot = await holder.effects.runOnce(keyOf(afterUnpause, "b"), charge);
    const ofChild = await holder.effects.runOnce(childKey, charge);

    expect(ran.status).toBe(IdempotencyRunStatus.Ran);
    expect(ofRoot.status).toBe(IdempotencyRunStatus.Ran);
    expect(ofChild.status).toBe(IdempotencyRunStatus.Ran);
    expect((await operator.leases.pauseOf(treeOf(root))).fencedThroughToken).toBe(
      underAfterStep.token,
    );
  });

  it("a cancel or an Immediate stop while the root is yielded: the reclaimed token is refused by the row's mark — the cancel's undo still runs", async () => {
    const [holder, operator] = pair();
    const { root, childKey } = await waitingTree(holder);
    await operator.leases.requestCancel(treeOf(root));
    const reclaimed = await reclaimedOn(holder.leases, root);
    const undo = effectKeyForTesting(keyOf(reclaimed, "refund", "root-1:undo"), {
      isCompensation: true,
    });

    const cancelled = await rejectionOf(holder.effects.runOnce(keyOf(reclaimed), charge));
    const ofChild = await rejectionOf(holder.effects.runOnce(childKey, charge));
    const undone = await holder.effects.runOnce(undo, charge);

    expect(cancelled).toBeInstanceOf(ExecutionCancelFencedError);
    expect(ofChild).toBeInstanceOf(ExecutionCancelFencedError);
    expect(undone.status).toBe(IdempotencyRunStatus.Ran);

    const [stopHolder, stopper] = pair();
    const stopped = await waitingTree(stopHolder);
    await stopper.leases.requestStop(treeOf(stopped.root), InterruptMode.Immediate);
    const afterStop = await reclaimedOn(stopHolder.leases, stopped.root);

    expect(await rejectionOf(stopHolder.effects.runOnce(keyOf(afterStop), charge))).toBeInstanceOf(
      ExecutionStopFencedError,
    );
    expect(await rejectionOf(stopHolder.effects.runOnce(stopped.childKey, charge))).toBeInstanceOf(
      ExecutionStopFencedError,
    );
  });
});
