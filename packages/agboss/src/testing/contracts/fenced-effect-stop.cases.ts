import { ExecutionError } from "../../core/error-families/run-errors.js";
import { expect } from "vitest";
import { ExecutionCancelledError } from "../../core/errors.js";
import { ExecutionStoppedError } from "../../app/lease-stopped.js";
import {} from "../../app/lease-lost.js";
import { ExecutionStopFencedError } from "../../app/lease-stopped.js";
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
 * The stop as a fence of the fenced effect (#1341b): once a tree's `Immediate` stop is durable
 * (`ExecutionLeaseRepository.requestStop`), a new effect of the tree is refused in the transaction that
 * checks its lease — `ExecutionStopFencedError`, the work not run, nothing written, an undo's key
 * too (a stop has no undo). An `AfterStep` stop fences nothing: the step in flight commits. A stored
 * result replays. A stop that escalates a cancel never fences the cancel's own undo: with a cancel
 * marked, the cancel's rules hold.
 */

type Case = ContractCase<FencedEffectTarget>;

const immediateRefused = (): Case => ({
  name: "#1341b: a write after its tree's durable Immediate stop is refused — ExecutionStopFencedError (an ExecutionStoppedError, never a hand-over), the work not run, nothing written",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    await second.leases.requestStop(treeOf(lease), InterruptMode.Immediate);
    const count: WriteCount = { runs: 0 };

    const refused = await rejectionOf(
      first.effects.runOnce(keyOf(lease), writing(first.rows, "r1", count)),
    );

    expect(refused).toBeInstanceOf(ExecutionStopFencedError);
    expect(refused).toBeInstanceOf(ExecutionStoppedError);
    expect(refused).toBeInstanceOf(ExecutionCancelledError);
    expect(refused).not.toBeInstanceOf(ExecutionError.Fenced);
    expect(refused).toMatchObject({ code: "execution.stopped.fenced", token: lease.token });
    expect(count.runs).toBe(0);
    expect(await second.rows.committed()).toEqual([]);
  },
});

const afterStepFencesNothing = (): Case => ({
  name: "#1341b: an AfterStep stop fences nothing — the step in flight commits its effect",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    await second.leases.requestStop(treeOf(lease), InterruptMode.AfterStep);
    const count: WriteCount = { runs: 0 };

    const ran = await first.effects.runOnce(keyOf(lease), writing(first.rows, "r1", count));

    expect(ran.status).toBe(IdempotencyRunStatus.Ran);
    expect(await second.rows.committed()).toEqual(["r1"]);
  },
});

const escalationFences = (): Case => ({
  name: "#1341b: a stop escalated from AfterStep to Immediate fences from then on, and an undo's key is refused too",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    await second.leases.requestStop(treeOf(lease), InterruptMode.AfterStep);
    await second.leases.requestStop(treeOf(lease), InterruptMode.Immediate);
    const undo = effectKeyForTesting(keyOf(lease, "refund", `${lease.rootExecutionId}:undo`), {
      isCompensation: true,
    });
    const count: WriteCount = { runs: 0 };

    const refused = await rejectionOf(first.effects.runOnce(undo, writing(first.rows, "u", count)));

    expect(refused).toBeInstanceOf(ExecutionStopFencedError);
    expect(count.runs).toBe(0);
  },
});

const cancelOverridesStop = (): Case => ({
  name: "#1341b: Cancel > Stop — once the tree's cancel is marked too, its own undo writes as before and a new effect is refused as a cancel",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    await second.leases.requestStop(treeOf(lease), InterruptMode.Immediate);
    await second.leases.requestCancel(treeOf(lease));
    const undo = effectKeyForTesting(keyOf(lease, "refund", `${lease.rootExecutionId}:undo`), {
      isCompensation: true,
    });
    const count: WriteCount = { runs: 0 };

    const ran = await first.effects.runOnce(undo, writing(first.rows, "refund", count));
    const refused = await rejectionOf(
      first.effects.runOnce(keyOf(lease), writing(first.rows, "r1", count)),
    );

    expect(ran.status).toBe(IdempotencyRunStatus.Ran);
    expect(refused).toMatchObject({ code: "execution.cancelled.fenced" });
    expect(await second.rows.committed()).toEqual(["refund"]);
  },
});

const storedBeforeReplays = (): Case => ({
  name: "#1341b: an effect stored before an Immediate stop replays after it, while a new effect of the tree is refused",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    const count: WriteCount = { runs: 0 };
    await first.effects.runOnce(keyOf(lease), writing(first.rows, "step", count));
    await second.leases.requestStop(treeOf(lease), InterruptMode.Immediate);

    const again = await second.effects.runOnce(keyOf(lease), writing(second.rows, "x", count));
    const other = await rejectionOf(
      second.effects.runOnce(keyOf(lease, "other"), writing(second.rows, "z", count)),
    );

    expect(again.status).toBe(IdempotencyRunStatus.Replayed);
    expect(other).toBeInstanceOf(ExecutionStopFencedError);
  },
});

const otherTreesUntouched = (): Case => ({
  name: "#1341b: a stop of another tree, or of another tenant's tree of the same id, refuses nothing",
  isFencing: true,
  run: async ({ first, second }) => {
    const mine = await leaseOf(first, "execution-1");
    await second.leases.requestStop(
      { tenantId: "default", rootExecutionId: "execution-2" },
      InterruptMode.Immediate,
    );
    await second.leases.requestStop(
      { tenantId: "other", rootExecutionId: "execution-1" },
      InterruptMode.Immediate,
    );
    const count: WriteCount = { runs: 0 };

    const own = await first.effects.runOnce(keyOf(mine), writing(first.rows, "mine", count));

    expect(own.status).toBe(IdempotencyRunStatus.Ran);
  },
});

/** The stop as a fence of the fenced effect. */
export const stopCases = (): ContractGroup<FencedEffectTarget> => ({
  title: "a tree's Immediate stop is a fence (#1341b)",
  cases: [
    immediateRefused(),
    afterStepFencesNothing(),
    escalationFences(),
    cancelOverridesStop(),
    storedBeforeReplays(),
    otherTreesUntouched(),
  ],
});
