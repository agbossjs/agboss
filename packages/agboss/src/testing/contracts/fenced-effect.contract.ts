import { registerContract } from "./define.js";
import { optOutOf, type FencingContractOptions, type OptOut } from "./fencing-gate.js";
import { businessKeyCases } from "./fenced-effect-business.cases.js";
import type { FencedEffectStores } from "./fenced-effect-data.js";
import { expiryCases } from "./fenced-effect-expiry.cases.js";
import { fingerprintCases } from "./fenced-effect-fingerprint.cases.js";
import { keyTextCases } from "./fenced-effect-key-text.cases.js";
import { housekeepingCases, isolationCases } from "./fenced-effect-isolation.cases.js";
import { concurrencyCases, rollbackCases } from "./fenced-effect-rollback.cases.js";
import { textCases } from "./fenced-effect-text.cases.js";
import { refusalCases, writeCases } from "./fenced-effect-write.cases.js";
import { zombieCases } from "./fenced-effect-zombie.cases.js";
import type { ContractTarget } from "./seam.js";

export type { FencedEffectBusinessRows, FencedEffectStores } from "./fenced-effect-data.js";

/**
 * `FencedEffectRepository` (#500): one protected write per key, in one transaction with the checks —
 * the lease the key names (its epoch, held, not expired), the scope's mark, the key, the write. A
 * write and its result committed together, replayed on the same key, refused for a stale token
 * before its key is read, rolled back as a whole; two calls on one key run it once (joined in one
 * instance, serialized across two); the sweep's deletion follows the `Clock`; a key built by hand
 * with an invalid name refused at the entry, and a zombie's write racing the new holder's leaving
 * one business row (#526). A store that opts out of the atomic lease check
 * (`LeaseCheck.WithoutDoubleChargeProtection`) passes none of the fencing cases (#543): they fail
 * with `StoreConformanceError`, or are skipped under `acceptWithoutDoubleChargeProtection: true`,
 * and the suite then shows `gives NO double-charge protection …` as a passing case of its own.
 */
export function fencedEffectContract<TTransaction>(
  target: ContractTarget<FencedEffectStores<TTransaction>>,
  options: FencingContractOptions = {},
): void {
  registerFencedEffectContract(target, optOutOf(options, true));
}

/** The fenced-effect suite, its opt-out shown by it or (`storeConformance`) by the set's suite. */
export function registerFencedEffectContract<TTransaction>(
  target: ContractTarget<FencedEffectStores<TTransaction>>,
  optOut: OptOut,
): void {
  registerContract(
    "fenced effect contract",
    target,
    [
      writeCases<TTransaction>(),
      refusalCases<TTransaction>(),
      expiryCases<TTransaction>(),
      rollbackCases<TTransaction>(),
      concurrencyCases<TTransaction>(),
      isolationCases<TTransaction>(),
      housekeepingCases<TTransaction>(),
      textCases<TTransaction>(),
      businessKeyCases<TTransaction>(),
      fingerprintCases<TTransaction>(),
      keyTextCases<TTransaction>(),
      zombieCases<TTransaction>(),
    ],
    (stores) => stores.effects.ping(),
    { storeOf: (stores) => stores.effects, ...optOut },
  );
}
