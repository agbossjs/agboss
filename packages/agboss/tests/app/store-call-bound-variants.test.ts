/**
 * #928 AC1 — more of what a step calls under its lease and hands over at the trust's end when the
 * store never answers: a tree's key (`saveIfAbsentInTree`) and a pause's `findOrCreateByStepKey`
 * (the next pass finds the pause the first one created: same id, no second question).
 */
import { describe, expect, it } from "vitest";
import { leaseScope } from "../../src/app/lease-scope.js";
import { ExecutionLeaseLostError, StoreCallTimeoutError } from "../../src/index.js";
import { ExecutionTreeRepository } from "../../src/infrastructure/execution-tree.repository.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { seconds } from "../../src/units/index.js";
import { boundedOver, heldLease, outcomeOf, silent } from "./fixtures/bound-stubs.js";

const cases = [
  ["a tree key saved in a step", ExecutionTreeRepository, "saveIfAbsentInTree"],
  ["a pause found or created in a step", PausedExecutionRepository, "findOrCreateByStepKey"],
] as const;

describe("#928 AC1: a call under a lease the store never answers hands over", () => {
  for (const [what, contract, method] of cases) {
    it(`${what} (${method}) hands over at the trust's end, not at 15 s`, async () => {
      const { store, clock, reported } = boundedOver(contract, { [method]: () => silent() });
      const { lease, abandoned } = heldLease(seconds(25));
      const call = leaseScope(lease, async () =>
        Reflect.apply(Reflect.get(store, method), store, []),
      );
      const outcome = outcomeOf(call);

      await clock.advance(seconds(24));
      expect(abandoned).toEqual([]);
      await clock.advance(seconds(1));
      const error = await outcome;

      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(error).toMatchObject({ cause: expect.any(StoreCallTimeoutError) });
      expect(abandoned).toHaveLength(1);
      expect(reported.warned).toEqual(["store.call-timeout"]);
    });
  }
});
