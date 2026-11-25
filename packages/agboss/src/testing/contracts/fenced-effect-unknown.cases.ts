import { StoreError } from "../../core/error-families/store-errors.js";
import { expect } from "vitest";
import { StoreOutcomeSource } from "../../infrastructure/store-call-timeout.js";
import { IdempotencyRunStatus } from "../../infrastructure/fenced-effect.repository.js";
import type { ContractCase, ContractGroup } from "./define.js";
import {
  failing,
  keyOf,
  leaseOf,
  rejectionOf,
  writing,
  type FencedEffectTarget,
  type WriteCount,
} from "./fenced-effect-data.js";

/**
 * The fenced-effect contract's unknown outcomes (#1017): an ambiguous error injected into the
 * effect — the work throws `StoreError.OutcomeUnknown`, as a store's own transport error after the
 * send is — reaches the caller as it is (the framework's hand-over reads that class, so a store
 * must not wrap, translate or swallow it), and the effect is rolled back like any failed work.
 */

/** One case of the contract, for a store of any transaction. */
type Case = ContractCase<FencedEffectTarget>;

/** What a store package's classifier throws for a connection reset after the COMMIT was sent. */
const resetAfterSend = (): StoreError.OutcomeUnknown =>
  new StoreError.OutcomeUnknown({
    ...{ store: "ContractStore", operation: "runOnce", source: StoreOutcomeSource.Transport },
    cause: new Error("read ECONNRESET"),
  });

const unknownErrorPassesThrough = (): Case => ({
  name: "an ambiguous error thrown inside the effect is rethrown as it is, its row rolled back; the next call runs it",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const key = keyOf(await leaseOf(first));
    const ambiguous = resetAfterSend();

    const failed = await rejectionOf(
      first.effects.runOnce(key, failing(first.rows, "r1", ambiguous)),
    );
    const after = await second.rows.committed();
    const retried = await second.effects.runOnce(key, writing(second.rows, "r2", count));

    expect(failed).toBe(ambiguous);
    expect(after).toEqual([]);
    expect(retried).toMatchObject({ status: IdempotencyRunStatus.Ran, result: { receipt: "r2" } });
  },
});

export const unknownOutcomeCases = (): ContractGroup<FencedEffectTarget> => ({
  title: "unknown outcome",
  cases: [unknownErrorPassesThrough()],
});
