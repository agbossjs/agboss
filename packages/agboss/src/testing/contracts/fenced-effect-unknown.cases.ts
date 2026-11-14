import { expect } from "vitest";
import {
  StoreOutcomeSource,
  StoreOutcomeUnknownError,
} from "../../infrastructure/store-call-timeout.js";
import { FencedEffectStatus } from "../../infrastructure/fenced-effect.repository.js";
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
 * effect — the work throws `StoreOutcomeUnknownError`, as a store's own transport error after the
 * send is — reaches the caller as it is (the framework's hand-over reads that class, so a store
 * must not wrap, translate or swallow it), and the effect is rolled back like any failed work.
 */

/** One case of the contract, for a store of any transaction. */
type Case<TTransaction> = ContractCase<FencedEffectTarget<TTransaction>>;

/** What a store package's classifier throws for a connection reset after the COMMIT was sent. */
const resetAfterSend = (): StoreOutcomeUnknownError =>
  new StoreOutcomeUnknownError({
    ...{ store: "ContractStore", operation: "runOnce", source: StoreOutcomeSource.Transport },
    cause: new Error("read ECONNRESET"),
  });

const unknownErrorPassesThrough = <TTransaction>(): Case<TTransaction> => ({
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
    expect(retried).toMatchObject({ status: FencedEffectStatus.Ran, result: { receipt: "r2" } });
  },
});

export const unknownOutcomeCases = <TTransaction>(): ContractGroup<
  FencedEffectTarget<TTransaction>
> => ({
  title: "unknown outcome",
  cases: [unknownErrorPassesThrough<TTransaction>()],
});
