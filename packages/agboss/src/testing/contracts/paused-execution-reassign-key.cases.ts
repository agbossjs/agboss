import { expect } from "vitest";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { Instances } from "./paused-execution-reassign-data.js";
import { reassign } from "./paused-execution-reassign-data.js";
import { pauseOf } from "./paused-execution-data.js";

/**
 * #946: a step key is no chain by itself — an ordinary step's key may end in `~r1` (a tool call id a
 * model chose), and a reassignment cuts a suffix off only the key of a replacement: two unrelated
 * steps are never linked, an ordinary pause's key is never read as another step's chain.
 */
export const REASSIGN_KEY_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "an ordinary step key ending in ~r1 is no chain: its replacement is ~r1~r1, the step `k` is not linked to it, and a replacement of a replacement cuts one suffix",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.findOrCreateByStepKey(pauseOf("pause-k", "run-1:s:1:k"));
      await first.findOrCreateByStepKey(pauseOf("pause-odd", "run-1:s:1:k~r1"));

      const ofOdd = await reassign(second, "pause-odd", "pause-odd-2");
      const ofK = await reassign(second, "pause-k", "pause-k-2");
      const ofReplacement = await reassign(first, "pause-odd-2", "pause-odd-3");

      expect(ofOdd).toMatchObject({ stepKey: "run-1:s:1:k~r1~r1", reassignedFrom: "pause-odd" });
      // `k~r1` is an ordinary pause's key: taken, so the replacement of `k` is the next free one
      expect(ofK).toMatchObject({ stepKey: "run-1:s:1:k~r2", reassignedFrom: "pause-k" });
      expect(ofReplacement).toMatchObject({ stepKey: "run-1:s:1:k~r1~r2" });
      // the ordinary pause is found by its own key, never by its sibling's
      expect(
        await second.findByTenantIdAndRootExecutionIdAndStepKey(
          "default",
          "run-1",
          "run-1:s:1:k~r1",
        ),
      ).toMatchObject({ pauseId: "pause-odd", reassignedTo: "pause-odd-2" });
    },
  },
];
