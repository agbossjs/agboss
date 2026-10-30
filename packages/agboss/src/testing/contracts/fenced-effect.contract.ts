import { registerContract } from "./define.js";
import type { FencedEffectStores } from "./fenced-effect-data.js";
import { housekeepingCases, isolationCases } from "./fenced-effect-isolation.cases.js";
import { concurrencyCases, rollbackCases } from "./fenced-effect-rollback.cases.js";
import { textCases } from "./fenced-effect-text.cases.js";
import { refusalCases, writeCases } from "./fenced-effect-write.cases.js";
import type { ContractTarget } from "./seam.js";

export type { FencedEffectBusinessRows, FencedEffectStores } from "./fenced-effect-data.js";

/**
 * `FencedEffectRepository` (#500): one protected write per key, in one transaction with the checks —
 * the lease the key names (its epoch, held, not expired), the scope's mark, the key, the write. A
 * write and its result committed together, replayed on the same key, refused for a stale token
 * before its key is read, rolled back as a whole; two calls on one key run it once (joined in one
 * instance, serialized across two); the sweep's deletion follows the `Clock`.
 */
export function fencedEffectContract<TTransaction>(
  target: ContractTarget<FencedEffectStores<TTransaction>>,
): void {
  registerContract(
    "fenced effect contract",
    target,
    [
      writeCases<TTransaction>(),
      refusalCases<TTransaction>(),
      rollbackCases<TTransaction>(),
      concurrencyCases<TTransaction>(),
      isolationCases<TTransaction>(),
      housekeepingCases<TTransaction>(),
      textCases<TTransaction>(),
    ],
    (stores) => stores.effects.ping(),
  );
}
