import { expect } from "vitest";
import { InvalidBusinessKeyError } from "../../infrastructure/fenced-effect-key.js";
import { FencedEffectStatus } from "../../infrastructure/fenced-effect.repository.js";
import type { ContractCase, ContractGroup } from "./define.js";
import {
  keyOf,
  leaseOf,
  rejectionOf,
  writing,
  type FencedEffectStores,
  type WriteCount,
} from "./fenced-effect-data.js";
import { REFUSED_BUSINESS_KEYS, ROUND_TRIP_KEYS } from "./key-text-data.js";

/** One case of the contract, for a store of any transaction. */
type Case<TTransaction> = ContractCase<FencedEffectStores<TTransaction>>;

/** `#538`: every accepted key is its own row, replayed with its own result, on the other instance too. */
const ownRows = <TTransaction>(): Case<TTransaction> => ({
  name: "#538: business keys of many scripts — CJK, Cyrillic, Hebrew, emoji, astral, 200 code units — are each their own row: run once, replayed with their own result",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);
    const keyed = (businessKey: string) => ({ ...keyOf(lease), businessKey });

    for (const [index, businessKey] of ROUND_TRIP_KEYS.entries()) {
      const ran = await first.effects.saveResultIfAbsent(
        keyed(businessKey),
        writing(first.rows, `r${String(index)}`, count),
      );
      expect({ businessKey, status: ran.status }).toEqual({
        businessKey,
        status: FencedEffectStatus.Ran,
      });
    }
    for (const [index, businessKey] of ROUND_TRIP_KEYS.entries()) {
      const replayed = await second.effects.saveResultIfAbsent(
        keyed(businessKey),
        writing(second.rows, "never", count),
      );
      expect({ businessKey, outcome: replayed }).toMatchObject({
        businessKey,
        outcome: { status: FencedEffectStatus.Replayed, result: { receipt: `r${String(index)}` } },
      });
    }
    expect(count.runs).toBe(ROUND_TRIP_KEYS.length);
  },
});

/** `#538`: a key built by hand breaking a rule is refused before anything, naming the rule. */
const refusedByHand = <TTransaction>(): Case<TTransaction> => ({
  name: "#538: a key built by hand whose business key breaks a rule — length, a C1 control, a format character, a lone surrogate, NFD — is InvalidBusinessKeyError naming the rule, never the key; nothing runs",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);

    for (const [rule, businessKey] of REFUSED_BUSINESS_KEYS) {
      const refused = await rejectionOf(
        first.effects.saveResultIfAbsent(
          { ...keyOf(lease), businessKey },
          writing(first.rows, "r1", count),
        ),
      );
      expect(refused).toBeInstanceOf(InvalidBusinessKeyError);
      expect(refused).toMatchObject({ rule });
      expect((refused as Error).message).not.toContain(businessKey);
    }
    expect(count.runs).toBe(0);
    expect(await second.rows.committed()).toEqual([]);
  },
});

/** The key-text cases of the fenced-effect contract (#538). */
export const keyTextCases = <TTransaction>(): ContractGroup<FencedEffectStores<TTransaction>> => ({
  title: "the text of a business key",
  cases: [ownRows<TTransaction>(), refusedByHand<TTransaction>()],
});
