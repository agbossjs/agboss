/**
 * Public API of the Terns module (run records, threads, scores). Everything outside src/terns
 * imports from here only (lint-enforced); the module depends on nothing else in src.
 */
export { createSqliteTernStore, type NewThreadId } from "./sqlite-store.js";
/** The Tern database itself (opened and migrated), for stores that share it (paused runs, #201). */
export { openTernDatabase } from "./schema.js";
export {
  TERN_STATUSES,
  type NewTern,
  type Tern,
  type TernStatus,
  type TernStep,
  type ConfigSnapshot,
  type ConfigStore,
  type MemoryStore,
  type NewSummary,
  type Summary,
  type TernOutcome,
  type TernStore,
  type TernRecords,
  type VersionScore,
} from "./types.js";
export {
  NonJsonValueError,
  SHORT_VERSION_LENGTH,
  shortVersion,
  stableJson,
  versionOf,
} from "./versions.js";
