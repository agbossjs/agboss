/**
 * `@agboss/core/stores` (#890): what a store outside the core (`@agboss/postgres`,
 * `@agboss/mongodb`, `@agboss/redis`, your own) is written with — the infrastructure contracts it
 * extends, the record types their members name, the row shapes at the store's boundary that an
 * application never reads, and the core's own helpers for the rules every store keeps the same: a
 * fenced effect's key, the replay and conflict rule, where an intent's row is, the ledger's saves
 * and prunes, a lease's time left, the class a refusal of minted ids names.
 *
 * An application lists a store class in `@Application({ providers })` and reads the root entry
 * only: the contracts and their records are there too (a `deps` token, an `extends` of a store of
 * its own), the helpers and rows are not. A store needs no other entry but `/units` (durations,
 * amounts) and `@agboss/core/testing/contracts` (its suites). Importing it has no side effects
 * beyond the root's.
 */
import "../polyfills/symbol-metadata.js";

export * from "./contract-types.js";

// the rows at an outbound-call store's boundary (#505): an intent, its claim, its lease
export { OutboundCallLeaseState } from "../infrastructure/execution-audit-log.repository.js";
export type {
  OutboundCallClaim,
  OutboundCallIntent,
  OutboundCallLease,
  OutboundCallPage,
  OutboundCallState,
  OutboundCallStatusQuery,
  OutboundCallStep,
} from "../infrastructure/outbound-call.repository.js";
// the in-memory fenced-effect store's transaction (a subclass of it, a test of a store's set)
export { InMemoryFencedEffectTransaction } from "../infrastructure/in-memory-fenced-effect.repository.js";

// the rules of a key a store keeps with the core's own helpers (#526 AC5): the name rule, the
// business key's text (#538), the fingerprint (#825), the replay and conflict rule, where its row
// is, the record of an outbound call's intent
export {
  assertBusinessKey,
  assertEffectName,
  effectKeyIdentityOf,
  fingerprintErrorOf,
  isKeyFingerprint,
  pendingOutboundCallOf,
  replayedFromOf,
  storedKeyFactsOf,
  type StoredKeyFacts,
} from "../infrastructure/fenced-effect-key.js";
// what a ledger's save refuses and adds, what its prune refuses (#817, #869)
export {
  assertLedgerCutoff,
  assertLedgerEntries,
  expiredEntriesOf,
  unrecordedEntriesOf,
} from "../infrastructure/cost-ledger.repository.js";
// a lease's time left as its store says it (#533)
export { remainingOf } from "../infrastructure/execution-lease.repository.js";
// the class a refusal of minted ids names (#613)
export { idGeneratorNameOf } from "../infrastructure/clock.js";
