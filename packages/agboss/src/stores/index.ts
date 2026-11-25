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

// the one paging shape of every listing (#1324e)
export type { Page, PageQuery } from "../app/page.js";

// the key of one protected write and the fence of the lease it runs under (#1317): made by
// `Idempotency` for an application, by `effectKeyOf` in a store's own tests and tools
export {
  effectKeyOf,
  FingerprintProblem,
  type BusinessKeyOptions,
  type EffectKeyOptions,
  type FingerprintedKeyOptions,
  type FingerprintKeys,
  type OutboundCallKeyOptions,
  type UnfingerprintedKeyOptions,
} from "../infrastructure/fenced-effect-key.js";
export type {
  EffectKey,
  EffectKeyFields,
  EffectKeyMark,
  OutboundCallKey,
  OutboundCallKeyMark,
} from "../infrastructure/effect-key.js";
export type { ExecutionFence } from "../flow/context/execution-fence.js";

// the rows at an outbound-call store's boundary (#505): an intent, its claim, its lease
export { OutboundCallLeaseState } from "../infrastructure/execution-audit-log.repository.js";
export type {
  OutboundCallClaim,
  OutboundCallIntent,
  OutboundCallLease,
  OutboundCallState,
  OutboundCallStatusQuery,
  OutboundCallStep,
} from "../infrastructure/outbound-call.repository.js";
// the in-memory fenced-effect store's transaction (a subclass of it, a test of a store's set)

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
// the cancel as a fence (#909): the tree a key's cancel fences, the refusal a store throws with
// `ExecutionCancelFencedError.of(key)`, and finding it in a cause chain
export { ExecutionCancelFencedError } from "../app/lease-lost.js";
export { cancelFencedErrorOf } from "../app/handed-over.js";
export { cancelTreeOf } from "../infrastructure/issued-keys.js";
// a store call whose outcome is unknown (#928): what a store throws when a command did not answer
export * from "../infrastructure/store-call-timeout.js";
// what a ledger's save refuses and adds, what its prune refuses (#817, #869)
export {
  assertLedgerCutoff,
  assertLedgerEntries,
  expiredEntriesOf,
  unrecordedEntriesOf,
} from "../infrastructure/cost-ledger.repository.js";
// a lease's time left as its store says it (#533)
export { remainingOf } from "../infrastructure/execution-lease.repository.js";

// the cluster's leases (#1321e, D6): what a cluster driver implements, what a database lease store
// mirrors them into, and the composition that orders the two writes
export {
  CLUSTER_LEASE_EXPIRY,
  ClusterExecutionLeaseRepository,
  ClusterLeaseSyncOutcome,
  MirroredLeaseState,
  type ClusterLeaseCoordinator,
  type ClusterLeaseMirror,
  type ClusterLeaseSync,
  type ClusterLeaseTake,
  type MirroredLease,
} from "../infrastructure/cluster-lease.js";
export { InMemoryCluster, type ClusterOutage } from "../infrastructure/in-memory-cluster-lease.js";
export { SqliteClusterMirror } from "../infrastructure/sqlite/sqlite-cluster-mirror.js";
// a direct A2A message's claim of its id among the A2A task store's messages (#860)
export {
  DIRECT_MESSAGE_CLAIM,
  directMessageClaimOf,
} from "../infrastructure/in-memory-a2a-direct-message.repository.js";
// the class a refusal of minted ids names (#613)
export { idGeneratorNameOf } from "../infrastructure/clock.js";
// what a store reads of a pause, a log entry or a kept history record, given the parsed JSON it
// holds (#934): every field they read is checked, only the 0.1.1 shape is read, and any other value
// throws `StoreError.UnreadableRecord`, naming the record's id and the field
export { executionHistoryRecordOfJson } from "../infrastructure/stored-history.js";
export { pauseAnswerRecordOfValue } from "../infrastructure/stored-step.js";
export { pauseRecordOfJson } from "../infrastructure/stored-pause.js";
export { pausedRunOfValue } from "../infrastructure/stored-run.js";
// a stored text that is no JSON is refused the same way (#1121): the coded error, no text in it
export { parsedStoredJson } from "../infrastructure/stored-step.js";

// the step of a checkpoint (#962): the pure functions of the latest-by-step read; the saver
// capability itself holds LangGraph types and stays in `@agboss/core/internal` (#1324)
export {
  compareCodePoints,
  newestFirstOrder,
  NO_STEP,
  stepOf,
} from "../infrastructure/latest-by-step.js";
export { childThreadOf } from "../infrastructure/checkpoint-threads.js";
export {
  StoreError,
  StoreErrorKind,
  type StoreErrorOfKind,
  type StoreErrorStatics,
} from "../core/error-families/store-errors.js";

// the SQLite connection a store of your own extends beside (#1321): bound to `@DatabaseStorage`'s `SqliteDriver`
export { SqliteConnection, SQLITE_HOLD_CAP } from "../infrastructure/sqlite/sqlite-connection.js";
export type {
  SqliteTransactionHandle,
  SqliteTransactionParameters,
  SqliteTransactionRun,
  SqliteTransactionStatement,
} from "../infrastructure/sqlite/sqlite-transaction.js";
// storage drivers (#1321): what `PostgresDriver`, `MongoDriver` and `RedisDriver` are made with, and the
// settings a connection reads once its application started
export {
  defineStorageDriver,
  StorageRole,
  type ClusterDriver,
  type DatabaseDriver,
  type DriverSettings,
  type ObjectDriver,
  type StorageDriver,
  type StorageDriverSpec,
  type StorageMigrate,
  type StorageMigration,
  type StorageMigrationOptions,
} from "../storage/storage-driver.js";
export {
  CLUSTER_SETTINGS,
  DATABASE_SETTINGS,
  DEFAULT_WATCH_LIVENESS,
  OBJECT_SETTINGS,
  type DriverTimeouts,
  type ResolvedSettings,
} from "../storage/settings.js";

// the rules every store keeps the same, from the core (#1324): the status change a write makes, the
// page of a status listing, the pause that takes another's place
export { recordTransitionOf, transitionOf } from "../turns/index.js";
export { statusPageOf } from "../infrastructure/execution-record-status-page.js";
export {
  replacementPause,
  type PauseReplacementInput,
} from "../infrastructure/pause-replacement.js";
