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
export * from "./pause-contract-types.js";

// what a database store package does with its schema at start (#891): `@agboss/postgres` and
// `@agboss/mongodb` take it and give it to their applications
export { SchemaSetup } from "./schema-setup.js";

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
// a direct A2A message's claim of its id among the A2A task store's messages (#860)
export {
  DIRECT_MESSAGE_CLAIM,
  directMessageClaimOf,
} from "../infrastructure/in-memory-a2a-direct-message.repository.js";
// the class a refusal of minted ids names (#613)
export { idGeneratorNameOf } from "../infrastructure/clock.js";
// what a store reads of a pause, a log entry or a kept history record, given the parsed JSON it
// holds (#934: 0.1.0 wrote `answeredBy` for who may answer, `answerer` / `responder` for the person):
// every field they read is checked, the record that comes back has the new names, and a value that
// is neither shape throws `StoredNamesUnreadableError`, naming the record's id and the field
export { executionHistoryRecordOfJson } from "../infrastructure/stored-history.js";
export { pauseAnswerRecordOfValue } from "../infrastructure/stored-step.js";
export { pauseRecordOfJson } from "../infrastructure/stored-pause.js";
export { pausedRunOfValue } from "../infrastructure/stored-run.js";
export {
  StoredNamesUnreadableError,
  type StoredNamesUnreadableErrorOptions,
} from "../infrastructure/stored-step.js";

// an optional capability of a checkpoint saver (#962): its newest checkpoint of a thread's
// namespace by `(step, id)` as one indexed read, which a marked thread's latest read uses
export {
  hasLatestByStep,
  NO_STEP,
  stepOf,
  type LatestByStepCheckpointSaver,
} from "../infrastructure/latest-by-step.js";
