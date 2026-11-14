import { FaultInvariant } from "../invariants/violations.js";
import { FaultStoreSabotage } from "../pod-protocol.js";
import type { FaultSabotage } from "./sabotages.js";
import { lostChargeAnswer } from "./s23-commit-answer-reset.js";

/**
 * The sabotage of #1017 (S3), run on every store set: the classifier off — a transport error after
 * the send read as a definite failure. The charge's COMMIT is applied and its answer lost; the
 * fenced-effect store reports an ordinary error, the step (no retries) fails and the reservation is
 * undone for a charge the store holds. The case passes only when `no-undo-on-hand-over` fails.
 */
export const s23ResetAsDefinite: FaultSabotage = {
  id: "s23-sabotage-reset-as-definite",
  title:
    "23 (S3), sabotaged: a connection reset after the charge's COMMIT taken for a definite failure — the step fails and the reservation is undone",
  violates: FaultInvariant.NoUndoOnHandOver,
  evidence: /^o-23s \(\S+\) did not fail, yet its reservation was undone/u,
  run: async (cluster) => {
    const { a, key } = await lostChargeAnswer(cluster, "o-23s", FaultStoreSabotage.ResetAsDefinite);
    await cluster.ended(key);
    return a;
  },
};
