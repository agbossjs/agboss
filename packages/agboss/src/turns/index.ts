/**
 * Public API of the Turns module (run records, threads, scores). Everything outside src/turns
 * imports from here only (lint-enforced); the module depends on nothing else in src.
 */
export { createSqliteTurnStore, sharedTurnStore, type ThreadIds } from "./sqlite-store.js";
/** The Turn database itself (opened and migrated), for stores that share it (paused runs, #201). */
export { openTurnDatabase } from "./schema.js";
export { pauseAnswerEntryOf } from "./writes.js";
export {
  TURN_STATUSES,
  type NewTurn,
  type Turn,
  type TurnStatus,
  type TurnStep,
  type ConfigSnapshot,
  type ConfigStore,
  type MemoryStore,
  type NewSummary,
  type NewThread,
  type Summary,
  type TurnOutcome,
  type TurnStore,
  type PauseAnswerEntry,
  type TurnRecords,
  type VersionScore,
} from "./types.js";
export {
  NonJsonValueError,
  SHORT_VERSION_LENGTH,
  shortVersion,
  stableJson,
  versionOf,
} from "./versions.js";
