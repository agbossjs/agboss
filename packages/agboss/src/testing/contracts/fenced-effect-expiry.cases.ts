import { expect } from "vitest";
import { ExecutionFencedError } from "../../app/lease-lost.js";
import { FencedEffectStatus } from "../../infrastructure/fenced-effect.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase, ContractGroup } from "./define.js";
import { EXPIRY_EDGE_OFFSET, EXPIRY_EDGES, ExpiryEdge } from "./execution-lease-expiry.cases.js";
import {
  keyOf,
  leaseOf,
  rejectionOf,
  writing,
  type FencedEffectStores,
  type WriteCount,
} from "./fenced-effect-data.js";

/**
 * A fenced write by the lease's own holder at `edge`, nobody having taken the lease: 1 ms before
 * the expiry it runs; at the expiry and after it the lease is over for its holder too (#534) — the
 * write is refused (`ExecutionFencedError`, nothing run, nothing stored) and the key stays unseen
 * for the next holder.
 */
const writeAt = <TTransaction>(
  edge: ExpiryEdge,
): ContractCase<FencedEffectStores<TTransaction>> => {
  const isRun = edge === ExpiryEdge.Before;
  return {
    name: `#534: a fenced write ${edge}, the lease not taken meanwhile, ${isRun ? "runs" : "is refused: nothing run, the key left for the next holder"}`,
    run: async ({ clock, first, second }) => {
      const count: WriteCount = { runs: 0 };
      const lease = await leaseOf(first, "execution-1", seconds(30));
      await clock.advance(EXPIRY_EDGE_OFFSET[edge]);

      const outcome = first.effects.saveResultIfAbsent(
        keyOf(lease),
        writing(first.rows, "r1", count),
      );

      if (isRun) {
        expect(await outcome).toMatchObject({ status: FencedEffectStatus.Ran, token: 1 });
        expect(await second.rows.committed()).toEqual(["r1"]);
        return;
      }
      const refused = await rejectionOf(outcome);
      expect(refused).toBeInstanceOf(ExecutionFencedError);
      expect(refused).toMatchObject({ token: 1 });
      expect(count.runs).toBe(0);
      expect(await second.rows.committed()).toEqual([]);
      const next = await leaseOf(second, "execution-1", seconds(30));
      const ran = await second.effects.saveResultIfAbsent(
        keyOf(next),
        writing(second.rows, "r2", count),
      );
      expect(ran).toMatchObject({ status: FencedEffectStatus.Ran, token: 2 });
    },
  };
};

/** When the first write of the replay cases runs: 2 ms before the lease's expiry. */
const FIRST_WRITE_AT = seconds(29.998);

/**
 * A key written 2 ms before the expiry, asked again by the same holder at `edge`: 1 ms before the
 * expiry it is `Replayed` (the stored result, `work` not run); at the expiry and after it the lease
 * is over (#534) and the fence is checked before the key is read — refused, never replayed to a
 * holder that no longer holds the lease.
 */
const replayAt = <TTransaction>(
  edge: ExpiryEdge,
): ContractCase<FencedEffectStores<TTransaction>> => {
  const isReplayed = edge === ExpiryEdge.Before;
  return {
    name: `#534: a written key asked again by its holder ${edge} is ${isReplayed ? "Replayed" : "refused before the key is read: no replay past the lease"}`,
    run: async ({ clock, first }) => {
      const count: WriteCount = { runs: 0 };
      const lease = await leaseOf(first, "execution-1", seconds(30));
      await clock.advance(FIRST_WRITE_AT);
      await first.effects.saveResultIfAbsent(keyOf(lease), writing(first.rows, "r1", count));
      await clock.advance(seconds((EXPIRY_EDGE_OFFSET[edge] - FIRST_WRITE_AT) / 1000));

      const again = first.effects.saveResultIfAbsent(
        keyOf(lease),
        writing(first.rows, "r2", count),
      );

      if (isReplayed)
        expect(await again).toMatchObject({
          status: FencedEffectStatus.Replayed,
          result: { receipt: "r1" },
        });
      else expect(await rejectionOf(again)).toBeInstanceOf(ExecutionFencedError);
      expect(count.runs).toBe(1);
    },
  };
};

/** A fenced write against the lease's boundary (#534): 1 ms before, exactly at, 1 ms after. */
export const expiryCases = <TTransaction>(): ContractGroup<FencedEffectStores<TTransaction>> => ({
  title: "the lease's expiry",
  isFencing: true,
  cases: [
    ...EXPIRY_EDGES.map((edge) => writeAt<TTransaction>(edge)),
    ...EXPIRY_EDGES.map((edge) => replayAt<TTransaction>(edge)),
  ],
});
