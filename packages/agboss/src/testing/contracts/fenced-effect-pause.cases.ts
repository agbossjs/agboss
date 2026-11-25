import { ExecutionPauseFencedError } from "../../app/lease-stopped.js";
import { expect } from "vitest";
import { InterruptMode } from "../../app/interrupt-types.js";
import { IdempotencyRunStatus } from "../../infrastructure/fenced-effect.repository.js";
import type { ContractCase, ContractGroup } from "./define.js";
import { effectKeyForTesting } from "./effect-key.js";
import {
  keyOf,
  leaseOf,
  rejectionOf,
  treeOf,
  writing,
  type FencedEffectTarget,
  type WriteCount,
} from "./fenced-effect-data.js";

/**
 * The pause's fence on the fenced effect (#1341c): once an `Immediate` pause is durable
 * (`ExecutionLeaseRepository.requestPause`), a write of the tree's root lease at the token it fenced
 * or below is refused — `ExecutionError.Fenced`, the hand-over of a stale holder: the work not run,
 * nothing written — an undo's key too, whatever a cancel marked after it; the fence outlives
 * `unpause`. A write at a higher token (the lease taken again, `token + 1`) runs, its cancel's undo
 * included — but not one at a token `reclaim`ed while the pause is set: that token inherits the fence. An `AfterStep` pause fences nothing: the step in flight commits.
 */

type Case = ContractCase<FencedEffectTarget>;

const immediateFences = (): Case => ({
  name: "#1341c: a write at the fenced token after an Immediate pause is refused — ExecutionPauseFencedError, the work not run; an AfterStep pause fences nothing",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    const count: WriteCount = { runs: 0 };
    await second.leases.requestPause(treeOf(lease), { mode: InterruptMode.AfterStep });
    const ran = await first.effects.runOnce(keyOf(lease, "a"), writing(first.rows, "a", count));

    await second.leases.requestPause(treeOf(lease), { mode: InterruptMode.Immediate });
    const refused = await rejectionOf(
      first.effects.runOnce(keyOf(lease, "b"), writing(first.rows, "b", count)),
    );

    expect(ran.status).toBe(IdempotencyRunStatus.Ran);
    expect(refused).toBeInstanceOf(ExecutionPauseFencedError);
    expect(refused).toMatchObject({ token: lease.token, rootExecutionId: lease.rootExecutionId });
    expect(count.runs).toBe(1);
    expect(await second.rows.committed()).toEqual(["a"]);
  },
});

const fenceOutlivesUnpause = (): Case => ({
  name: "#1341c: the fence outlives unpause — the stale token stays refused, an undo's key too — while the lease taken again at token + 1 writes, and so does its cancel's undo",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    const count: WriteCount = { runs: 0 };
    await second.leases.requestPause(treeOf(lease), { mode: InterruptMode.Immediate });
    await second.leases.unpause(treeOf(lease));
    await second.leases.requestCancel(treeOf(lease));
    const staleUndo = effectKeyForTesting(keyOf(lease, "refund", `${lease.rootExecutionId}:undo`), {
      isCompensation: true,
    });

    const stale = await rejectionOf(
      first.effects.runOnce(staleUndo, writing(first.rows, "stale", count)),
    );
    await first.leases.release(lease);
    const next = await first.leases.acquire("default", lease.rootExecutionId, lease.remaining);
    if (next === undefined) throw new Error("a released lease must be taken again");
    const undo = effectKeyForTesting(keyOf(next, "refund", `${next.rootExecutionId}:undo`), {
      isCompensation: true,
    });
    const ran = await first.effects.runOnce(undo, writing(first.rows, "refund", count));

    expect(stale).toBeInstanceOf(ExecutionPauseFencedError);
    expect(ran.status).toBe(IdempotencyRunStatus.Ran);
    expect(await second.rows.committed()).toEqual(["refund"]);
  },
});

const otherTreesUntouched = (): Case => ({
  name: "#1341c: a pause of another tree, or of another tenant's tree of the same id, fences nothing of this one",
  isFencing: true,
  run: async ({ first, second }) => {
    const mine = await leaseOf(first, "execution-1");
    await second.leases.requestPause(
      { tenantId: "default", rootExecutionId: "execution-2" },
      { mode: InterruptMode.Immediate },
    );
    await second.leases.requestPause(
      { tenantId: "other", rootExecutionId: "execution-1" },
      { mode: InterruptMode.Immediate },
    );
    const count: WriteCount = { runs: 0 };

    const own = await first.effects.runOnce(keyOf(mine), writing(first.rows, "mine", count));

    expect(own.status).toBe(IdempotencyRunStatus.Ran);
  },
});

const childrenAreFenced = (): Case => ({
  name: "#1341c: an Immediate pause fences the tree's children — a write of a child lease (its own token) is refused while the root's current token is the fenced one, and runs once the root's lease is taken again at token + 1; an AfterStep pause fences no child, and another tree's child is not fenced",
  isFencing: true,
  run: async ({ first, second }) => {
    const root = await leaseOf(first, "root-1");
    const child = await leaseOf(first, "child-1");
    const key = (rootExecutionId: string, name: string) =>
      effectKeyForTesting(keyOf(child, name), { rootExecutionId });
    const count: WriteCount = { runs: 0 };
    await second.leases.requestPause(treeOf(root), { mode: InterruptMode.AfterStep });
    const afterStep = await first.effects.runOnce(
      key("root-1", "a"),
      writing(first.rows, "a", count),
    );

    await second.leases.requestPause(treeOf(root), { mode: InterruptMode.Immediate });
    const refused = await rejectionOf(
      first.effects.runOnce(key("root-1", "b"), writing(first.rows, "b", count)),
    );
    const ofAnotherRoot = await first.effects.runOnce(
      key("root-2", "c"),
      writing(first.rows, "c", count),
    );
    await first.leases.release(root);
    const next = await first.leases.acquire("default", "root-1", root.remaining);
    if (next === undefined) throw new Error("a released lease must be taken again");
    const afterUnpause = await first.effects.runOnce(
      key("root-1", "d"),
      writing(first.rows, "d", count),
    );

    expect(afterStep.status).toBe(IdempotencyRunStatus.Ran);
    expect(refused).toBeInstanceOf(ExecutionPauseFencedError);
    expect(refused).toMatchObject({ rootExecutionId: "root-1", leaseExecutionId: "child-1" });
    expect(ofAnotherRoot.status).toBe(IdempotencyRunStatus.Ran);
    expect(afterUnpause.status).toBe(IdempotencyRunStatus.Ran);
    expect(await second.rows.committed()).toEqual(["a", "c", "d"]);
  },
});

const reclaimInheritsFence = (): Case => ({
  name: "#1341c: a reclaim under an Immediate pause hands out no token above the fence — the root's write on the reclaimed token and a child's write are both refused; a reclaim after unpause writes",
  isFencing: true,
  run: async ({ first, second }) => {
    const root = await leaseOf(first, "root-1");
    const child = await leaseOf(first, "child-1");
    const childKey = (name: string) =>
      effectKeyForTesting(keyOf(child, name), { rootExecutionId: "root-1" });
    const count: WriteCount = { runs: 0 };
    // the root waits for a remote child: its lease yielded, then paused from another instance
    await first.leases.yield(root);
    await second.leases.requestPause(treeOf(root), { mode: InterruptMode.Immediate });

    const reclaimed = await first.leases.reclaim(root, root.remaining);
    if (reclaimed === undefined) throw new Error("the holder's yielded lease must be reclaimed");
    const ofRoot = await rejectionOf(
      first.effects.runOnce(keyOf(reclaimed, "charge"), writing(first.rows, "charge", count)),
    );
    const ofChild = await rejectionOf(
      first.effects.runOnce(childKey("child-charge"), writing(first.rows, "child-charge", count)),
    );
    await second.leases.unpause(treeOf(root));
    await first.leases.yield(reclaimed);
    const lifted = await first.leases.reclaim(reclaimed, root.remaining);
    if (lifted === undefined) throw new Error("the holder's yielded lease must be reclaimed");
    const afterUnpause = await first.effects.runOnce(
      keyOf(lifted, "after"),
      writing(first.rows, "after", count),
    );

    expect(reclaimed.token).toBe(root.token + 1);
    expect(ofRoot).toBeInstanceOf(ExecutionPauseFencedError);
    expect(ofRoot).toMatchObject({ token: reclaimed.token, rootExecutionId: "root-1" });
    expect(ofChild).toBeInstanceOf(ExecutionPauseFencedError);
    expect(ofChild).toMatchObject({ rootExecutionId: "root-1", leaseExecutionId: "child-1" });
    expect(afterUnpause.status).toBe(IdempotencyRunStatus.Ran);
    expect(count.runs).toBe(1);
    expect(await second.rows.committed()).toEqual(["after"]);
  },
});

/** The pause as a fence of the fenced effect. */
export const pauseCases = (): ContractGroup<FencedEffectTarget> => ({
  title: "a tree's Immediate pause is a fence (#1341c)",
  cases: [
    immediateFences(),
    fenceOutlivesUnpause(),
    childrenAreFenced(),
    reclaimInheritsFence(),
    otherTreesUntouched(),
  ],
});
