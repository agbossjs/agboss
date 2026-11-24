import { IdempotencyError } from "../../core/error-families/effect-errors.js";
import { effectKeyForTesting } from "./effect-key.js";
import { expect } from "vitest";
import { IdempotencyRunStatus } from "../../infrastructure/fenced-effect.repository.js";
import type { ContractCase, ContractGroup } from "./define.js";
import {
  keyOf,
  leaseOf,
  rejectionOf,
  writing,
  type FencedEffectTarget,
  type WriteCount,
} from "./fenced-effect-data.js";
import { REFUSED_BUSINESS_KEYS, ROUND_TRIP_KEYS } from "./key-text-data.js";

/** One case of the contract, for a store of any transaction. */
type Case = ContractCase<FencedEffectTarget>;

/** `#538`: every accepted key is its own row, replayed with its own result, on the other instance too. */
const ownRows = (): Case => ({
  name: "#538: business keys of many scripts — CJK, Cyrillic, Hebrew, emoji, astral, 200 code units — are each their own row: run once, replayed with their own result",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);
    // #825: a fenced effect under a business key says what it does — here: the same, by its key
    const keyed = (businessKey: string) =>
      effectKeyForTesting(keyOf(lease), { businessKey, withoutFingerprint: true });

    for (const [index, businessKey] of ROUND_TRIP_KEYS.entries()) {
      const ran = await first.effects.runOnce(
        keyed(businessKey),
        writing(first.rows, `r${String(index)}`, count),
      );
      expect({ businessKey, status: ran.status }).toEqual({
        businessKey,
        status: IdempotencyRunStatus.Ran,
      });
    }
    for (const [index, businessKey] of ROUND_TRIP_KEYS.entries()) {
      const replayed = await second.effects.runOnce(
        keyed(businessKey),
        writing(second.rows, "never", count),
      );
      expect({ businessKey, outcome: replayed }).toMatchObject({
        businessKey,
        outcome: {
          status: IdempotencyRunStatus.Replayed,
          result: { receipt: `r${String(index)}` },
        },
      });
    }
    expect(count.runs).toBe(ROUND_TRIP_KEYS.length);
  },
});

/** `#538`: a key built by hand breaking a rule is refused before anything, naming the rule. */
const refusedByHand = (): Case => ({
  name: "#538: a key built by hand whose business key breaks a rule — length, a C1 control, a format character, a lone surrogate, NFD — is IdempotencyError.InvalidKey naming the rule, never the key; nothing runs",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);

    for (const [rule, businessKey] of REFUSED_BUSINESS_KEYS) {
      const refused = await rejectionOf(
        first.effects.runOnce(
          effectKeyForTesting(keyOf(lease), { businessKey, fingerprint: "f" }),
          writing(first.rows, "r1", count),
        ),
      );
      expect(refused).toBeInstanceOf(IdempotencyError.InvalidKey);
      expect(refused).toMatchObject({ rule });
      expect((refused as Error).message).not.toContain(businessKey);
    }
    expect(count.runs).toBe(0);
    expect(await second.rows.committed()).toEqual([]);
  },
});

/** The key-text cases of the fenced-effect contract (#538). */
export const keyTextCases = (): ContractGroup<FencedEffectTarget> => ({
  title: "the text of a business key",
  cases: [ownRows(), refusedByHand()],
});
