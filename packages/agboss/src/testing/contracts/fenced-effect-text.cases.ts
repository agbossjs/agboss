import { expect } from "vitest";
import {
  FencedEffectStatus,
  type FencedEffectWork,
} from "../../infrastructure/fenced-effect.repository.js";
import type { ContractGroup } from "./define.js";
import {
  keyOf,
  leaseOf,
  type FencedEffectBusinessRows,
  type FencedEffectStores,
} from "./fenced-effect-data.js";
import { nulCaseName, NUL_TEXT } from "./nul-text.js";

/** The fenced-effect contract's texts (#521 AC4): a result comes back as the write gave it. */

/** A result whose texts hold a NUL character. */
interface NulReceipt {
  readonly receipt: string;
  readonly lines: readonly string[];
}

const RESULT: NulReceipt = { receipt: NUL_TEXT, lines: [NUL_TEXT] };

/** A write that inserts the row `r1` and gives `RESULT`. */
const writingNul =
  <TTransaction>(
    rows: FencedEffectBusinessRows<TTransaction>,
  ): FencedEffectWork<TTransaction, NulReceipt> =>
  (transaction) => {
    const inserted = rows.insert(transaction, "r1");
    return inserted === undefined ? RESULT : inserted.then(() => RESULT);
  };

/** The texts of a result: as the write gave them, and replayed the same. */
export const textCases = <TTransaction>(): ContractGroup<FencedEffectStores<TTransaction>> => ({
  title: "texts as they were handed over",
  cases: [
    {
      name: nulCaseName("a result"),
      run: async ({ first, second }) => {
        const key = keyOf(await leaseOf(first));

        const ran = await first.effects.saveResultIfAbsent(key, writingNul(first.rows));
        const replayed = await second.effects.saveResultIfAbsent(key, writingNul(second.rows));

        expect(ran).toEqual({ status: FencedEffectStatus.Ran, result: RESULT, token: 1 });
        expect(replayed).toEqual({ status: FencedEffectStatus.Replayed, result: RESULT, token: 1 });
      },
    },
  ],
});
