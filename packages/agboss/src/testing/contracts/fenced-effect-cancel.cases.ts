import { ExecutionError } from "../../core/error-families/run-errors.js";
import { expect } from "vitest";
import { isExecutionCancelled } from "../../core/execution-cancelled.js";
import { IdempotencyRunStatus } from "../../infrastructure/fenced-effect.repository.js";
import type { ContractCase, ContractGroup } from "./define.js";
import { effectKeyForTesting } from "./effect-key.js";
import {
  businessKeyOf,
  keyOf,
  leaseOf,
  rejectionOf,
  treeOf,
  writing,
  type FencedEffectTarget,
  type WriteCount,
} from "./fenced-effect-data.js";

/**
 * The cancel as a fence of the fenced effect (#909): once a tree's cancel request is durable
 * (`ExecutionLeaseRepository.requestCancel`), a new effect of the tree is refused in the transaction
 * that checks its lease — `ExecutionError.CancelFenced`, the work not run, nothing written. Not
 * refused: a result stored before (it replays), an undo's key (`isCompensation`), another tree's or
 * tenant's effect; a stale token is still `ExecutionError.Fenced`, the hand-over. A cancel asked
 * while a write's transaction is open lands after it, or the write is refused — never the write
 * landing after the cancel answered.
 */

/** One case of the contract, for a store of any transaction. */
type Case = ContractCase<FencedEffectTarget>;

const writeRefused = (): Case => ({
  name: "#909 AC1: a write after its tree's durable cancel is refused — ExecutionError.CancelFenced (a cancel, never a hand-over), the work not run, nothing written",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    await second.leases.requestCancel(treeOf(lease));
    const count: WriteCount = { runs: 0 };

    const refused = await rejectionOf(
      first.effects.runOnce(keyOf(lease), writing(first.rows, "r1", count)),
    );

    expect(refused).toBeInstanceOf(ExecutionError.CancelFenced);
    expect(isExecutionCancelled(refused)).toBe(true);
    expect(refused).not.toBeInstanceOf(ExecutionError.Fenced);
    expect(refused).toMatchObject({
      code: "execution.cancelled.fenced",
      tenantId: "default",
      rootExecutionId: "execution-1",
      leaseExecutionId: "execution-1",
      token: lease.token,
      effect: "charge",
    });
    expect(count.runs).toBe(0);
    expect(await second.rows.committed()).toEqual([]);
  },
});

const storedBeforeReplays = (): Case => ({
  name: "#909 AC1: an effect stored before the cancel replays after it — by its step and by its business key — while a new effect of the tree is refused",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    const count: WriteCount = { runs: 0 };
    await first.effects.runOnce(keyOf(lease), writing(first.rows, "step", count));
    await first.effects.runOnce(businessKeyOf(lease), writing(first.rows, "business", count));
    await second.leases.requestCancel(treeOf(lease));

    const byStep = await second.effects.runOnce(keyOf(lease), writing(second.rows, "x", count));
    const byBusinessKey = await second.effects.runOnce(
      businessKeyOf(lease),
      writing(second.rows, "y", count),
    );
    const another = await rejectionOf(
      second.effects.runOnce(keyOf(lease, "other"), writing(second.rows, "z", count)),
    );

    expect(byStep).toMatchObject({
      status: IdempotencyRunStatus.Replayed,
      result: { receipt: "step" },
    });
    expect(byBusinessKey).toMatchObject({
      status: IdempotencyRunStatus.Replayed,
      result: { receipt: "business" },
    });
    expect(another).toBeInstanceOf(ExecutionError.CancelFenced);
    expect(count.runs).toBe(2);
    expect([...(await second.rows.committed())].sort()).toEqual(["business", "step"]);
  },
});

const undoPasses = (): Case => ({
  name: "#909: an undo's key (isCompensation) writes after the cancel — the cancel's own unwinding refunds through it — and replays",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    await second.leases.requestCancel(treeOf(lease));
    const undo = effectKeyForTesting(
      keyOf(lease, "refund", `${lease.rootExecutionId}:charge-action:1:compensation`),
      { isCompensation: true },
    );
    const count: WriteCount = { runs: 0 };

    const ran = await first.effects.runOnce(undo, writing(first.rows, "refund", count));
    const again = await first.effects.runOnce(undo, writing(first.rows, "refund-2", count));

    expect(ran).toMatchObject({ status: IdempotencyRunStatus.Ran, token: lease.token });
    expect(again).toMatchObject({ status: IdempotencyRunStatus.Replayed });
    expect(await second.rows.committed()).toEqual(["refund"]);
  },
});

const otherTreesUntouched = (): Case => ({
  name: "#909: a cancel of another tree, or of another tenant's tree of the same id, refuses nothing",
  isFencing: true,
  run: async ({ first, second }) => {
    const mine = await leaseOf(first, "execution-1");
    const acme = await leaseOf(first, "execution-1", undefined, "acme");
    await second.leases.requestCancel({ tenantId: "default", rootExecutionId: "execution-2" });
    await second.leases.requestCancel({ tenantId: "other", rootExecutionId: "execution-1" });
    const count: WriteCount = { runs: 0 };

    const own = await first.effects.runOnce(keyOf(mine), writing(first.rows, "mine", count));
    const theirs = await first.effects.runOnce(keyOf(acme), writing(first.rows, "acme", count));

    expect(own.status).toBe(IdempotencyRunStatus.Ran);
    expect(theirs.status).toBe(IdempotencyRunStatus.Ran);
    expect(count.runs).toBe(2);
  },
});

/** The cancel as a fence of the fenced effect. */
export const cancelCases = (): ContractGroup<FencedEffectTarget> => ({
  title: "a tree's cancel is a fence (#909)",
  cases: [writeRefused(), storedBeforeReplays(), undoPasses(), otherTreesUntouched()],
});
