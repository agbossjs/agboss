import { FaultInvariant } from "../invariants/violations.js";
import { FaultStoreSabotage } from "../pod-protocol.js";
import type { FaultSabotage } from "./sabotages.js";
import { FaultScenarioSkippedError } from "../scenario.js";
import { lostChargeAnswer, needsLink } from "./s23-commit-answer-reset.js";

/**
 * The sabotage of #1017 (S3), run on every store set: the classifier off — a transport error after
 * the send read as a definite failure. The charge's COMMIT is applied and its answer lost; the
 * fenced-effect store reports an ordinary error, the step (no retries) fails and the reservation is
 * undone for a charge the store holds. The case passes only when `no-undo-on-hand-over` fails. On a store set whose commit is retried
 * (`resolvesCommitByRetry`) one reset is no unknown outcome: it is skipped, and 23b's sabotage bites.
 */
export const s23ResetAsDefinite: FaultSabotage = {
  id: "s23-sabotage-reset-as-definite",
  title:
    "23 (S3), sabotaged: a connection reset after the charge's COMMIT taken for a definite failure — the step fails and the reservation is undone",
  violates: FaultInvariant.NoUndoOnHandOver,
  evidence: /^o-23s \(\S+\) did not fail, yet its reservation was undone/u,
  run: async (cluster) => {
    const a = await cluster.pod("a", {
      isBounded: true,
      sabotage: FaultStoreSabotage.ResetAsDefinite,
    });
    // one reset is answered by the retry on a store whose commit is retried: nothing for the
    // classifier to read; its truly unknown commit is 23b's sabotage
    if (a.resolvesCommitByRetry)
      throw new FaultScenarioSkippedError("the store set's commit is retried: see 23b (S3)");
    const { key } = await lostChargeAnswer(
      cluster,
      "o-23s",
      FaultStoreSabotage.ResetAsDefinite,
      1,
      a,
    );
    await cluster.ended(key);
    return a;
  },
};

/**
 * The same sabotage on a store whose client retries a commit (`resolvesCommitByRetry`), where the
 * retry's answer is lost too (23b): the outcome is truly unknown, the classifier off reads it as a
 * definite failure and the reservation is undone for a charge the store holds. Other store sets
 * skip it: their sabotage is `s23ResetAsDefinite`.
 */
export const s23bResetAsDefinite: FaultSabotage = {
  id: "s23b-sabotage-reset-as-definite",
  title:
    "23b (S3), sabotaged: the answers of a COMMIT and of its retry lost, taken for a definite failure — the step fails and the reservation is undone",
  violates: FaultInvariant.NoUndoOnHandOver,
  evidence: /^o-23bs \(\S+\) did not fail, yet its reservation was undone/u,
  run: async (cluster) => {
    const a = await cluster.pod("a", {
      isBounded: true,
      sabotage: FaultStoreSabotage.ResetAsDefinite,
    });
    if (!a.resolvesCommitByRetry)
      throw new FaultScenarioSkippedError("the store set's commit is not retried: see 23 (S3)");
    needsLink(cluster, a);
    const { key } = await lostChargeAnswer(
      cluster,
      "o-23bs",
      FaultStoreSabotage.ResetAsDefinite,
      2,
      a,
    );
    await cluster.ended(key);
    return a;
  },
};
