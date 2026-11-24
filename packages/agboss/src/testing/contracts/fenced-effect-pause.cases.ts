import { ExecutionError } from "../../core/error-families/run-errors.js";
import { expect } from "vitest";
import {} from "../../app/lease-lost.js";
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
 * included. An `AfterStep` pause fences nothing: the step in flight commits.
 */

type Case = ContractCase<FencedEffectTarget>;

const immediateFences = (): Case => ({
  name: "#1341c: a write at the fenced token after an Immediate pause is refused — ExecutionError.Fenced, the work not run; an AfterStep pause fences nothing",
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
    expect(refused).toBeInstanceOf(ExecutionError.Fenced);
    expect(refused).toMatchObject({ token: lease.token, observedToken: lease.token });
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

    expect(stale).toBeInstanceOf(ExecutionError.Fenced);
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

/** The pause as a fence of the fenced effect. */
export const pauseCases = (): ContractGroup<FencedEffectTarget> => ({
  title: "a tree's Immediate pause is a fence (#1341c)",
  cases: [immediateFences(), fenceOutlivesUnpause(), otherTreesUntouched()],
});
