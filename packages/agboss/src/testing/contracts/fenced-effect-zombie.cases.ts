import { expect } from "vitest";
import { ExecutionFencedError } from "../../app/lease-lost.js";
import { InvalidFencedEffectNameError } from "../../infrastructure/fenced-effect-key.js";
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
import { ROUNDS } from "./outbound-call-race.cases.js";

/**
 * The fenced-effect contract's key built by hand and its zombie (#526): an invalid name is refused
 * at the store's entry before anything is read or written (AC7, as the outbound-call contract
 * refuses one); and the double charge itself — a write of a lease's holder racing that lease's
 * release, the next take and the new holder's write of the same key — leaves one business row,
 * round after round: a lease check outside the write's transaction (check, then write) fails it.
 */

/** One case of the contract, for a store of any transaction. */
type Case<TTransaction> = ContractCase<FencedEffectStores<TTransaction>>;

/** Names a store must refuse: a ':', empty, above 100, a '.' first. */
const BAD_NAMES = ["charge:twice", "", "x".repeat(101), ".charge"];

const badNameRefused = <TTransaction>(): Case<TTransaction> => ({
  name: "#508, #526 AC7: a key built by hand with an invalid name (a ':', empty, above 100, a '.' first) is refused — InvalidFencedEffectNameError, the write not run, nothing written, before the fence",
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    const count: WriteCount = { runs: 0 };
    for (const name of BAD_NAMES) {
      const valid = { ...keyOf(lease), name };
      const stale = { ...valid, token: lease.leaseEpoch + 7 };
      for (const key of [valid, stale])
        expect(
          await rejectionOf(
            first.effects.saveResultIfAbsent(key, writing(first.rows, name, count)),
          ),
        ).toBeInstanceOf(InvalidFencedEffectNameError);
    }

    expect(count.runs).toBe(0);
    expect(await second.rows.committed()).toEqual([]);
    const ran = await second.effects.saveResultIfAbsent(
      keyOf(lease),
      writing(second.rows, "r1", count),
    );
    expect(ran).toMatchObject({ status: FencedEffectStatus.Ran, token: lease.leaseEpoch });
  },
});

/** What a call came to: its outcome, or what it rejected with. */
const settled = <T>(call: Promise<T>): Promise<T | { readonly rejected: unknown }> =>
  call.then(
    (outcome) => outcome,
    (rejected: unknown) => ({ rejected }),
  );

const zombieRacingNewHolder = <TTransaction>(): Case<TTransaction> => ({
  name: "#526 AC3: a write racing its lease's release, the next take and the new holder's write of the same key, round after round: one business row — the old holder's before the take, or it is refused",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    for (let round = 0; round < ROUNDS; round += 1) {
      const executionId = `execution-${String(round)}`;
      const lease = await leaseOf(first, executionId);
      const handOver = async () => {
        await first.leases.release(lease);
        const taken = await leaseOf(second, executionId);
        const key = keyOf(taken);
        return second.effects.saveResultIfAbsent(
          key,
          writing(second.rows, `holder-${String(round)}`, count),
        );
      };

      const late = first.effects.saveResultIfAbsent(
        keyOf(lease),
        writing(first.rows, `zombie-${String(round)}`, count),
      );
      const [old, holder] = await Promise.all([settled(late), handOver()]);

      const rows = (await second.rows.committed()).filter((row) =>
        row.endsWith(`-${String(round)}`),
      );
      expect(rows).toHaveLength(1);
      if ("rejected" in old) {
        expect(old.rejected).toBeInstanceOf(ExecutionFencedError);
        expect(rows).toEqual([`holder-${String(round)}`]);
        expect(holder).toMatchObject({
          status: FencedEffectStatus.Ran,
          token: lease.leaseEpoch + 1,
        });
      } else {
        expect(rows).toEqual([`zombie-${String(round)}`]);
        expect(holder).toMatchObject({
          status: FencedEffectStatus.Replayed,
          token: lease.leaseEpoch,
        });
      }
    }
  },
});

/** The key built by hand and the zombie. */
export const zombieCases = <TTransaction>(): ContractGroup<FencedEffectStores<TTransaction>> => ({
  title: "a key built by hand, a zombie",
  cases: [badNameRefused<TTransaction>(), zombieRacingNewHolder<TTransaction>()],
});
