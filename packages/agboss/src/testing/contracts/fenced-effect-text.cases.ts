import { expect } from "vitest";
import {
  IdempotencyRunStatus,
  type FencedEffectWork,
} from "../../infrastructure/fenced-effect.repository.js";
import type { ContractGroup } from "./define.js";
import {
  keyOf,
  leaseOf,
  type FencedEffectBusinessRows,
  type FencedEffectTarget,
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
  (rows: FencedEffectBusinessRows): FencedEffectWork<NulReceipt> =>
  () => {
    const inserted = rows.insert("r1");
    return inserted === undefined ? RESULT : inserted.then(() => RESULT);
  };

/** The texts of a result: as the write gave them, and replayed the same. */
export const textCases = (): ContractGroup<FencedEffectTarget> => ({
  title: "texts as they were handed over",
  cases: [
    {
      name: nulCaseName("a result"),
      run: async ({ first, second }) => {
        const key = keyOf(await leaseOf(first));

        const ran = await first.effects.runOnce(key, writingNul(first.rows));
        const replayed = await second.effects.runOnce(key, writingNul(second.rows));

        expect(ran).toEqual({ status: IdempotencyRunStatus.Ran, result: RESULT, token: 1 });
        expect(replayed).toEqual({
          status: IdempotencyRunStatus.Replayed,
          result: RESULT,
          token: 1,
        });
      },
    },
  ],
});
